@echo off
title Errand setup
rem Downloads and runs the Errand installer (scripts/install.ps1 in the Errand repository).
rem No admin rights needed. Everything goes into %LOCALAPPDATA%\Errand.
set "ERRAND_SETUP_WRAPPER=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/FurquanEats/errand/main/scripts/install.ps1 | iex"
if errorlevel 1 (
  echo.
  echo   Setup did not finish. Fix the problem above, or check your internet connection, and run this file again.
  pause
)
