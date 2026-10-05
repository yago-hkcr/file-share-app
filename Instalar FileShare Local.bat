@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Preparar FileShare Local

echo ============================================
echo       PREPARAR FILESHARE PARA A SALA
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado.
  echo Instale o Node.js 24 LTS em https://nodejs.org e abra este arquivo novamente.
  pause
  exit /b 1
)
echo Instalando os componentes do FileShare. Esta etapa precisa de internet e so e feita uma vez.
echo.
call npm install
if errorlevel 1 (
  echo.
  echo Nao foi possivel instalar os componentes principais.
  pause
  exit /b 1
)
call npm --prefix local-runtime install
if errorlevel 1 (
  echo.
  echo Nao foi possivel instalar o banco local.
  pause
  exit /b 1
)
echo.
echo Preparacao concluida. Agora voce pode desligar a internet e abrir:
echo Abrir Servidor FileShare.bat
echo.
pause
