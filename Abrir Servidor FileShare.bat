@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Servidor local FileShare

if not exist "node_modules\express\index.js" (
  echo Execute primeiro "Instalar FileShare Local.bat" com internet.
  pause
  exit /b 1
)
if not exist "local-runtime\node_modules\@electric-sql\pglite\package.json" (
  echo Execute primeiro "Instalar FileShare Local.bat" com internet.
  pause
  exit /b 1
)

set "FILESHARE_LOCAL=1"
set "FILESHARE_NO_BROWSER="
if not defined PORT set "PORT=3000"

echo Iniciando o servidor FileShare...
echo Deixe esta janela aberta enquanto a sala estiver usando o sistema.
echo.
node server.js
echo.
echo O servidor foi encerrado. Para iniciar novamente, clique neste arquivo.
pause
