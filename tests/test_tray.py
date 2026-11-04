import json
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import tray


class TrayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = patch.object(tray, 'CONFIG', self.root / 'courses.json')
        self.plist = patch.object(tray, 'PLIST', self.root / 'LaunchAgents/tray.plist')
        self.config.start(); self.plist.start()
        self.app = tray.Tray.__new__(tray.Tray)
        self.app.courses = []
        self.app.children = {}

    def tearDown(self):
        self.config.stop(); self.plist.stop()
        self.temp.cleanup()

    def test_login_toggle(self):
        item = SimpleNamespace(state=False)
        self.app.toggle_login(item)
        saved = plistlib.loads(tray.PLIST.read_bytes())
        self.assertTrue(item.state)
        self.assertTrue(saved['RunAtLoad'])
        self.assertEqual(saved['ProgramArguments'], [str(tray.PYTHON), str(tray.ROOT / 'tray.py')])
        self.assertEqual(saved['WorkingDirectory'], str(tray.ROOT))
        self.app.toggle_login(item)
        self.assertFalse(item.state); self.assertFalse(tray.PLIST.exists())

    def test_start_and_stop_owned_child(self):
        course = {'slides': str(self.root / 'slides'), 'course': 'Test course', 'port': 9876}
        process = Mock(); process.poll.return_value = None
        with patch.object(tray.socket, 'socket') as sock, patch.object(tray.subprocess, 'Popen', return_value=process) as spawn:
            sock.return_value.__enter__.return_value.connect_ex.return_value = 1
            self.app.start(course)
        args, kwargs = spawn.call_args
        self.assertEqual(args[0], [str(tray.PYTHON), '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '9876'])
        self.assertEqual(kwargs['cwd'], tray.ROOT)
        self.assertEqual(kwargs['env']['SLIDE_TUTOR_DATA'], str(self.root / 'slide-tutor/data'))
        self.assertEqual(kwargs['env']['SLIDE_TUTOR_COURSE'], 'Test course')
        self.assertEqual(kwargs['env']['PORT'], '9876')
        self.assertTrue((self.root / 'slide-tutor/data/logs/server.log').exists())
        self.app.stop_all()
        process.terminate.assert_called_once(); process.wait.assert_called_once_with(timeout=5)
        self.assertEqual(self.app.children, {})

    def test_occupied_port_is_not_owned(self):
        with patch.object(tray.socket, 'socket') as sock, patch.object(tray.subprocess, 'Popen') as spawn:
            sock.return_value.__enter__.return_value.connect_ex.return_value = 0
            self.app.start({'port': 9876})
        spawn.assert_not_called()
        self.assertEqual(self.app.children, {})

    def test_remove_keeps_data(self):
        data = self.root / 'slide-tutor/data'; data.mkdir(parents=True)
        note = data / 'note'; note.write_text('keep')
        course = {'slides': str(self.root / 'slides'), 'course': 'Test', 'port': 9876}
        self.app.courses = [course]
        with patch.object(self.app, 'rebuild'):
            self.app.remove(course)
        self.assertEqual(json.loads(tray.CONFIG.read_text()), [])
        self.assertEqual(note.read_text(), 'keep')

    def test_cancelled_folder_picker_does_nothing(self):
        with patch.object(tray.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), patch.object(self.app, 'save') as save:
            self.app.add_folder(None)
        save.assert_not_called()

    def test_add_folder_defaults(self):
        self.app.courses = [{'slides': '/other/slides', 'course': 'Other', 'port': 9876}]
        slides = self.root / 'New Course/slides'; slides.mkdir(parents=True)
        picked = subprocess.CompletedProcess([], 0, str(slides) + '/\n')
        with patch.object(tray.subprocess, 'run', return_value=picked), patch.object(self.app, 'start') as start, patch.object(self.app, 'rebuild'):
            self.app.add_folder(None)
        course = {'slides': str(slides.resolve()), 'course': 'New Course', 'port': 9877}
        self.assertEqual(self.app.courses[-1], course)
        start.assert_called_once_with(course)
        self.assertEqual(json.loads(tray.CONFIG.read_text()), self.app.courses)
