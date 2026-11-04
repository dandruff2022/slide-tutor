"""Menu bar launcher for local slide-tutor courses."""
import atexit
import json
import os
import plistlib
import signal
import socket
import subprocess
import webbrowser
from pathlib import Path

import rumps

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / '.venv/bin/python'
CONFIG = Path.home() / 'Library/Application Support/slide-tutor/courses.json'
ENV = CONFIG.with_name('env')  # optional KEY=VALUE lines (e.g. SLIDE_TUTOR_API_KEY), also seen when launched at login
LABEL = 'local.slide-tutor.tray'
PLIST = Path.home() / f'Library/LaunchAgents/{LABEL}.plist'


def launch_at_login(enabled):
    if enabled:
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        with PLIST.open('wb') as f:
            plistlib.dump({'Label': LABEL, 'RunAtLoad': True,
                          'ProgramArguments': [str(PYTHON), str(ROOT / 'tray.py')],
                          'WorkingDirectory': str(ROOT)}, f)
    else:
        PLIST.unlink(missing_ok=True)


class Tray(rumps.App):
    def __init__(self):
        super().__init__('slide-tutor', title='', icon=str(ROOT / 'static/tray.png'), template=True, quit_button=None)
        self.courses = json.loads(CONFIG.read_text()) if CONFIG.exists() else []
        self.children = {}
        atexit.register(self.stop_all)
        signal.signal(signal.SIGTERM, self.quit)
        signal.signal(signal.SIGINT, self.quit)
        self.timer = rumps.Timer(lambda _: None, 1)  # let Python handle signals during the Cocoa event loop
        self.timer.start()
        for course in self.courses:
            self.start(course)
        self.rebuild()

    def save(self):
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        temporary = CONFIG.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.courses, indent=2) + '\n')
        temporary.replace(CONFIG)

    def start(self, course):
        port = course['port']
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                return
        data = Path(course['slides']).parent / 'slide-tutor/data'
        (data / 'logs').mkdir(parents=True, exist_ok=True)
        extra = dict(line.split('=', 1) for line in ENV.read_text().splitlines()
                     if '=' in line and not line.lstrip().startswith('#')) if ENV.exists() else {}
        env = dict(os.environ, **extra, SLIDE_TUTOR_SLIDES=course['slides'], SLIDE_TUTOR_DATA=str(data),
                   SLIDE_TUTOR_COURSE=course['course'], PORT=str(port))
        with (data / 'logs/server.log').open('a') as log:
            self.children[port] = subprocess.Popen(
                [str(PYTHON), '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', str(port)],
                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)

    def stop(self, port):
        process = self.children.pop(port, None)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def stop_all(self):
        for port in list(self.children):
            self.stop(port)

    def rebuild(self):
        self.menu.clear()
        for course in self.courses:
            item = rumps.MenuItem(course['course'])
            item.add(rumps.MenuItem('Open', callback=lambda _, c=course: webbrowser.open(f"http://127.0.0.1:{c['port']}")))
            item.add(rumps.MenuItem('Remove', callback=lambda _, c=course: self.remove(c)))
            self.menu.add(item)
        self.menu.add(rumps.MenuItem('Add Slides Folder…', callback=self.add_folder))
        self.menu.add(rumps.MenuItem('Set API Key…', callback=self.set_key))
        item = rumps.MenuItem('Launch at Login', callback=self.toggle_login)
        item.state = PLIST.exists()
        self.menu.add(item)
        self.menu.add(rumps.MenuItem('Quit', callback=self.quit))

    def remove(self, course):
        self.stop(course['port'])
        self.courses.remove(course)
        self.save()
        self.rebuild()

    def add_folder(self, _):
        picked = subprocess.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "Choose a slides folder")'],
                                capture_output=True, text=True)
        if picked.returncode:
            return
        slides = Path(picked.stdout.strip()).resolve()
        if any(Path(c['slides']) == slides for c in self.courses):
            return
        course = {'slides': str(slides), 'course': slides.parent.name,
                  'port': max((c['port'] for c in self.courses), default=8764) + 1}
        self.courses.append(course)
        self.save()
        self.start(course)
        self.rebuild()

    def set_key(self, _):
        reply = rumps.Window('Anthropic API key (saved in ~/Library/Application Support/slide-tutor/env):',
                             'slide-tutor', ok='Save', cancel='Cancel', dimensions=(320, 24)).run()
        if not reply.clicked or not reply.text.strip():
            return
        lines = [line for line in (ENV.read_text().splitlines() if ENV.exists() else [])
                 if not line.startswith('SLIDE_TUTOR_API_KEY=')]
        ENV.parent.mkdir(parents=True, exist_ok=True)
        ENV.write_text('\n'.join(lines + [f'SLIDE_TUTOR_API_KEY={reply.text.strip()}']) + '\n')
        ENV.chmod(0o600)
        self.stop_all()  # restart the courses with the new key
        for course in self.courses:
            self.start(course)

    def toggle_login(self, item):
        launch_at_login(not PLIST.exists())
        item.state = PLIST.exists()

    def quit(self, *_):
        self.stop_all()
        rumps.quit_application()


if __name__ == '__main__':
    Tray().run()
