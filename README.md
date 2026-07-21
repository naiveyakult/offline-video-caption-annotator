# 视频剧情标注

完全离线的视频剧情文本标注桌面工具，支持 macOS 13+ 和 Windows 10/11 x64。应用逐行读取 UTF-8 JSONL，按每条记录的相对 `video_path` 精确加载 MP4，对 `caption_en` 中的 Overview、Storyline、Speech Transcript 进行标注，并在英文下方显示只读的 `caption_zh` 参考。

## 功能

- 左侧播放原视频，支持自由拖动时间轴和从头重播完整视频；点击带时间的标注卡片只定位到起始时间，不自动播放片段。
- 使用互斥的 `True / False / Question / Other` 判定；False 修订英文，Question 标记受分段或时间限制而无法合理修订的匹配问题，中文仅供对照。
- 标注正文和 False 编辑框支持 12px / 14px / 16px 三档字号，并在本机记住选择。
- Visible Text 不参与标注，导出时保持原样。
- SQLite 自动保存任务、草稿、当前单元和视频位置，异常退出后可恢复。
- 原始 MP4 和 JSONL 永不修改，支持部分或完整导出。
- 仅为全部单元已完成判定的任务生成结果文件；未开始、进行中和异常任务只保留在 manifest 状态清单中。
- 打开项目时自动检测 MP4 音轨；多音轨视频及音轨检测失败的任务标记为异常，不进入标注或导出。
- v0.5.0 保留原有深绿色简洁风格，桌面图标内部改为双音轨波形，用于和旧版播放三角图标区分。
- 全程离线，不依赖服务器、Docker 或中心数据库。

## 项目目录

```text
annotation-project/
├── scenes_batch_final_caption_zh.jsonl
└── media-batch/
    └── video_clips/
        └── clip-group/
            └── clip-001.mp4
```

选择共同父目录 `annotation-project/`。应用读取根层级一个或多个 `scenes_*_final_caption_zh.jsonl`，并以每行 `video_path` 指向的项目内相对路径作为唯一匹配依据。不会按文件名猜测或递归配对。

应用在所选项目下创建：

```text
.annotation-workspace/session.sqlite
exports/<timestamp>/
```

音轨检测结果同样缓存在 `session.sqlite` 中，并按视频路径、大小和修改时间自动失效。多音轨任务会保留已有判定和草稿；视频替换为单音轨后，重新打开项目即可继续原进度。

每个 JSONL 非空行必须是独立 JSON 对象，包含字符串 `video_path`、`caption_en` 和 `caption_zh`。Caption 必须使用应用支持的四个固定中英章节标题与字段映射。

## Windows 免安装版

从 GitHub Actions 或 Releases 下载 `视频剧情标注_0.5.0_windows_x64_portable.zip`：

1. 将 ZIP 完整解压到本机磁盘。
2. 双击 `启动视频剧情标注.cmd`，不要单独移动或启动 EXE。
3. 首次启动脚本会为随包 WebView2 Fixed Runtime 配置必要权限，不安装系统组件，也不要求管理员权限。

便携包不支持 UNC 或网络共享位置。当前版本未进行商业代码签名，Windows 可能显示 SmartScreen 提示。WebView2 缓存保存在 `%LOCALAPPDATA%`，标注数据仍只写入你选择的项目目录。

Windows 便携包由 `.github/workflows/windows-portable.yml` 在 `windows-2022` 构建。普通提交生成保留 7 天的 Artifact；推送 `v*` 标签会创建公开 GitHub Release。

## macOS Apple 芯片 libmpv 正式版

为解决部分 AAC/PCE 音轨在 WKWebView 中没有声音的问题，macOS 版内嵌 libmpv，并使用 FFmpeg 解码音频。`v0.5.0` 保留 v0.4.4 的 macOS 播放改进，并与 Windows 版统一加入多音轨异常检测。Windows 继续使用系统播放器。

从 GitHub Releases 下载 `offline-video-caption-annotator_0.5.0_macos_aarch64.dmg`，并可使用同名 `.sha256` 文件核对完整性。该版本使用 ad-hoc 签名、未公证；首次打开如被 macOS 拦截，请在 Finder 中右键应用并选择“打开”。

macOS 标注页提供播放/暂停、音量、静音、时间轴、时间显示、视频专注模式和从头重播完整视频等自定义控件。libmpv 初始化或加载失败时会自动回退到系统播放器并显示原因，也可以点击“重试 libmpv”。

升级软件不会清空标注进度。重新打开原项目目录时，应用会继续读取 `.annotation-workspace` 中的判定、False 草稿、当前单元和视频位置；进行中的任务完成后，下一次导出才会生成其结果文件。

## macOS 本地构建

要求 Node.js 20+、Xcode Command Line Tools 和 macOS 13+：

```bash
npm install
npm run rust:setup
npm run test:run
npm run lint
npm run typecheck
npm run build
scripts/macos/build-libmpv.sh
LIBMPV_PATH="$PWD/src-tauri/frameworks/libmpv.2.dylib" npm run tauri:dev
```

Rust、Cargo 与 rustup 安装在项目的 `.tools/`，不会修改全局环境。构建 `.app` 和 `.dmg`：

```bash
npm run tauri:build -- --config src-tauri/tauri.mpv-preview.conf.json
```

产物位于 `src-tauri/target/release/bundle/`。未公证的本地构建在其他 Mac 首次启动时需要右键选择“打开”。

## 浏览器开发模式

运行 `npm run dev` 可预览 Web 界面。浏览器模式只用于开发；正式 SQLite、SHA-256 冲突检查和原子导出由 Tauri 原生层提供。

## 隐私与公开仓库

真实视频、JSONL、SQLite、备份和导出结果均被 Git 忽略。提交公开仓库前，Windows CI 还会扫描受跟踪文件，阻止私人数据、绝对用户路径和生成结果进入发布流程。测试仅使用代码内的合成文本数据。

## License

[MIT](LICENSE)。Windows 便携包中的 WebView2 Fixed Version Runtime，以及 macOS 版内嵌的 LGPL libmpv/FFmpeg 运行时受各自许可条款约束，详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
