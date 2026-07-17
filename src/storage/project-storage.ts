import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  applyAnnotations,
  buildAnnotationUnits,
  createAnnotationMeta,
  parseVideoDocument,
} from "../domain/annotation";
import type {
  AnnotationRecord,
  ExportResult,
  ProjectSnapshot,
  ProjectTask,
} from "../domain/types";

export interface ProjectStorage {
  openProject(rootPath: string): Promise<ProjectSnapshot>;
  saveProject(snapshot: ProjectSnapshot): Promise<void>;
  exportProject(snapshot: ProjectSnapshot, annotatorId: string): Promise<ExportResult>;
}

interface NativeTask {
  id: string;
  json_path: string;
  video_path: string;
  json_content?: string;
  source_sha256?: string;
  error?: string;
}

interface NativeProject {
  root_path: string;
  name: string;
  tasks: NativeTask[];
  session_json?: string;
}

interface ExportTaskPayload {
  task_id: string;
  json_path: string;
  source_sha256: string;
  corrected_json: string;
  annotation_meta_json: string;
  export_status: "partial" | "complete";
}

function recordsStatus(task: Pick<ProjectTask, "document" | "records" | "drafts" | "error">): ProjectTask["status"] {
  if (task.error || !task.document) return "invalid";
  const total = buildAnnotationUnits(task.document).length;
  const completed = Object.keys(task.records).length;
  if (completed === 0 && Object.keys(task.drafts).length === 0) return "not_started";
  return completed >= total ? "complete" : "in_progress";
}

function mergeSavedState(tasks: ProjectTask[], saved?: ProjectSnapshot): ProjectTask[] {
  return tasks.map((task) => {
    const previous = saved?.tasks.find((candidate) => candidate.id === task.id);
    if (!previous || previous.sourceSha256 !== task.sourceSha256) return task;
    const validUnitIds = new Set(task.document ? buildAnnotationUnits(task.document).map((unit) => unit.id) : []);
    const records = Object.fromEntries(Object.entries(previous.records ?? {}).filter(([unitId, record]) =>
      validUnitIds.has(unitId) && ["true", "false", "question", "other"].includes(record.decision),
    ));
    const drafts = Object.fromEntries(Object.entries(previous.drafts ?? {}).filter(([unitId, draft]) =>
      validUnitIds.has(unitId) && draft.decision === "false",
    ));
    const merged = {
      ...task,
      records,
      drafts,
      videoPosition: previous.videoPosition ?? 0,
    };
    return { ...merged, status: recordsStatus(merged) };
  });
}

function parseNativeTask(task: NativeTask): ProjectTask {
  if (task.error || !task.json_content || !task.source_sha256) {
    return {
      id: task.id,
      jsonPath: task.json_path,
      videoPath: task.video_path,
      videoUrl: task.video_path ? convertFileSrc(task.video_path) : "",
      sourceSha256: task.source_sha256 ?? "",
      error: task.error ?? "任务文件不完整",
      status: "invalid",
      records: {},
      drafts: {},
      videoPosition: 0,
    };
  }
  try {
    const document = parseVideoDocument(task.json_content);
    return {
      id: task.id,
      jsonPath: task.json_path,
      videoPath: task.video_path,
      videoUrl: convertFileSrc(task.video_path),
      sourceSha256: task.source_sha256,
      document,
      status: "not_started",
      records: {},
      drafts: {},
      videoPosition: 0,
    };
  } catch (error) {
    return {
      id: task.id,
      jsonPath: task.json_path,
      videoPath: task.video_path,
      videoUrl: task.video_path ? convertFileSrc(task.video_path) : "",
      sourceSha256: task.source_sha256,
      error: error instanceof Error ? error.message : String(error),
      status: "invalid",
      records: {},
      drafts: {},
      videoPosition: 0,
    };
  }
}

function buildExportPayload(snapshot: ProjectSnapshot, annotatorId: string) {
  const exportedAt = new Date().toISOString();
  const evaluatedTasks = snapshot.tasks.map((task) => ({ task, status: recordsStatus(task) }));
  const validResults = evaluatedTasks
    .filter((entry): entry is { task: ProjectTask & { document: NonNullable<ProjectTask["document"]> }; status: "complete" } =>
      entry.status === "complete" && Boolean(entry.task.document && !entry.task.error))
    .map(({ task }) => {
      const meta = createAnnotationMeta(
        task.id,
        annotatorId,
        task.sourceSha256,
        task.document,
        task.records,
        exportedAt,
      );
      const payload: ExportTaskPayload = {
        task_id: task.id,
        json_path: task.jsonPath,
        source_sha256: task.sourceSha256,
        corrected_json: JSON.stringify(applyAnnotations(task.document, task.records), null, 2),
        annotation_meta_json: JSON.stringify(meta, null, 2),
        export_status: meta.export_status,
      };
      return { task, meta, payload };
    });
  if (validResults.length === 0) throw new Error("当前没有已完成的任务可导出");
  const overallStatus: "partial" | "complete" = validResults.length === snapshot.tasks.length ? "complete" : "partial";
  const taskCounts = {
    total: snapshot.tasks.length,
    exported: validResults.length,
    notStarted: evaluatedTasks.filter(({ status }) => status === "not_started").length,
    inProgress: evaluatedTasks.filter(({ status }) => status === "in_progress").length,
    complete: evaluatedTasks.filter(({ status }) => status === "complete").length,
    invalid: evaluatedTasks.filter(({ status }) => status === "invalid").length,
    skipped: snapshot.tasks.length - validResults.length,
  };
  const aggregate = validResults.reduce(
    (counts, { meta }) => ({
      total: counts.total + meta.counts.total,
      pending: counts.pending + meta.counts.pending,
      true: counts.true + meta.counts.true,
      false: counts.false + meta.counts.false,
      question: counts.question + meta.counts.question,
      other: counts.other + meta.counts.other,
    }),
    { total: 0, pending: 0, true: 0, false: 0, question: 0, other: 0 },
  );
  const manifest = {
    schema_version: "2.2",
    project_name: snapshot.name,
    annotator_id: annotatorId,
    export_status: overallStatus,
    exported_at: exportedAt,
    task_counts: {
      total: taskCounts.total,
      exported: taskCounts.exported,
      not_started: taskCounts.notStarted,
      in_progress: taskCounts.inProgress,
      complete: taskCounts.complete,
      invalid: taskCounts.invalid,
      skipped: taskCounts.skipped,
    },
    annotation_counts: aggregate,
    tasks: evaluatedTasks.map(({ task, status }) => {
      const result = validResults.find((candidate) => candidate.task.id === task.id);
      return result
        ? {
            task_id: task.id,
            task_status: status,
            export_status: result.payload.export_status,
            source_json: task.jsonPath.split(/[\\/]/).pop(),
            source_video: task.videoPath.split(/[\\/]/).pop(),
            corrected_file: `${task.id}.corrected.json`,
            annotation_meta_file: `${task.id}.annotation_meta.json`,
            counts: result.meta.counts,
          }
        : {
            task_id: task.id,
            task_status: status,
            export_status: "skipped",
            source_json: task.jsonPath.split(/[\\/]/).pop() || null,
            source_video: task.videoPath.split(/[\\/]/).pop() || null,
            skipped_reason: status === "not_started"
              ? "任务尚未开始"
              : status === "in_progress"
                ? "任务尚未完成"
                : `任务异常：${task.error ?? "任务无有效数据"}`,
          };
    }),
  };
  return { tasks: validResults.map(({ payload }) => payload), manifest, overallStatus, taskCounts };
}

export class TauriProjectStorage implements ProjectStorage {
  async openProject(rootPath: string): Promise<ProjectSnapshot> {
    const native = await invoke<NativeProject>("open_project", { rootPath });
    const saved = native.session_json ? (JSON.parse(native.session_json) as ProjectSnapshot) : undefined;
    const tasks = mergeSavedState(native.tasks.map(parseNativeTask), saved);
    return {
      rootPath: native.root_path,
      name: native.name,
      tasks,
      activeTaskId: saved?.activeTaskId,
      activeTheme: saved?.activeTheme ?? "overview",
      activeUnitId: saved?.activeUnitId,
      updatedAt: new Date().toISOString(),
    };
  }

  async saveProject(snapshot: ProjectSnapshot): Promise<void> {
    await invoke("save_session", {
      rootPath: snapshot.rootPath,
      sessionJson: JSON.stringify(snapshot),
    });
  }

  async exportProject(snapshot: ProjectSnapshot, annotatorId: string): Promise<ExportResult> {
    const { tasks, manifest, overallStatus, taskCounts } = buildExportPayload(snapshot, annotatorId);
    const outputPath = await invoke<string>("export_project", {
      rootPath: snapshot.rootPath,
      tasks,
      manifestJson: JSON.stringify(manifest, null, 2),
    });
    return { outputPath, status: overallStatus, taskCount: tasks.length, taskCounts };
  }
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const source = new Uint8Array(buffer);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value: string): Promise<string> {
  return sha256(new TextEncoder().encode(value).buffer);
}

function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export class BrowserProjectStorage implements ProjectStorage {
  private files: File[] = [];

  async openProject(): Promise<ProjectSnapshot> {
    throw new Error("浏览器预览请通过文件夹选择器导入项目");
  }

  async openFiles(fileList: FileList): Promise<ProjectSnapshot> {
    this.files = [...fileList];
    const relative = this.files.find((file) => file.webkitRelativePath)?.webkitRelativePath;
    const name = relative?.split("/")[0] || "浏览器预览项目";
    const relativeFiles = this.files.map((file) => {
      const fullPath = file.webkitRelativePath || file.name;
      const parts = fullPath.split("/").filter(Boolean);
      const path = parts[0] === name ? parts.slice(1).join("/") : parts.join("/");
      return { file, path };
    });
    const jsonlFiles = relativeFiles
      .filter(({ file, path }) => !path.includes("/") && /^scenes_.+_final_caption_zh\.jsonl$/.test(file.name))
      .sort((left, right) => left.file.name < right.file.name ? -1 : left.file.name > right.file.name ? 1 : 0);
    if (jsonlFiles.length === 0) {
      throw new Error("项目根目录下未找到 scenes_*_final_caption_zh.jsonl");
    }

    const fileMap = new Map<string, File[]>();
    for (const { file, path } of relativeFiles) {
      fileMap.set(path, [...(fileMap.get(path) ?? []), file]);
    }

    type PendingRow = {
      jsonlName: string;
      sourceSha256: string;
      line: string;
      lineNumber: number;
      videoPath?: string;
      stem?: string;
      error?: string;
    };
    const pendingRows: PendingRow[] = [];
    for (const { file } of jsonlFiles) {
      const buffer = await readFileArrayBuffer(file);
      const sourceSha256 = await sha256(buffer);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        pendingRows.push({
          jsonlName: file.name,
          sourceSha256,
          line: "",
          lineNumber: 1,
          error: `${file.name} 不是有效的 UTF-8 JSONL`,
        });
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        const lineNumber = index + 1;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (!value || Array.isArray(value) || typeof value !== "object") {
            throw new Error("JSONL 记录必须是对象");
          }
          const videoPath = value.video_path;
          if (typeof videoPath !== "string" || !videoPath.trim()) {
            pendingRows.push({
              jsonlName: file.name,
              sourceSha256,
              line,
              lineNumber,
              error: `第 ${lineNumber} 行缺少合法的 video_path`,
            });
            return;
          }
          const segments = videoPath.split("/");
          const stem = segments.at(-1)?.replace(/\.[^.]+$/, "") || `${file.name}.line-${lineNumber}`;
          let error: string | undefined;
          if (videoPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(videoPath) || segments.includes("..")) {
            error = `第 ${lineNumber} 行 video_path 路径越界`;
          } else if (!videoPath.toLowerCase().endsWith(".mp4")) {
            error = `第 ${lineNumber} 行 video_path 必须指向 MP4 文件`;
          }
          pendingRows.push({ jsonlName: file.name, sourceSha256, line, lineNumber, videoPath, stem, error });
        } catch (cause) {
          pendingRows.push({
            jsonlName: file.name,
            sourceSha256,
            line,
            lineNumber,
            error: `第 ${lineNumber} 行不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
      });
    }

    const pathCounts = new Map<string, number>();
    const stemCounts = new Map<string, number>();
    for (const row of pendingRows) {
      if (!row.videoPath || !row.stem) continue;
      pathCounts.set(row.videoPath, (pathCounts.get(row.videoPath) ?? 0) + 1);
      stemCounts.set(row.stem, (stemCounts.get(row.stem) ?? 0) + 1);
    }
    const duplicateIndexes = new Map<string, number>();
    const tasks: ProjectTask[] = [];
    for (const row of pendingRows) {
      let id = row.stem || `${row.jsonlName.replace(/\.jsonl$/, "")}.line-${row.lineNumber}`;
      if (row.videoPath && row.stem && (stemCounts.get(row.stem) ?? 0) > 1) {
        id = `${id}-${(await sha256Text(row.videoPath)).slice(0, 8)}`;
      }
      if (row.videoPath && (pathCounts.get(row.videoPath) ?? 0) > 1) {
        const duplicateIndex = (duplicateIndexes.get(row.videoPath) ?? 0) + 1;
        duplicateIndexes.set(row.videoPath, duplicateIndex);
        id = `${id}-dup${duplicateIndex}`;
      }

      let error = row.error;
      const matches = row.videoPath ? (fileMap.get(row.videoPath) ?? []) : [];
      if (!error && row.videoPath && (pathCounts.get(row.videoPath) ?? 0) > 1) {
        error = `第 ${row.lineNumber} 行存在重复 video_path：${row.videoPath}`;
      } else if (!error && row.videoPath && matches.length === 0) {
        error = `视频不存在：${row.videoPath}`;
      } else if (!error && matches.length > 1) {
        error = `项目中存在重复文件路径：${row.videoPath}`;
      }

      let document: ProjectTask["document"];
      if (!error) {
        try {
          document = parseVideoDocument(row.line);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const video = !error ? matches[0] : undefined;
      tasks.push({
        id,
        jsonPath: row.jsonlName,
        videoPath: row.videoPath ?? "",
        videoUrl: video ? URL.createObjectURL(video) : "",
        sourceSha256: row.sourceSha256,
        document,
        error,
        status: error ? "invalid" : "not_started",
        records: {},
        drafts: {},
        videoPosition: 0,
      });
    }
    const storageKey = `video-annotator:${name}`;
    const savedRaw = localStorage.getItem(storageKey);
    const saved = savedRaw ? (JSON.parse(savedRaw) as ProjectSnapshot) : undefined;
    return {
      rootPath: `browser://${name}`,
      name,
      tasks: mergeSavedState(tasks, saved),
      activeTaskId: saved?.activeTaskId,
      activeTheme: saved?.activeTheme ?? "overview",
      activeUnitId: saved?.activeUnitId,
      updatedAt: new Date().toISOString(),
    };
  }

  async saveProject(snapshot: ProjectSnapshot): Promise<void> {
    const serializable = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => ({ ...task, videoUrl: "", document: task.document })),
    };
    localStorage.setItem(`video-annotator:${snapshot.name}`, JSON.stringify(serializable));
  }

  async exportProject(snapshot: ProjectSnapshot, annotatorId: string): Promise<ExportResult> {
    const { tasks, manifest, overallStatus, taskCounts } = buildExportPayload(snapshot, annotatorId);
    tasks.forEach((task) => {
      download(`${task.task_id}.corrected.json`, task.corrected_json);
      download(`${task.task_id}.annotation_meta.json`, task.annotation_meta_json);
    });
    download("manifest.json", JSON.stringify(manifest, null, 2));
    return { outputPath: "浏览器下载目录", status: overallStatus, taskCount: tasks.length, taskCounts };
  }
}

export function createProjectStorage(): ProjectStorage {
  return isTauri() ? new TauriProjectStorage() : new BrowserProjectStorage();
}

export function updateTaskStatus(task: ProjectTask): ProjectTask {
  return { ...task, status: recordsStatus(task) };
}

export function cloneRecords(records: Record<string, AnnotationRecord>) {
  return { ...records };
}
