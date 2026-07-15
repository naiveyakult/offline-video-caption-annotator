$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$manifestPath = Join-Path $PSScriptRoot "webview2-runtime.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtimeDirectory = Join-Path $repositoryRoot "src-tauri/WebView2FixedRuntime"
$downloadDirectory = Join-Path $repositoryRoot ".cache/webview2"
$cabPath = Join-Path $downloadDirectory "WebView2FixedRuntime.cab"

New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
if (-not (Test-Path -LiteralPath $cabPath)) {
    Invoke-WebRequest -Uri $manifest.url -OutFile $cabPath
}

$actualHash = (Get-FileHash -LiteralPath $cabPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256) {
    Remove-Item -LiteralPath $cabPath -Force
    throw "WebView2 下载文件 SHA-256 校验失败。"
}

if (Test-Path -LiteralPath $runtimeDirectory) {
    Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

& expand.exe $cabPath -F:* $runtimeDirectory | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "无法解压 WebView2 Fixed Runtime。"
}

$browser = Get-ChildItem -LiteralPath $runtimeDirectory -Filter "msedgewebview2.exe" -File -Recurse |
    Select-Object -First 1
if ($null -eq $browser) {
    throw "WebView2 Fixed Runtime 中缺少 msedgewebview2.exe。"
}

if ($browser.Directory.FullName -ne $runtimeDirectory) {
    Get-ChildItem -LiteralPath $browser.Directory.FullName -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $runtimeDirectory -Force
    }
}

$remainingBrowser = Join-Path $runtimeDirectory "msedgewebview2.exe"
if (-not (Test-Path -LiteralPath $remainingBrowser)) {
    throw "WebView2 Fixed Runtime 目录结构不正确。"
}

Write-Host "Prepared WebView2 Fixed Runtime $($manifest.version) ($($manifest.architecture))."
