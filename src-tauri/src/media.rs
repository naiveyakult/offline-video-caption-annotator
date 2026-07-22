use mp4parse::TrackType;
use std::{
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom},
    path::Path,
};

const BOX_HEADER_SIZE: u64 = 8;
const MAX_MOOV_SIZE: u64 = 128 * 1024 * 1024;

pub(crate) fn inspect_audio_track_count(path: &Path) -> Result<usize, String> {
    let moov = read_moov_box(path)?;
    let mut cursor = Cursor::new(moov);
    let context =
        mp4parse::read_mp4(&mut cursor).map_err(|error| format!("MP4 容器无法解析：{error:?}"))?;
    Ok(context
        .tracks
        .iter()
        .filter(|track| track.track_type == TrackType::Audio)
        .count())
}

fn read_moov_box(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取视频：{error}"))?;
    let file_size = file
        .metadata()
        .map_err(|error| format!("无法读取视频信息：{error}"))?
        .len();
    let mut offset = 0u64;

    while offset.saturating_add(BOX_HEADER_SIZE) <= file_size {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("无法定位 MP4 元数据：{error}"))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|error| format!("MP4 顶层数据不完整：{error}"))?;
        let size32 = u32::from_be_bytes(header[..4].try_into().expect("four bytes"));
        let name = &header[4..8];
        let (box_size, header_size) = match size32 {
            0 => (file_size - offset, BOX_HEADER_SIZE),
            1 => {
                let mut extended = [0u8; 8];
                file.read_exact(&mut extended)
                    .map_err(|error| format!("MP4 扩展盒头不完整：{error}"))?;
                (u64::from_be_bytes(extended), 16)
            }
            value => (u64::from(value), BOX_HEADER_SIZE),
        };
        if box_size < header_size || offset.saturating_add(box_size) > file_size {
            return Err(format!("MP4 盒子尺寸非法（偏移 {offset}）"));
        }
        if name == b"moov" {
            if box_size > MAX_MOOV_SIZE {
                return Err(format!("MP4 元数据过大（{box_size} 字节）"));
            }
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| format!("无法定位 moov 元数据：{error}"))?;
            let mut bytes = vec![0; box_size as usize];
            file.read_exact(&mut bytes)
                .map_err(|error| format!("moov 元数据不完整：{error}"))?;
            return Ok(bytes);
        }
        offset = offset
            .checked_add(box_size)
            .ok_or_else(|| "MP4 盒子偏移溢出".to_string())?;
    }

    Err("MP4 中未找到 moov 元数据".to_string())
}
