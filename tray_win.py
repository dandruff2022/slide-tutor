"""Windows tray launcher for local slide-tutor courses (the counterpart of tray.py)."""
import atexit
import json
import os
import socket
import subprocess
import sys
import webbrowser
import winreg
from pathlib import Path
from tkinter import Tk, filedialog
from urllib.parse import urlsplit

import pystray
from PIL import Image

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / '.venv/Scripts/python.exe'
CONFIG = Path(os.environ['APPDATA']) / 'slide-tutor/courses.json'
ENV = CONFIG.with_name('env')  # optional KEY=VALUE lines, same keys as on macOS (see README)
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
RUN_VALUE = 'slide-tutor'
HIDDEN = subprocess.CREATE_NO_WINDOW
ICON_COLOR = (66, 133, 244, 255)  # tray.png is a black macOS template: tint it to show on any taskbar
WM_LBUTTONUP, WM_RBUTTONUP = 0x0202, 0x0205


class MenuIcon(pystray.Icon):
    """Left click opens the menu too, as on the macOS menu bar (pystray only does this for right click)."""

    def _on_notify(self, wparam, lparam):
        super()._on_notify(wparam, WM_RBUTTONUP if lparam == WM_LBUTTONUP else lparam)


def settings():
    if not ENV.exists():
        return {}
    return dict(line.split('=', 1) for line in ENV.read_text(encoding='utf-8-sig').splitlines()
                if '=' in line and not line.lstrip().startswith('#'))


def port_open(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


def login_enabled():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, RUN_VALUE)
        return True
    except FileNotFoundError:
        return False


def set_login(enabled):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, f'"{PYTHON.with_name("pythonw.exe")}" "{ROOT / "tray_win.py"}"')
        else:
            winreg.DeleteValue(key, RUN_VALUE)


def pick_folder():
    window = Tk()
    window.withdraw()
    window.attributes('-topmost', True)
    try:
        return filedialog.askdirectory(parent=window, title='Choose a slides folder')
    finally:
        window.destroy()


class Tray:
    def __init__(self):
        self.courses = json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else []
        self.children = {}
        atexit.register(self.stop_all)
        template = Image.open(ROOT / 'static/tray.png').convert('RGBA')
        image = Image.new('RGBA', template.size, ICON_COLOR)
        image.putalpha(template.getchannel('A'))
        self.icon = MenuIcon('slide-tutor', image, 'slide-tutor', pystray.Menu(self.items))
        self.start_all()

    def save(self):
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        temporary = CONFIG.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.courses, indent=2) + '\n', encoding='utf-8')
        temporary.replace(CONFIG)

    def start_proxy(self, extra):
        """Run SLIDE_TUTOR_START_CMD if the endpoint is down. It outlives the tray, like the Mac proxy."""
        command, port = extra.get('SLIDE_TUTOR_START_CMD'), urlsplit(extra.get('SLIDE_TUTOR_ROUTER', '')).port
        if not command or not port or port_open(port):
            return
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        with CONFIG.with_name('proxy.log').open('a', encoding='utf-8') as log:
            subprocess.Popen(command, shell=True, creationflags=HIDDEN, stdout=log, stderr=subprocess.STDOUT)

    def start(self, course, extra):
        port = course['port']
        if port_open(port):
            return
        data = Path(course['slides']).parent / 'slide-tutor/data'
        (data / 'logs').mkdir(parents=True, exist_ok=True)
        # PYTHONUTF8: app.py reads notes without an encoding, and Windows defaults to the ANSI code page.
        env = dict(os.environ, **extra, PYTHONUTF8='1', SLIDE_TUTOR_SLIDES=course['slides'], SLIDE_TUTOR_DATA=str(data),
                   SLIDE_TUTOR_COURSE=course['course'], PORT=str(port))
        env.pop('SLIDE_TUTOR_START_CMD', None)  # started above: app.py's POSIX-style launcher must not retry it
        with (data / 'logs/server.log').open('a', encoding='utf-8') as log:
            self.children[port] = subprocess.Popen(
                [str(PYTHON), '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', str(port)],
                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=HIDDEN)

    def start_all(self):
        extra = settings()
        self.start_proxy(extra)
        for course in self.courses:
            self.start(course, extra)

    def stop(self, port):
        process = self.children.pop(port, None)
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)

    def stop_all(self):
        for port in list(self.children):
            self.stop(port)

    def items(self):
        def course_item(course):
            return pystray.MenuItem(course['course'], pystray.Menu(
                pystray.MenuItem('Open', lambda: webbrowser.open(f"http://127.0.0.1:{course['port']}")),
                pystray.MenuItem('Remove', lambda: self.remove(course))))
        return [*map(course_item, self.courses), pystray.Menu.SEPARATOR,
                pystray.MenuItem('Add Slides Folder…', self.add_folder),
                pystray.MenuItem('Edit Settings…', self.edit_settings),
                pystray.MenuItem('Restart Courses', self.restart),
                pystray.MenuItem('Launch at Login', self.toggle_login, checked=lambda _: login_enabled()),
                pystray.MenuItem('Quit', self.quit)]

    def remove(self, course):
        self.stop(course['port'])
        self.courses.remove(course)
        self.save()
        self.icon.update_menu()

    def add_folder(self):
        picked = pick_folder()
        if not picked:
            return
        slides = Path(picked).resolve()
        if any(Path(c['slides']) == slides for c in self.courses):
            return
        course = {'slides': str(slides), 'course': slides.parent.name,
                  'port': max((c['port'] for c in self.courses), default=8764) + 1}
        self.courses.append(course)
        self.save()
        self.start(course, settings())
        self.icon.update_menu()

    def edit_settings(self):
        ENV.parent.mkdir(parents=True, exist_ok=True)
        ENV.touch()
        subprocess.Popen(['notepad.exe', str(ENV)])

    def restart(self):
        self.stop_all()
        self.start_all()

    def toggle_login(self):
        set_login(not login_enabled())

    def quit(self):
        self.icon.stop()
        self.stop_all()


if __name__ == '__main__':
    if sys.platform != 'win32':
        sys.exit('tray_win.py is for Windows; use tray.py on macOS.')
    Tray().icon.run()
