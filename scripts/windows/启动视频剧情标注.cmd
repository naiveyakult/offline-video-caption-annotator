@echo off
setlocal EnableExtensions
chcp 65001 >nul

pushd "%~dp0" >nul 2>&1
if errorlevel 1 goto location_error

set "APP_DIR=%CD%"
set "RUNTIME_DIR=%APP_DIR%\WebView2FixedRuntime"
set "APP_EXE=%APP_DIR%\视频剧情标注.exe"
set "ACL_MARKER=%APP_DIR%\.webview2-acl-ready-150.0.4078.65"

if "%APP_DIR:~0,2%"=="\\" goto network_error
net use "%APP_DIR:~0,2%" >nul 2>&1
if not errorlevel 1 goto network_error

if not exist "%APP_EXE%" goto incomplete_error
if not exist "%RUNTIME_DIR%\msedgewebview2.exe" goto incomplete_error
if exist "%ACL_MARKER%" goto launch

icacls "%RUNTIME_DIR%" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /C /Q >nul 2>&1
if errorlevel 1 goto permission_error
icacls "%RUNTIME_DIR%" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /C /Q >nul 2>&1
if errorlevel 1 goto permission_error
>"%ACL_MARKER%" echo WebView2 ACL configured for 150.0.4078.65

:launch
"%APP_EXE%" %*
set "APP_EXIT=%ERRORLEVEL%"
popd
exit /b %APP_EXIT%

:network_error
echo.
echo [无法启动] WebView2 固定运行时不支持 UNC 或网络共享位置。
echo 请将整个文件夹复制到本机磁盘后，再双击本启动脚本。
goto failed

:incomplete_error
echo.
echo [无法启动] 便携包文件不完整。
echo 请先完整解压 ZIP，且不要单独移动 EXE 或本启动脚本。
goto failed

:permission_error
echo.
echo [无法启动] 无法配置 WebView2 运行权限。
echo 请把整个文件夹移动到桌面、文档或普通数据盘后重试；不需要管理员权限。
goto failed

:location_error
echo.
echo [无法启动] 无法访问程序所在目录。

:failed
echo.
pause
popd >nul 2>&1
exit /b 1
