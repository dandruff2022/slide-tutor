@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -q -r requirements.txt
start "" .venv\Scripts\pythonw.exe tray_win.py
