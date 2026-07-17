use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MpvBounds {
    fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| !value.is_finite())
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("libmpv 视频区域无效".to_string());
        }
        Ok(self)
    }
}

#[derive(Serialize)]
pub struct MpvCapability {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvPlaybackState {
    ready: bool,
    duration: f64,
    current_time: f64,
    paused: bool,
    volume: f64,
    muted: bool,
    ended: bool,
    has_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};
    use tauri::WebviewWindow;

    #[repr(C)]
    struct NativeBounds {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    impl From<MpvBounds> for NativeBounds {
        fn from(value: MpvBounds) -> Self {
            Self {
                x: value.x,
                y: value.y,
                width: value.width,
                height: value.height,
            }
        }
    }

    #[repr(C)]
    struct NativeState {
        ready: bool,
        duration: f64,
        current_time: f64,
        paused: bool,
        volume: f64,
        muted: bool,
        ended: bool,
        has_audio: bool,
        error: [c_char; 512],
    }

    unsafe extern "C" {
        fn ova_mpv_probe(error: *mut c_char, error_size: usize) -> bool;
        fn ova_mpv_create(
            parent_view: *mut c_void,
            bounds: NativeBounds,
            error: *mut c_char,
            error_size: usize,
        ) -> *mut c_void;
        fn ova_mpv_load(
            player: *mut c_void,
            path: *const c_char,
            initial_position: f64,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_set_bounds(
            player: *mut c_void,
            bounds: NativeBounds,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_get_state(
            player: *mut c_void,
            state: *mut NativeState,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_play(player: *mut c_void, error: *mut c_char, error_size: usize) -> bool;
        fn ova_mpv_pause(player: *mut c_void, error: *mut c_char, error_size: usize) -> bool;
        fn ova_mpv_seek(
            player: *mut c_void,
            position: f64,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_set_volume(
            player: *mut c_void,
            volume: f64,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_set_muted(
            player: *mut c_void,
            muted: bool,
            error: *mut c_char,
            error_size: usize,
        ) -> bool;
        fn ova_mpv_destroy(player: *mut c_void);
    }

    struct Player(*mut c_void);
    unsafe impl Send for Player {}

    #[derive(Default)]
    pub struct MpvManager(Mutex<Option<Player>>);

    impl Drop for MpvManager {
        fn drop(&mut self) {
            if let Ok(player) = self.0.get_mut() {
                if let Some(player) = player.take() {
                    unsafe { ova_mpv_destroy(player.0) };
                }
            }
        }
    }

    fn error_buffer() -> [c_char; 768] {
        [0; 768]
    }

    fn error_text(buffer: &[c_char]) -> String {
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    fn with_player<T>(
        manager: &tauri::State<'_, MpvManager>,
        operation: impl FnOnce(*mut c_void, *mut c_char, usize) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = manager
            .0
            .lock()
            .map_err(|_| "libmpv 状态锁已损坏".to_string())?;
        let player = guard
            .as_ref()
            .ok_or_else(|| "libmpv 未初始化".to_string())?;
        let mut error = error_buffer();
        operation(player.0, error.as_mut_ptr(), error.len()).map_err(|fallback| {
            let detail = error_text(&error);
            if detail.is_empty() {
                fallback
            } else {
                detail
            }
        })
    }

    #[tauri::command]
    pub fn mpv_probe() -> MpvCapability {
        let mut error = error_buffer();
        let available = unsafe { ova_mpv_probe(error.as_mut_ptr(), error.len()) };
        MpvCapability {
            available,
            error: (!available).then(|| error_text(&error)),
        }
    }

    #[tauri::command]
    pub fn mpv_create(
        window: WebviewWindow,
        manager: tauri::State<'_, MpvManager>,
        bounds: MpvBounds,
    ) -> Result<(), String> {
        let bounds = bounds.validate()?;
        let parent = window.ns_view().map_err(|error| error.to_string())?;
        let mut error = error_buffer();
        let player =
            unsafe { ova_mpv_create(parent, bounds.into(), error.as_mut_ptr(), error.len()) };
        if player.is_null() {
            return Err(error_text(&error));
        }
        let mut guard = manager
            .0
            .lock()
            .map_err(|_| "libmpv 状态锁已损坏".to_string())?;
        if let Some(previous) = guard.replace(Player(player)) {
            unsafe { ova_mpv_destroy(previous.0) };
        }
        Ok(())
    }

    #[tauri::command]
    pub fn mpv_load(
        manager: tauri::State<'_, MpvManager>,
        path: String,
        initial_position: f64,
    ) -> Result<(), String> {
        let canonical =
            std::fs::canonicalize(&path).map_err(|error| format!("无法访问视频：{error}"))?;
        let path = CString::new(canonical.to_string_lossy().as_bytes())
            .map_err(|_| "视频路径包含无效字符".to_string())?;
        with_player(&manager, |player, error, size| {
            unsafe {
                ova_mpv_load(
                    player,
                    path.as_ptr(),
                    initial_position.max(0.0),
                    error,
                    size,
                )
            }
            .then_some(())
            .ok_or_else(|| "libmpv 无法加载视频".to_string())
        })
    }

    #[tauri::command]
    pub fn mpv_set_bounds(
        manager: tauri::State<'_, MpvManager>,
        bounds: MpvBounds,
    ) -> Result<(), String> {
        let bounds = bounds.validate()?;
        with_player(&manager, |player, error, size| {
            unsafe { ova_mpv_set_bounds(player, bounds.into(), error, size) }
                .then_some(())
                .ok_or_else(|| "libmpv 无法更新画面位置".to_string())
        })
    }

    #[tauri::command]
    pub fn mpv_state(manager: tauri::State<'_, MpvManager>) -> Result<MpvPlaybackState, String> {
        with_player(&manager, |player, error, size| {
            let mut native = NativeState {
                ready: false,
                duration: 0.0,
                current_time: 0.0,
                paused: true,
                volume: 100.0,
                muted: false,
                ended: false,
                has_audio: false,
                error: [0; 512],
            };
            if !unsafe { ova_mpv_get_state(player, &mut native, error, size) } {
                return Err("libmpv 无法读取播放状态".to_string());
            }
            let state_error = error_text(&native.error);
            Ok(MpvPlaybackState {
                ready: native.ready,
                duration: native.duration.max(0.0),
                current_time: native.current_time.max(0.0),
                paused: native.paused,
                volume: native.volume.clamp(0.0, 100.0),
                muted: native.muted,
                ended: native.ended,
                has_audio: native.has_audio,
                error: (!state_error.is_empty()).then_some(state_error),
            })
        })
    }

    macro_rules! simple_command {
        ($name:ident, $ffi:ident, $fallback:literal) => {
            #[tauri::command]
            pub fn $name(manager: tauri::State<'_, MpvManager>) -> Result<(), String> {
                with_player(&manager, |player, error, size| {
                    unsafe { $ffi(player, error, size) }
                        .then_some(())
                        .ok_or_else(|| $fallback.to_string())
                })
            }
        };
    }
    simple_command!(mpv_play, ova_mpv_play, "libmpv 无法播放");
    simple_command!(mpv_pause, ova_mpv_pause, "libmpv 无法暂停");

    #[tauri::command]
    pub fn mpv_seek(manager: tauri::State<'_, MpvManager>, position: f64) -> Result<(), String> {
        if !position.is_finite() {
            return Err("视频位置无效".to_string());
        }
        with_player(&manager, |player, error, size| {
            unsafe { ova_mpv_seek(player, position.max(0.0), error, size) }
                .then_some(())
                .ok_or_else(|| "libmpv 无法定位视频".to_string())
        })
    }

    #[tauri::command]
    pub fn mpv_set_volume(
        manager: tauri::State<'_, MpvManager>,
        volume: f64,
    ) -> Result<(), String> {
        if !volume.is_finite() {
            return Err("音量无效".to_string());
        }
        with_player(&manager, |player, error, size| {
            unsafe { ova_mpv_set_volume(player, volume.clamp(0.0, 100.0), error, size) }
                .then_some(())
                .ok_or_else(|| "libmpv 无法设置音量".to_string())
        })
    }

    #[tauri::command]
    pub fn mpv_set_muted(manager: tauri::State<'_, MpvManager>, muted: bool) -> Result<(), String> {
        with_player(&manager, |player, error, size| {
            unsafe { ova_mpv_set_muted(player, muted, error, size) }
                .then_some(())
                .ok_or_else(|| "libmpv 无法设置静音".to_string())
        })
    }

    #[tauri::command]
    pub fn mpv_destroy(manager: tauri::State<'_, MpvManager>) -> Result<(), String> {
        let mut guard = manager
            .0
            .lock()
            .map_err(|_| "libmpv 状态锁已损坏".to_string())?;
        if let Some(player) = guard.take() {
            unsafe { ova_mpv_destroy(player.0) };
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    #[derive(Default)]
    pub struct MpvManager;

    #[tauri::command]
    pub fn mpv_probe() -> MpvCapability {
        MpvCapability {
            available: false,
            error: None,
        }
    }

    macro_rules! unavailable {
        ($($name:ident $(($($argument:ident: $type:ty),*))?),* $(,)?) => {$ (
            #[tauri::command]
            pub fn $name($($($argument: $type),*)?) -> Result<(), String> {
                $(let _ = ($($argument),*);)?
                Err("libmpv 仅在 macOS 版本中启用".to_string())
            }
        )*};
    }
    unavailable!(
        mpv_create(bounds: MpvBounds),
        mpv_load(path: String, initial_position: f64),
        mpv_set_bounds(bounds: MpvBounds),
        mpv_play,
        mpv_pause,
        mpv_seek(position: f64),
        mpv_set_volume(volume: f64),
        mpv_set_muted(muted: bool),
        mpv_destroy,
    );

    #[tauri::command]
    pub fn mpv_state() -> Result<MpvPlaybackState, String> {
        Err("libmpv 仅在 macOS 版本中启用".to_string())
    }
}

pub use platform::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_finite_or_empty_native_view_bounds() {
        for bounds in [
            MpvBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 100.0,
            },
            MpvBounds {
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        ] {
            assert!(bounds.validate().is_err());
        }
        assert!(MpvBounds {
            x: 10.0,
            y: 20.0,
            width: 640.0,
            height: 360.0
        }
        .validate()
        .is_ok());
    }
}
