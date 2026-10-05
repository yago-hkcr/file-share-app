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

echo Iniciando o FileShare local...
echo Entre como ADM e ative o servidor da sala no painel para liberar o acesso pela rede.
echo Deixe esta janela aberta enquanto a sala estiver usando o sistema.
echo.
call npm run local:start
echo.
echo O servidor foi encerrado. Para iniciar novamente, clique neste arquivo.
pause
