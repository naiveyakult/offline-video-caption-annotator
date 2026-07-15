param(
    [string]$OutputDirectory = "artifacts"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$outputRoot = Join-Path $repositoryRoot $OutputDirectory
$packageName = "视频剧情标注_0.3.0_windows_x64_portable"
$stageDirectory = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256"
$sourceExecutable = Join-Path $repositoryRoot "src-tauri/target/release/offline-video-annotator.exe"
$runtimeDirectory = Join-Path $repositoryRoot "src-tauri/WebView2FixedRuntime"

if (-not (Test-Path -LiteralPath $sourceExecutable)) {
    throw "找不到 Windows Release 可执行文件：$sourceExecutable"
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory "msedgewebview2.exe"))) {
    throw "WebView2 Fixed Runtime 尚未准备完成。"
}

if (Test-Path -LiteralPath $stageDirectory) {
    Remove-Item -LiteralPath $stageDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stageDirectory | Out-Null

Copy-Item -LiteralPath $sourceExecutable -Destination (Join-Path $stageDirectory "视频剧情标注.exe")
Copy-Item -LiteralPath $runtimeDirectory -Destination (Join-Path $stageDirectory "WebView2FixedRuntime") -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "启动视频剧情标注.cmd") -Destination $stageDirectory
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "使用说明.txt") -Destination $stageDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "THIRD_PARTY_NOTICES.txt") -Destination $stageDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot "LICENSE") -Destination $stageDirectory

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $stageDirectory -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$hash  $([IO.Path]::GetFileName($zipPath))" -Encoding ascii

Write-Host "Portable package: $zipPath"
Write-Host "SHA-256: $hash"
