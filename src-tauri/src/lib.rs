use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager};

mod media;
mod mpv;

use media::inspect_audio_track_count;

const WORKSPACE_DIR: &str = ".annotation-workspace";
const DATABASE_FILE: &str = "session.sqlite";

#[derive(Debug, Serialize)]
struct NativeTask {
    id: String,
    json_path: String,
    video_path: String,
    json_content: Option<String>,
    source_sha256: Option<String>,
    error: Option<String>,
    media_anomaly: Option<NativeMediaAnomaly>,
}

#[derive(Debug, Serialize)]
struct NativeMediaAnomaly {
    code: String,
    message: String,
    audio_track_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
struct MediaScanProgress {
    current: usize,
    total: usize,
    cache_hits: usize,
}

#[derive(Debug, Serialize)]
struct NativeProject {
    root_path: String,
    name: String,
    tasks: Vec<NativeTask>,
    session_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportTaskPayload {
    task_id: String,
    json_path: String,
    source_sha256: String,
    corrected_json: String,
    annotation_meta_json: String,
    export_status: String,
}

#[derive(Debug)]
struct PendingJsonlRow {
    jsonl_path: PathBuf,
    jsonl_name: String,
    source_sha256: String,
    line: Option<String>,
    line_number: usize,
    video_path: Option<String>,
    stem: Option<String>,
    error: Option<String>,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_caption_jsonl(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            name.starts_with("scenes_")
                && name.ends_with("_final_caption_zh.jsonl")
                && name.len() > "scenes__final_caption_zh.jsonl".len()
        })
}

fn validate_relative_video_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("video_path 不能为空".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("video_path 路径越界".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        return Err("video_path 必须指向 MP4 文件".to_string());
    }
    Ok(path.to_path_buf())
}

fn workspace_path(root: &Path) -> PathBuf {
    root.join(WORKSPACE_DIR)
}

fn database_path(root: &Path) -> PathBuf {
    workspace_path(root).join(DATABASE_FILE)
}

fn open_database(root: &Path) -> Result<Connection, String> {
    let workspace = workspace_path(root);
    fs::create_dir_all(&workspace).map_err(|error| format!("无法创建本地工作区：{error}"))?;
    let connection = Connection::open(database_path(root))
        .map_err(|error| format!("无法打开本地 SQLite：{error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS media_probe_cache (
               video_path TEXT PRIMARY KEY,
               file_size INTEGER NOT NULL,
               modified_ns TEXT NOT NULL,
               audio_track_count INTEGER,
               error_message TEXT,
               updated_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("无法初始化本地 SQLite：{error}"))?;
    Ok(connection)
}

fn load_session(root: &Path) -> Result<Option<String>, String> {
    let database = database_path(root);
    if !database.exists() {
        return Ok(None);
    }
    let connection = open_database(root)?;
    let mut statement = connection
        .prepare("SELECT value FROM app_state WHERE key = 'project_snapshot'")
        .map_err(|error| error.to_string())?;
    let result = statement.query_row([], |row| row.get::<_, String>(0));
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("无法读取本地进度：{error}")),
    }
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "输出路径无父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
    ));
    {
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(content).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    replace_file(&temporary, path)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn inspect_media_cached<F>(
    connection: &Connection,
    relative_path: &str,
    path: &Path,
    inspector: &mut F,
) -> Result<(Result<usize, String>, bool), String>
where
    F: FnMut(&Path) -> Result<usize, String>,
{
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取视频信息：{error}"))?;
    let file_size = i64::try_from(metadata.len()).map_err(|_| "视频文件过大".to_string())?;
    let modified_ns = metadata
        .modified()
        .map_err(|error| format!("无法读取视频修改时间：{error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "视频修改时间早于 Unix 纪元".to_string())?
        .as_nanos()
        .to_string();

    let cached = connection.query_row(
        "SELECT audio_track_count, error_message FROM media_probe_cache
         WHERE video_path = ?1 AND file_size = ?2 AND modified_ns = ?3",
        params![relative_path, file_size, modified_ns],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    );
    match cached {
        Ok((Some(count), None)) => return Ok((Ok(count.max(0) as usize), true)),
        Ok((_, Some(error))) => return Ok((Err(error), true)),
        Ok((None, None)) | Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(error) => return Err(format!("无法读取音轨检测缓存：{error}")),
    }

    let result = inspector(path);
    let (count, error) = match &result {
        Ok(count) => (Some(*count as i64), None),
        Err(error) => (None, Some(error.as_str())),
    };
    connection
        .execute(
            "INSERT INTO media_probe_cache
             (video_path, file_size, modified_ns, audio_track_count, error_message, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(video_path) DO UPDATE SET
               file_size = excluded.file_size,
               modified_ns = excluded.modified_ns,
               audio_track_count = excluded.audio_track_count,
               error_message = excluded.error_message,
               updated_at = excluded.updated_at",
            params![
                relative_path,
                file_size,
                modified_ns,
                count,
                error,
                Local::now().to_rfc3339()
            ],
        )
        .map_err(|error| format!("无法保存音轨检测缓存：{error}"))?;
    Ok((result, false))
}

fn open_project_from_path_with_inspector<F, P>(
    root_path: String,
    inspector: &mut F,
    mut on_progress: P,
) -> Result<NativeProject, String>
where
    F: FnMut(&Path) -> Result<usize, String>,
    P: FnMut(MediaScanProgress),
{
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("所选路径不是有效文件夹".to_string());
    }
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let entries = fs::read_dir(&canonical).map_err(|error| format!("无法读取项目目录：{error}"))?;
    let mut jsonl_files = Vec::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() && is_caption_jsonl(&path) {
            jsonl_files.push(path);
        }
    }
    jsonl_files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    if jsonl_files.is_empty() {
        return Err("项目根目录下未找到 scenes_*_final_caption_zh.jsonl".to_string());
    }

    let mut rows = Vec::new();
    for jsonl_path in jsonl_files {
        let jsonl_name = jsonl_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("JSONL 文件名不是有效 UTF-8：{}", path_string(&jsonl_path)))?
            .to_string();
        let bytes =
            fs::read(&jsonl_path).map_err(|error| format!("无法读取 {jsonl_name}：{error}"))?;
        let source_sha256 = sha256(&bytes);
        let content = match std::str::from_utf8(&bytes) {
            Ok(content) => content,
            Err(_) => {
                rows.push(PendingJsonlRow {
                    jsonl_path: jsonl_path.clone(),
                    jsonl_name: jsonl_name.clone(),
                    source_sha256,
                    line: None,
                    line_number: 1,
                    video_path: None,
                    stem: None,
                    error: Some(format!("{jsonl_name} 不是有效的 UTF-8 JSONL")),
                });
                continue;
            }
        };

        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let line_number = index + 1;
            let mut row = PendingJsonlRow {
                jsonl_path: jsonl_path.clone(),
                jsonl_name: jsonl_name.clone(),
                source_sha256: source_sha256.clone(),
                line: Some(line.to_string()),
                line_number,
                video_path: None,
                stem: None,
                error: None,
            };
            match serde_json::from_str::<serde_json::Value>(line) {
                Ok(serde_json::Value::Object(object)) => match object.get("video_path") {
                    Some(serde_json::Value::String(video_path))
                        if !video_path.trim().is_empty() =>
                    {
                        row.video_path = Some(video_path.clone());
                        row.stem = Path::new(video_path)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .map(str::to_string);
                        if let Err(error) = validate_relative_video_path(video_path) {
                            row.error = Some(format!("第 {line_number} 行 {error}"));
                        }
                    }
                    _ => {
                        row.error = Some(format!("第 {line_number} 行缺少合法的 video_path"));
                    }
                },
                Ok(_) => {
                    row.error = Some(format!("第 {line_number} 行 JSONL 记录必须是对象"));
                }
                Err(error) => {
                    row.error = Some(format!("第 {line_number} 行不是有效 JSON：{error}"));
                }
            }
            rows.push(row);
        }
    }

    let mut path_counts: HashMap<String, usize> = HashMap::new();
    let mut stem_counts: HashMap<String, usize> = HashMap::new();
    for row in &rows {
        if let Some(video_path) = &row.video_path {
            *path_counts.entry(video_path.clone()).or_default() += 1;
        }
        if let Some(stem) = &row.stem {
            *stem_counts.entry(stem.clone()).or_default() += 1;
        }
    }

    let connection = open_database(&canonical)?;
    let total = rows.len();
    let mut cache_hits = 0;
    let mut duplicate_indexes: HashMap<String, usize> = HashMap::new();
    let mut tasks = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let fallback_id = format!(
            "{}.line-{}",
            row.jsonl_name.trim_end_matches(".jsonl"),
            row.line_number
        );
        let mut id = row.stem.clone().unwrap_or(fallback_id);
        if let (Some(stem), Some(video_path)) = (&row.stem, &row.video_path) {
            if stem_counts.get(stem).copied().unwrap_or(0) > 1 {
                id = format!("{id}-{}", &sha256(video_path.as_bytes())[..8]);
            }
            if path_counts.get(video_path).copied().unwrap_or(0) > 1 {
                let index = duplicate_indexes.entry(video_path.clone()).or_default();
                *index += 1;
                id = format!("{id}-dup{index}");
            }
        }

        let mut error = row.error;
        let mut resolved_video = PathBuf::new();
        if let Some(video_path) = &row.video_path {
            if error.is_none() && path_counts.get(video_path).copied().unwrap_or(0) > 1 {
                error = Some(format!(
                    "第 {} 行存在重复 video_path：{video_path}",
                    row.line_number
                ));
            }
            if let Ok(relative_path) = validate_relative_video_path(video_path) {
                resolved_video = canonical.join(relative_path);
                if error.is_none() && !resolved_video.exists() {
                    error = Some(format!("视频不存在：{video_path}"));
                } else if error.is_none() && !resolved_video.is_file() {
                    error = Some(format!("video_path 不是文件：{video_path}"));
                } else if error.is_none() {
                    match resolved_video.canonicalize() {
                        Ok(video_canonical) if video_canonical.starts_with(&canonical) => {
                            resolved_video = video_canonical;
                        }
                        Ok(_) => error = Some(format!("video_path 路径越界：{video_path}")),
                        Err(read_error) => {
                            error = Some(format!("无法访问视频 {video_path}：{read_error}"));
                        }
                    }
                }
            }
        }

        let mut media_anomaly = None;
        if error.is_none() {
            if let Some(relative_video_path) = &row.video_path {
                let (inspection, cache_hit) = match inspect_media_cached(
                    &connection,
                    relative_video_path,
                    &resolved_video,
                    inspector,
                ) {
                    Ok(result) => result,
                    Err(message) => (Err(message), false),
                };
                if cache_hit {
                    cache_hits += 1;
                }
                media_anomaly = match inspection {
                    Ok(count) if count > 1 => Some(NativeMediaAnomaly {
                        code: "multiple_audio_tracks".to_string(),
                        message: format!("多音轨视频（检测到 {count} 条音频轨道）"),
                        audio_track_count: Some(count),
                    }),
                    Ok(_) => None,
                    Err(message) => Some(NativeMediaAnomaly {
                        code: "audio_track_detection_failed".to_string(),
                        message: format!("音轨检测失败：{message}"),
                        audio_track_count: None,
                    }),
                };
            }
        }

        tasks.push(NativeTask {
            id,
            json_path: path_string(&row.jsonl_path),
            video_path: path_string(&resolved_video),
            json_content: row.line,
            source_sha256: Some(row.source_sha256),
            error,
            media_anomaly,
        });
        on_progress(MediaScanProgress {
            current: index + 1,
            total,
            cache_hits,
        });
    }

    Ok(NativeProject {
        root_path: path_string(&canonical),
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("离线标注项目")
            .to_string(),
        tasks,
        session_json: load_session(&canonical)?,
    })
}

#[cfg(test)]
fn open_project_from_path(root_path: String) -> Result<NativeProject, String> {
    open_project_from_path_with_inspector(root_path, &mut inspect_audio_track_count, |_| {})
}

#[tauri::command]
async fn open_project(app: tauri::AppHandle, root_path: String) -> Result<NativeProject, String> {
    let progress_app = app.clone();
    let project = tauri::async_runtime::spawn_blocking(move || {
        open_project_from_path_with_inspector(
            root_path,
            &mut inspect_audio_track_count,
            move |progress| {
                let _ = progress_app.emit("media-scan-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| format!("音轨检测任务意外终止：{error}"))??;
    app.asset_protocol_scope()
        .allow_directory(PathBuf::from(&project.root_path), true)
        .map_err(|error| format!("无法授权访问项目视频目录：{error}"))?;
    Ok(project)
}

#[tauri::command]
fn save_session(root_path: String, session_json: String) -> Result<(), String> {
    let root = PathBuf::from(root_path);
    let mut connection = open_database(&root)?;
    let old_session = load_session(&root)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始保存事务：{error}"))?;
    transaction
        .execute(
            "INSERT INTO app_state (key, value, updated_at) VALUES ('project_snapshot', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![session_json, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("无法保存进度：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交保存事务：{error}"))?;

    if let Some(previous) = old_session {
        let backup = workspace_path(&root)
            .join("backups")
            .join("session-latest.json");
        atomic_write(&backup, previous.as_bytes())?;
    }
    Ok(())
}

#[tauri::command]
fn export_project(
    root_path: String,
    tasks: Vec<ExportTaskPayload>,
    manifest_json: String,
) -> Result<String, String> {
    let root = PathBuf::from(root_path);
    let mut source_hashes: HashMap<PathBuf, String> = HashMap::new();
    for task in &tasks {
        let source = PathBuf::from(&task.json_path);
        let actual_hash = if let Some(hash) = source_hashes.get(&source) {
            hash.clone()
        } else {
            let bytes = fs::read(&source)
                .map_err(|error| format!("无法重新读取 {}：{error}", path_string(&source)))?;
            let hash = sha256(&bytes);
            source_hashes.insert(source.clone(), hash.clone());
            hash
        };
        if actual_hash != task.source_sha256 {
            return Err(format!(
                "任务 {} 的源 JSONL 已被外部修改，已停止导出",
                task.task_id
            ));
        }
        if task.export_status != "partial" && task.export_status != "complete" {
            return Err(format!("任务 {} 的导出状态无效", task.task_id));
        }
    }

    let exports = root.join("exports");
    fs::create_dir_all(&exports).map_err(|error| format!("无法创建 exports：{error}"))?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let destination = exports.join(&timestamp);
    let temporary = exports.join(format!(".{timestamp}.tmp"));
    if temporary.exists() {
        fs::remove_dir_all(&temporary).map_err(|error| error.to_string())?;
    }
    fs::create_dir(&temporary).map_err(|error| format!("无法创建临时导出目录：{error}"))?;

    let write_result = (|| -> Result<(), String> {
        for task in &tasks {
            atomic_write(
                &temporary.join(format!("{}.corrected.json", task.task_id)),
                task.corrected_json.as_bytes(),
            )?;
            atomic_write(
                &temporary.join(format!("{}.annotation_meta.json", task.task_id)),
                task.annotation_meta_json.as_bytes(),
            )?;
        }
        atomic_write(&temporary.join("manifest.json"), manifest_json.as_bytes())?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!("导出失败：{error}"));
    }
    fs::rename(&temporary, &destination).map_err(|error| {
        let _ = fs::remove_dir_all(&temporary);
        format!("无法完成原子导出：{error}")
    })?;
    Ok(path_string(&destination))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(mpv::MpvManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            save_session,
            export_project,
            mpv::mpv_probe,
            mpv::mpv_create,
            mpv::mpv_load,
            mpv::mpv_set_bounds,
            mpv::mpv_state,
            mpv::mpv_play,
            mpv::mpv_pause,
            mpv::mpv_seek,
            mpv::mpv_set_volume,
            mpv::mpv_set_muted,
            mpv::mpv_destroy
        ])
        .run(tauri::generate_context!())
        .expect("failed to run video annotation application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestProject(PathBuf);

    impl TestProject {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "offline-video-annotator-{name}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test project");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, content: &[u8]) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(path, content).expect("write fixture");
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let project = TestProject::new("atomic-overwrite");
        let destination = project.path().join("nested/session-latest.json");

        atomic_write(&destination, b"first").expect("first atomic write");
        atomic_write(&destination, b"second").expect("replace atomic write");

        assert_eq!(
            fs::read(destination).expect("read replaced file"),
            b"second"
        );
    }

    #[test]
    fn imports_jsonl_rows_in_file_and_line_order_with_exact_video_paths() {
        let project = TestProject::new("ordered");
        project.write(
            "scenes_z_final_caption_zh.jsonl",
            br#"{"video_path":"z/second.mp4"}"#,
        );
        project.write(
            "scenes_a_final_caption_zh.jsonl",
            b"{\"video_path\":\"a/first.mp4\"}\n{bad-json\n{\"video_path\":\"a/missing.mp4\"}",
        );
        project.write("a/first.mp4", b"first");
        project.write("z/second.mp4", b"second");

        let opened = open_project_from_path(path_string(project.path())).expect("open project");

        assert_eq!(
            opened
                .tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "first",
                "scenes_a_final_caption_zh.line-2",
                "missing",
                "second"
            ]
        );
        assert!(opened.tasks[0].error.is_none());
        assert!(opened.tasks[1]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("第 2 行不是有效 JSON")));
        assert!(opened.tasks[2]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("视频不存在")));
        assert_eq!(
            opened.tasks[3].json_content.as_deref(),
            Some(r#"{"video_path":"z/second.mp4"}"#)
        );
    }

    #[test]
    fn marks_duplicate_paths_and_suffixes_colliding_stems() {
        let project = TestProject::new("duplicates");
        project.write(
            "scenes_batch_final_caption_zh.jsonl",
            b"{\"video_path\":\"one/shared.mp4\"}\n{\"video_path\":\"two/shared.mp4\"}\n{\"video_path\":\"dup/repeated.mp4\"}\n{\"video_path\":\"dup/repeated.mp4\"}",
        );
        project.write("one/shared.mp4", b"one");
        project.write("two/shared.mp4", b"two");
        project.write("dup/repeated.mp4", b"duplicate");

        let opened = open_project_from_path(path_string(project.path())).expect("open project");

        assert!(opened.tasks[0].id.starts_with("shared-"));
        assert!(opened.tasks[1].id.starts_with("shared-"));
        assert_ne!(opened.tasks[0].id, opened.tasks[1].id);
        assert!(opened.tasks[2].id.ends_with("-dup1"));
        assert!(opened.tasks[3].id.ends_with("-dup2"));
        assert!(opened.tasks[2]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("重复 video_path")));
        assert!(opened.tasks[3]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("重复 video_path")));
    }

    #[test]
    fn rejects_missing_jsonl_and_out_of_root_video_paths() {
        let empty_project = TestProject::new("empty");
        assert!(open_project_from_path(path_string(empty_project.path()))
            .expect_err("missing JSONL should fail")
            .contains("根目录下未找到"));

        let project = TestProject::new("unsafe");
        project.write(
            "scenes_batch_final_caption_zh.jsonl",
            br#"{"video_path":"../outside.mp4"}"#,
        );
        let opened =
            open_project_from_path(path_string(project.path())).expect("open unsafe project");
        assert!(opened.tasks[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("路径越界")));
    }

    fn mp4_box(name: &[u8; 4], content: Vec<u8>) -> Vec<u8> {
        let mut result = Vec::with_capacity(content.len() + 8);
        result.extend_from_slice(&((content.len() + 8) as u32).to_be_bytes());
        result.extend_from_slice(name);
        result.extend_from_slice(&content);
        result
    }

    fn synthetic_mp4(audio_tracks: usize) -> Vec<u8> {
        let mut moov = Vec::new();
        for _ in 0..audio_tracks {
            let mut handler = vec![0; 8];
            handler.extend_from_slice(b"soun");
            handler.extend_from_slice(&[0; 13]);
            let mdia = mp4_box(b"mdia", mp4_box(b"hdlr", handler));
            moov.extend_from_slice(&mp4_box(b"trak", mdia));
        }
        mp4_box(b"moov", moov)
    }

    #[test]
    fn counts_zero_one_and_multiple_audio_tracks_from_mp4_metadata() {
        let project = TestProject::new("audio-count");
        for count in 0..=3 {
            let relative = format!("{count}.mp4");
            project.write(&relative, &synthetic_mp4(count));
            assert_eq!(
                inspect_audio_track_count(&project.path().join(relative)).expect("inspect MP4"),
                count
            );
        }
    }

    #[test]
    fn locates_moov_metadata_after_a_large_media_data_box() {
        let project = TestProject::new("moov-after-mdat");
        let mut content = mp4_box(b"mdat", vec![0; 1024 * 1024]);
        content.extend_from_slice(&synthetic_mp4(2));
        project.write("late-moov.mp4", &content);

        assert_eq!(
            inspect_audio_track_count(&project.path().join("late-moov.mp4")).expect("inspect MP4"),
            2
        );
    }

    #[test]
    fn marks_multiple_tracks_and_probe_failures_as_media_anomalies() {
        let project = TestProject::new("audio-anomaly");
        project.write(
            "scenes_batch_final_caption_zh.jsonl",
            b"{\"video_path\":\"clips/multi.mp4\"}\n{\"video_path\":\"clips/broken.mp4\"}",
        );
        project.write("clips/multi.mp4", &synthetic_mp4(2));
        project.write("clips/broken.mp4", b"not-an-mp4");

        let opened = open_project_from_path(path_string(project.path())).expect("open project");

        assert!(opened.tasks[0].error.is_none());
        assert_eq!(
            opened.tasks[0]
                .media_anomaly
                .as_ref()
                .map(|value| value.code.as_str()),
            Some("multiple_audio_tracks")
        );
        assert_eq!(
            opened.tasks[0]
                .media_anomaly
                .as_ref()
                .and_then(|value| value.audio_track_count),
            Some(2)
        );
        assert_eq!(
            opened.tasks[1]
                .media_anomaly
                .as_ref()
                .map(|value| value.code.as_str()),
            Some("audio_track_detection_failed")
        );
    }

    #[test]
    fn reuses_cached_audio_track_results_until_the_video_changes() {
        let project = TestProject::new("audio-cache");
        project.write(
            "scenes_batch_final_caption_zh.jsonl",
            br#"{"video_path":"clips/clip.mp4"}"#,
        );
        project.write("clips/clip.mp4", &synthetic_mp4(1));
        let mut inspections = 0;

        open_project_from_path_with_inspector(
            path_string(project.path()),
            &mut |_| {
                inspections += 1;
                Ok(1)
            },
            |_| {},
        )
        .expect("first open");
        open_project_from_path_with_inspector(
            path_string(project.path()),
            &mut |_| {
                inspections += 1;
                Ok(1)
            },
            |_| {},
        )
        .expect("cached open");
        assert_eq!(inspections, 1);

        project.write("clips/clip.mp4", &synthetic_mp4(2));
        open_project_from_path_with_inspector(
            path_string(project.path()),
            &mut |_| {
                inspections += 1;
                Ok(2)
            },
            |_| {},
        )
        .expect("changed open");
        assert_eq!(inspections, 2);
    }

    #[test]
    fn reports_audio_scan_progress_for_every_imported_row() {
        let project = TestProject::new("audio-progress");
        project.write(
            "scenes_batch_final_caption_zh.jsonl",
            b"{\"video_path\":\"clips/one.mp4\"}\n{\"video_path\":\"clips/two.mp4\"}",
        );
        project.write("clips/one.mp4", &synthetic_mp4(1));
        project.write("clips/two.mp4", &synthetic_mp4(1));
        let mut progress = Vec::new();

        open_project_from_path_with_inspector(
            path_string(project.path()),
            &mut |_| Ok(1),
            |update| progress.push((update.current, update.total)),
        )
        .expect("open project");

        assert_eq!(progress, vec![(1, 2), (2, 2)]);
    }
}
