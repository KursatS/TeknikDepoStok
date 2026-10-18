@echo off
chcp 65001 >nul
title TeknikDepo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Lutfen Node.js 22 veya uzerini kurun: https://nodejs.org
  echo Kurduktan sonra bu dosyaya tekrar cift tiklayin.
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Node.js surumunuz eski. TeknikDepo icin Node.js 22 veya uzeri gerekli: https://nodejs.org
  pause
  exit /b 1
)

rem Sunucu zaten calisiyorsa sadece tarayiciyi ac
netstat -ano | findstr /r /c:":5056 .*LISTENING" >nul
if not errorlevel 1 (
  start "" "http://localhost:5056"
  exit /b 0
)

rem Sunucu hazir olunca tarayici acilsin
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5056"
echo TeknikDepo calisiyor: http://localhost:5056
echo Kapatmak icin bu pencereyi kapatin.
node --no-warnings server.js
pause
