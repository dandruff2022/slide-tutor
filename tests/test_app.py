"""Run: .venv/bin/python -m unittest discover -s tests -v"""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pypdf import PdfWriter

fixtures = tempfile.TemporaryDirectory()
slides = Path(fixtures.name) / 'slides'
slides.mkdir()
writer = PdfWriter()
for _ in range(9): writer.add_blank_page(width=612, height=792)
for n in range(1, 13): writer.write(slides / f'Lecture{n}.pdf')
with patch.dict(os.environ, {'SLIDE_TUTOR_SLIDES': str(slides), 'SLIDE_TUTOR_DATA': str(Path(fixtures.name) / 'data')}):
    import app as tutor


def tearDownModule():
    fixtures.cleanup()

# Tiny real PNGs; they are only transport fixtures, not rendered slides.
HIRES_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR42mP8z8DAwMAAAA0AAf4VlsMAAAAASUVORK5CYII='
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
REPLY = ('From p.2, ', '$w_{t+1}=w_t-\\eta g_t$.')


def sse(*texts, cached=0):
    """A streamed /v1/messages reply as the proxy sends it."""
    events = [{"type": "message_start", "message": {"usage": {"input_tokens": 300, "cache_read_input_tokens": cached}}},
              *[{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": t}} for t in texts],
              {"type": "message_delta", "usage": {"output_tokens": 20}}, {"type": "message_stop"}]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'cache').mkdir()
        (root / 'notes').mkdir()
        self.data = patch.object(tutor, 'DATA', root)
        self.data.start()
        self.router = patch.object(tutor, 'ROUTER', 'http://router.test')
        self.router.start()
        self.client = TestClient(tutor.app)

    def tearDown(self):
        self.client.close()
        self.data.stop()
        self.router.stop()
        self.temp.cleanup()

    def body(self, page=2, **extra):
        return {'lecture': 'Lecture1', 'page': page, 'mode': 'ask', 'text': 'What is $w_t$?',
                'image': PNG, 'image_hires': PNG, **extra}

    def chat(self, body, *replies):
        """Each reply (SSE text or an httpx.Response) answers one /v1/messages call; returns what was sent."""
        sent, queue = [], list(replies)
        def handle(request):
            if request.method == 'GET':
                return httpx.Response(200)  # ensure_proxies' liveness check
            sent.append({'json': json.loads(request.content), 'headers': request.headers})
            reply = queue.pop(0)
            return reply if isinstance(reply, httpx.Response) else httpx.Response(200, text=reply, headers={'content-type': 'text/event-stream'})
        with patch.object(tutor, 'transport', httpx.MockTransport(handle)):
            reply = self.client.post('/api/chat', json=body)
        return reply, sent

    def test_static_and_lectures(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual([x['id'] for x in self.client.get('/api/lectures').json()], 
                         sorted((p.stem for p in tutor.SLIDES.glob('*.pdf')), key=lambda s: int(s[7:])))
        self.assertEqual(self.client.get('/api/lectures').json()[11]['label'], 'Lecture 12')
        self.assertIn(tutor.COURSE, self.client.get('/').text)
        self.assertEqual(self.client.get('/api/lectures/..%2Fx/notes').status_code, 404)
        self.assertEqual(self.client.get('/slides/Lecture1.pdf').headers['content-type'], 'application/pdf')

    def test_other_course_folder(self):
        slides = Path(self.temp.name) / 'slides'; slides.mkdir()
        for name in ('10_intro_mpi', '2_arch', '1.5_overview', '1_course_info'):
            (slides / f'{name}.pdf').write_bytes((tutor.SLIDES / 'Lecture1.pdf').read_bytes())
        with patch.object(tutor, 'SLIDES', slides):
            listed = self.client.get('/api/lectures').json()
            self.assertEqual([x['id'] for x in listed], ['1_course_info', '1.5_overview', '2_arch', '10_intro_mpi'])
            self.assertEqual(listed[3]['label'], '10 intro mpi')
            self.assertEqual(self.client.get('/slides/1.5_overview.pdf').status_code, 200)
            self.client.put('/api/lectures/1.5_overview/notes/1', json={'text': 'x'})
            self.assertTrue((tutor.DATA / 'notes/1.5_overview.md').exists())

    def test_notes_roundtrip_grouped_by_page(self):
        url = '/api/lectures/Lecture1/notes'
        self.assertEqual(self.client.get(url).json(), {})
        self.client.put(url + '/5', json={'text': '\\log p(x) \\ge \\text{ELBO}\nsecond line'})
        self.client.put(url + '/2', json={'text': 'first'})
        self.client.put(url + '/9', json={'text': '   '})  # blank notes are dropped
        self.assertEqual(self.client.get(url).json(), {'2': 'first', '5': '\\log p(x) \\ge \\text{ELBO}\nsecond line'})
        md = (tutor.DATA / 'notes/Lecture1.md').read_text()
        self.assertLess(md.index('## p.2'), md.index('## p.5'))
        self.client.put(url + '/2', json={'text': ''})
        self.assertNotIn('## p.2', (tutor.DATA / 'notes/Lecture1.md').read_text())
        self.assertEqual(self.client.put(url + '/99999', json={'text': 'x'}).status_code, 422)

    def test_stale_autosave_cannot_overwrite_batch_or_other_tab(self):
        url = '/api/lectures/Lecture1/notes'
        self.client.put(url + '/2', json={'text': 'old', 'before': ''})
        reply = self.client.post(url + '/batch', json={'changes': [{'page': 2, 'before': 'old', 'text': 'moved content'}]})
        self.assertEqual(reply.status_code, 200)
        reply = self.client.put(url + '/2', json={'text': 'stale edit', 'before': 'old'})
        self.assertEqual(reply.status_code, 409)
        self.assertEqual(self.client.get(url).json()['2'], 'moved content')
        reply = self.client.put(url + '/2', json={'text': 'new edit', 'before': 'moved content'})
        self.assertEqual(reply.status_code, 200)

    def test_model_choice(self):
        listed = self.client.get('/api/models').json()
        self.assertEqual(listed['default'], tutor.MODEL)
        self.assertIn('claude-haiku-4-5-20251001', [m['id'] for m in listed['models']])
        reply, sent = self.chat(self.body(model='claude-haiku-4-5-20251001'), sse(*REPLY))
        self.assertEqual(sent[0]['json']['model'], 'claude-haiku-4-5-20251001')
        self.assertIn('"model": "claude-haiku-4-5-20251001"', (tutor.DATA / 'logs/events.jsonl').read_text())
        self.assertEqual(self.client.post('/api/chat', json=self.body(model='not-a-model')).status_code, 422)

    def test_ask_streams_stateless_with_note(self):
        reply, sent = self.chat(self.body(note='my step $a=b$', note_lang='zh'), sse(*REPLY))
        self.assertIn('From p.2', reply.text)
        self.assertIn('"done"', reply.text)
        self.assertEqual(len(sent), 1)
        request = sent[0]['json']
        self.assertEqual((request['model'], request['stream'], request['output_config']), (tutor.MODEL, True, {'effort': 'medium'}))
        self.assertEqual(len(request['messages']), 1)  # stateless: one user turn
        page, image, asked = request['messages'][0]['content']
        self.assertIn('Noisy extracted text of p.1 (adjacent context, no image)', page['text'])
        self.assertIn('Noisy extracted text of p.3', page['text'])
        self.assertEqual(image['type'], 'image'); self.assertEqual(image['cache_control']['ttl'], '1h')
        self.assertIn("USER'S NOTE FOR THIS PAGE", asked['text'])
        self.assertIn('my step $a=b$', asked['text'])
        self.assertIn('QUESTION:\nWhat is $w_t$?', asked['text'])
        self.assertIn('reply in English', asked['text'])
        self.assertIn('note block you write are in Simplified Chinese', asked['text'])
        self.assertIn('asks for a language, follow that instead', asked['text'])
        self.assertEqual(self.client.post('/api/chat', json=self.body(response_lang='fr')).status_code, 422)

    def test_same_page_shares_cacheable_prefix(self):
        _, first = self.chat(self.body(text='first?', note='n1'), sse(*REPLY))
        _, second = self.chat(self.body(text='second?', response_lang='zh'), sse(*REPLY))
        a, b = (s[0]['json'] for s in (first, second))
        self.assertEqual(a['system'], b['system'])
        self.assertEqual(a['messages'][0]['content'][:2], b['messages'][0]['content'][:2])  # page text + image
        self.assertNotEqual(a['messages'][0]['content'][2], b['messages'][0]['content'][2])
        self.assertNotIn('first?', json.dumps(a['messages'][0]['content'][:2]))
        # the proxy keys the provider's prompt cache on this header: fixed per course, not per request
        self.assertEqual(first[0]['headers']['x-claude-code-session-id'], tutor.CACHE_SESSION)
        self.assertEqual(second[0]['headers']['x-claude-code-session-id'], tutor.CACHE_SESSION)

    def test_hires_on_request(self):
        reply, sent = self.chat(self.body(image_hires=HIRES_PNG), sse('[[HI', 'RES]]'), sse(*REPLY))
        self.assertEqual(len(sent), 2)
        self.assertNotIn('HIRES]]', reply.text)
        self.assertIn('"status"', reply.text); self.assertIn('From p.2', reply.text)
        page, image, _ = sent[1]['json']['messages'][0]['content']
        self.assertEqual(image['source']['data'], HIRES_PNG.split(',', 1)[1])
        self.assertIn('high resolution', page['text'])
        self.assertEqual(sent[0]['json']['messages'][0]['content'][1]['source']['data'], PNG.split(',', 1)[1])
        chat = json.loads((Path(self.temp.name) / 'logs/events.jsonl').read_text().splitlines()[-1])
        self.assertTrue(chat['hires']); self.assertEqual(chat['pages'], []); self.assertEqual(chat['first_usage']['output_tokens'], 20)
        self.assertIn('answer now', sent[1]['json']['messages'][0]['content'][2]['text'])

    def test_pages_on_request(self):
        reply, sent = self.chat(self.body(text='where was w defined?'), sse('[[PAGES 4-5, 1, 99]]'), sse(*REPLY))
        self.assertEqual(len(sent), 2); self.assertIn('the text of 3 pages', reply.text)
        self.assertEqual(sent[0]['json']['messages'][0]['content'][:2], sent[1]['json']['messages'][0]['content'][:2])  # prefix still cached
        asked = sent[1]['json']['messages'][0]['content'][2]['text']
        texts = tutor.metadata('Lecture1')['texts']
        self.assertLess(asked.index('--- p.1 ---'), asked.index('--- p.4 ---')); self.assertLess(asked.index('--- p.4 ---'), asked.index('--- p.5 ---'))
        self.assertNotIn('--- p.2 ---', asked); self.assertIn(texts[3].strip()[:40], asked)
        self.assertLess(asked.index('--- p.5 ---'), asked.index('QUESTION:'))
        chat = json.loads((Path(self.temp.name) / 'logs/events.jsonl').read_text().splitlines()[-1])
        self.assertEqual((chat['hires'], chat['pages']), (False, [1, 4, 5]))

    def test_hires_and_all_pages(self):
        reply, sent = self.chat(self.body(image_hires=HIRES_PNG), sse('[[HIRES]]\n[[PAGES', ' all]]'), sse(*REPLY))
        total = tutor.metadata('Lecture1')['pages']
        self.assertIn(f'high resolution and the text of {total} pages', reply.text)
        self.assertEqual(sent[1]['json']['messages'][0]['content'][1]['source']['data'], HIRES_PNG.split(',', 1)[1])
        self.assertIn(f'--- p.{total} ---', sent[1]['json']['messages'][0]['content'][2]['text'])
        with patch.object(tutor, 'metadata', lambda lecture: {'pages': total, 'texts': [''] * total}):
            _, sent = self.chat(self.body(), sse('[[PAGES 1]]'), sse(*REPLY))
        self.assertIn('--- p.1 ---\n[no extractable text: image-only page]', sent[1]['json']['messages'][0]['content'][2]['text'])

    def test_text_mentioning_requests_is_an_answer(self):
        reply, sent = self.chat(self.body(), sse('[[PAGES 2]] is how ', 'you would ask.'))
        self.assertEqual(len(sent), 1); self.assertIn('you would ask', reply.text)

    def test_marker_prefix_is_flushed(self):
        reply, sent = self.chat(self.body(), sse('[[x'))
        self.assertEqual(len(sent), 1); self.assertIn('[[x', reply.text)

    def test_check_sends_typed_message(self):
        reply, sent = self.chat(self.body(mode='check', note='a=b', text='is step 1 right?'), sse(*REPLY))
        asked = sent[0]['json']['messages'][0]['content'][2]['text']
        self.assertIn('CHECK REQUEST', asked)
        self.assertIn('is step 1 right?', asked); self.assertIn('takes priority', asked)
        self.assertNotIn('QUESTION:', asked)

    def test_linked_thread_precedes_question(self):
        thread = [{'question': 'what is z?', 'answer': 'the latent.'}]
        reply, sent = self.chat(self.body(text='and its prior?', thread=thread), sse(*REPLY))
        asked = sent[0]['json']['messages'][0]['content'][2]['text']
        self.assertLess(asked.index('EARLIER IN THIS THREAD'), asked.index('Q: what is z?\nA: the latent.'))
        self.assertLess(asked.index('the latent.'), asked.index('QUESTION:\nand its prior?'))
        self.assertEqual(self.client.post('/api/chat', json=self.body(thread=thread * 5)).status_code, 422)

    def test_check_can_be_followed_up(self):
        thread = [{'mode': 'check', 'answer': 'step 1 ✓\n```latex\na=b\n```'}]
        reply, sent = self.chat(self.body(text='rename a to c', note='a=b', thread=thread), sse(*REPLY))
        asked = sent[0]['json']['messages'][0]['content'][2]['text']
        self.assertLess(asked.index('CHECK REQUEST: check the note\nA: step 1'), asked.index('QUESTION:\nrename a to c'))
        reply, sent = self.chat(self.body(mode='check', text='again', note='c=b', thread=thread), sse(*REPLY))
        asked = sent[0]['json']['messages'][0]['content'][2]['text']
        self.assertLess(asked.index('EARLIER IN THIS THREAD'), asked.index("CHECK REQUEST: check the user's note"))
        self.assertIn('again', asked)

    def test_usage_log(self):
        self.chat(self.body(text='why?'), sse(*REPLY, cached=1024))
        self.assertEqual(self.client.post('/api/event', json={'kind': 'link_on', 'lecture': 'Lecture1', 'page': 2}).status_code, 200)
        self.assertEqual(self.client.post('/api/event', json={'kind': 'Bad Kind!'}).status_code, 422)
        chat, ui = [json.loads(line) for line in (Path(self.temp.name) / 'logs/events.jsonl').read_text().splitlines()]
        self.assertEqual((chat['kind'], chat['question'], chat['error'], chat['hires']), ('chat', 'why?', None, False))
        self.assertIn('w_{t+1}', chat['answer'])
        self.assertEqual(chat['usage'], {'input_tokens': 300, 'cache_read_input_tokens': 1024, 'output_tokens': 20})
        self.assertEqual((ui['kind'], ui['page']), ('link_on', 2))

    def test_ui_event_reserved_fields_do_not_break_logging(self):
        reply = self.client.post('/api/event', json={
            'kind': 'selection_added_to_note', 'lecture': 'Lecture1', 'page': 3,
            'data': {'page': 2, 'lecture': 'other', 'kind': 'other', 'text': 'kept'}})
        self.assertEqual(reply.status_code, 200)
        saved = json.loads((tutor.DATA / 'logs/events.jsonl').read_text())
        self.assertEqual((saved['kind'], saved['lecture'], saved['page'], saved['text']),
                         ('selection_added_to_note', 'Lecture1', 3, 'kept'))
        with patch.object(tutor.Path, 'open', side_effect=OSError('read only')):
            self.assertEqual(self.client.post('/api/event', json={'kind': 'link_on'}).status_code, 200)

    def test_check_requires_note(self):
        self.assertEqual(self.client.post('/api/chat', json=self.body(mode='check', text='')).status_code, 422)
        reply, sent = self.chat(self.body(mode='check', text='', note='x = 1'), sse(*REPLY))
        self.assertIn('CHECK REQUEST', sent[0]['json']['messages'][0]['content'][2]['text'])
        self.assertEqual(self.client.post('/api/chat', json=self.body(text='  ')).status_code, 422)

    def test_reject_missing_and_bad_images(self):
        body = self.body(); del body['image_hires']
        self.assertEqual(self.client.post('/api/chat', json=body).status_code, 422)
        body = self.body(image_hires='data:image/png;base64,AAAA')
        self.assertEqual(self.client.post('/api/chat', json=body).status_code, 422)

    def test_errors_are_reported(self):
        reply, _ = self.chat(self.body(), httpx.Response(401, text='auth failed'))
        self.assertIn('auth failed', reply.text); self.assertIn('"error"', reply.text)
        reply, _ = self.chat(self.body(), 'event: error\ndata: {"type": "error", "error": {"message": "overloaded"}}\n\n')
        self.assertIn('overloaded', reply.text)

    def test_proxies_started_when_down(self):
        def down(request): raise httpx.ConnectError('refused')
        started = []
        class Done:
            async def wait(self): return 0
        async def spawn(*args, **kwargs): started.append(args); return Done()
        with patch.object(tutor, 'transport', httpx.MockTransport(down)), patch.dict(os.environ, {'SLIDE_TUTOR_START_CMD': '~/bin/start-endpoint --quiet'}), patch.object(tutor.asyncio, 'create_subprocess_exec', side_effect=spawn):
            reply = self.client.post('/api/chat', json=self.body())
        self.assertEqual(started[0], (str(Path.home() / 'bin/start-endpoint'), '--quiet'))
        self.assertIn("Can't reach the model endpoint", reply.text)

    def test_proxies_skipped_without_start_command(self):
        with patch.dict(os.environ, {'SLIDE_TUTOR_START_CMD': ''}), patch.object(tutor.asyncio, 'create_subprocess_exec') as spawn:
            asyncio.run(tutor.ensure_proxies())
        spawn.assert_not_called()

    def test_optional_api_key(self):
        with patch.dict(os.environ, {'SLIDE_TUTOR_API_KEY': 'test-key'}):
            reply, sent = self.chat(self.body(), sse(*REPLY))
        self.assertIn('"done"', reply.text)
        self.assertEqual(sent[0]['headers']['x-api-key'], 'test-key')
        with patch.dict(os.environ, {'SLIDE_TUTOR_API_KEY': ''}):
            _, sent = self.chat(self.body(), sse(*REPLY))
        self.assertNotIn('x-api-key', sent[0]['headers'])
        with patch.dict(os.environ, {'SLIDE_TUTOR_API_KEY': ''}), patch.object(tutor, 'ROUTER', 'https://api.anthropic.com'):
            reply, sent = self.chat(self.body())
        self.assertIn('Set API Key', reply.text); self.assertEqual(sent, [])

    def proposal(self, changes=None, **fields):
        value = {'scope': 'multiple', 'intent': 'Move note to p.5', 'summary': 'Move p.2 to p.5',
                 'changes': changes or [{'page': 2, 'text': ''}, {'page': 5, 'text': 'existing\nsource'}], **fields}
        return 'Review this move.\n```note-proposal\n' + json.dumps(value) + '\n```'

    def events(self, response):
        return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]

    def test_notes_lookup_and_complete_snapshots(self):
        tutor.write_notes('Lecture1', {2: 'stale on disk', 5: 'existing', 8: 'unrelated'})
        reply, sent = self.chat(self.body(text='Move note to p.5', note='source'),
                                sse('[[NOTES 2, 5, 6]]\n[[PAGES 5-6]]'), sse(self.proposal()))
        self.assertEqual(len(sent), 2)
        asked = sent[1]['json']['messages'][0]['content'][2]['text']
        self.assertIn('USER\'S COMPLETE NOTE p.5', asked)
        self.assertIn('[empty note]', asked)
        self.assertIn('NOTE INDEX', asked)
        self.assertNotIn('stale on disk', asked)
        proposal = next(e['proposal'] for e in self.events(reply) if e['type'] == 'proposal')
        self.assertEqual([c['before'] for c in proposal['changes']], ['source', 'existing'])
        self.assertEqual(tutor.read_notes('Lecture1')[2], 'stale on disk')  # preview never writes
        self.assertEqual(sent[0]['json']['messages'][0]['content'][:2], sent[1]['json']['messages'][0]['content'][:2])

    def test_two_lookup_rounds_and_empty_targets(self):
        reply, sent = self.chat(self.body(text='Move note to p.5', note='source'),
                                sse('[[PAGES all]]'), sse('[[NOTES 5]]'), sse(self.proposal()))
        self.assertEqual(len(sent), 3)
        self.assertIn('[empty note]', sent[2]['json']['messages'][0]['content'][2]['text'])
        self.assertIn('lookup limit reached', sent[2]['json']['messages'][0]['content'][2]['text'])
        self.assertTrue(any(e['type'] == 'proposal' for e in self.events(reply)))
        record = json.loads((tutor.DATA / 'logs/events.jsonl').read_text().splitlines()[-1])
        self.assertEqual(record['note_pages'], [5])
        self.assertEqual(len(record['retrieval_usage']), 2)

    def test_reading_notes_does_not_write_or_grant_scope(self):
        tutor.write_notes('Lecture1', {5: 'other note'})
        reply, _ = self.chat(self.body(text='Explain using p.5'), sse('[[NOTES 5]]'), sse('Explanation only.'))
        self.assertEqual(tutor.read_notes('Lecture1'), {5: 'other note'})
        self.assertFalse(any(e['type'] == 'proposal' for e in self.events(reply)))
        reply, _ = self.chat(self.body(text='clean this up', note='source'), sse('[[NOTES 5]]'), sse(self.proposal()))
        self.assertIn('intent must quote', reply.text)
        self.assertFalse(any(e['type'] == 'proposal' for e in self.events(reply)))

    def test_invalid_proposals_have_no_apply_event(self):
        body = self.body(text='Move note to p.5', note='source')
        cases = [self.proposal(scope='current'), self.proposal(intent='invented intent'),
                 self.proposal(changes=[{'page': 5, 'text': 'a'}, {'page': 5, 'text': 'b'}]),
                 self.proposal(changes=[{'page': 99, 'text': 'a'}]),
                 self.proposal(changes=[{'page': 5, 'text': '## p.3\nforged'}]),
                 self.proposal(changes=[{'page': 5, 'text': 'a' * 50001}]),
                 self.proposal(changes=[{'page': True, 'text': 'bad'}]),
                 '```note-proposal\nnot json\n```', self.proposal()[:-3],
                 self.proposal() + '\nTrailing content', self.proposal() + '\n' + self.proposal()]
        for answer in cases:
            with self.subTest(answer=answer[:80]):
                reply, _ = self.chat(body, sse('[[NOTES 5]]'), sse(answer))
                self.assertFalse(any(e['type'] in ('proposal', 'done') for e in self.events(reply)))
                self.assertIn('Invalid note proposal', reply.text)
        reply, _ = self.chat(body, sse(self.proposal()))  # uninspected destination
        self.assertIn('uninspected', reply.text)

    def test_current_scope_and_lookup_limits(self):
        reply, _ = self.chat(self.body(note='old', text='clean this up'),
                             sse(self.proposal(scope='current', intent='', changes=[{'page': 2, 'text': 'clean'}])))
        self.assertTrue(any(e['type'] == 'proposal' for e in self.events(reply)))
        self.assertEqual(tutor.wants('[[NOTES all]]', 3), (False, [], [1, 2, 3]))
        self.assertEqual(tutor.wants('[[NOTES 1-2, 99]] [[HIRES]]', 3), (True, [], [1, 2]))
        self.assertIsNone(tutor.wants('[[NOTES bad]]', 3))
        reply, sent = self.chat(self.body(), sse('[[NOTES 5]]'), sse('[[NOTES 5]]'))
        self.assertEqual(len(sent), 2); self.assertIn('Repeated context request', reply.text)
        reply, sent = self.chat(self.body(), sse('[[NOTES 5]]'), sse('[[NOTES 6]]'), sse('[[NOTES 7]]'))
        self.assertEqual(len(sent), 3); self.assertIn('lookup limit reached', reply.text)
        tutor.write_notes('Lecture1', {5: 'oversize'})
        with patch.object(tutor, 'NOTE_CONTEXT_LIMIT', 3):
            reply, sent = self.chat(self.body(), sse('[[NOTES 5]]'))
        self.assertEqual(len(sent), 1); self.assertIn('context limit', reply.text)
        self.assertNotIn('"proposal"', reply.text)

    def test_incomplete_model_stream_cannot_offer_changes(self):
        reply, _ = self.chat(self.body(), sse(self.proposal()).split('event: message_stop')[0])
        self.assertIn('stream ended early', reply.text)
        self.assertFalse(any(e['type'] in ('proposal', 'done') for e in self.events(reply)))
        stopped = sse(self.proposal()).replace('"output_tokens": 20}', '"output_tokens": 20}, "delta": {"stop_reason": "max_tokens"}')
        reply, _ = self.chat(self.body(), stopped)
        self.assertIn('did not complete', reply.text)

    def test_atomic_batch_move_backup_and_undo(self):
        tutor.write_notes('Lecture1', {2: 'source', 5: 'existing', 8: 'unrelated'})
        original = tutor.notes_path('Lecture1').read_bytes()
        changes = [{'page': 2, 'before': 'source', 'text': ''}, {'page': 5, 'before': 'existing', 'text': 'existing\nsource'}]
        url = '/api/lectures/Lecture1/notes/batch'
        reply = self.client.post(url, json={'changes': changes})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json()['notes'], {'2': '', '5': 'existing\nsource'})
        self.assertEqual(tutor.read_notes('Lecture1'), {5: 'existing\nsource', 8: 'unrelated'})
        backups = list((tutor.DATA / 'notes/backups').glob('*.md'))
        self.assertEqual(len(backups), 1); self.assertEqual(backups[0].read_bytes(), original)
        inverse = [{'page': c['page'], 'before': c['text'], 'text': c['before']} for c in changes]
        self.assertEqual(self.client.post(url, json={'changes': inverse}).status_code, 200)
        self.assertEqual(tutor.notes_path('Lecture1').read_bytes(), original)
        self.assertEqual(self.client.post(url, json={'changes': inverse}).status_code, 409)

    def test_batch_split_conflict_is_all_or_nothing(self):
        tutor.write_notes('Lecture1', {2: 'first\nsecond\nthird', 5: 'existing', 8: 'untouched'})
        changes = [{'page': 2, 'before': 'first\nsecond\nthird', 'text': 'first'},
                   {'page': 5, 'before': 'existing', 'text': 'existing\nsecond'}, {'page': 6, 'before': '', 'text': 'third'}]
        url = '/api/lectures/Lecture1/notes/batch'
        self.assertEqual(self.client.post(url, json={'changes': changes}).status_code, 200)
        self.client.put('/api/lectures/Lecture1/notes/5', json={'text': 'new external edit'})
        before = tutor.notes_path('Lecture1').read_bytes()
        inverse = [{'page': c['page'], 'before': c['text'], 'text': c['before']} for c in changes]
        response = self.client.post(url, json={'changes': inverse})
        self.assertEqual(response.status_code, 409); self.assertIn('p.5', response.text)
        self.assertEqual(tutor.notes_path('Lecture1').read_bytes(), before)
        self.assertEqual(tutor.read_notes('Lecture1')[8], 'untouched')

    def test_batch_validation_and_write_failures(self):
        url = '/api/lectures/Lecture1/notes/batch'
        change = {'page': 2, 'before': '', 'text': 'new'}
        for changes in [[], [change, change], [{**change, 'page': 99}], [{**change, 'text': '## p.3\nno'}]]:
            self.assertEqual(self.client.post(url, json={'changes': changes}).status_code, 422)
        self.assertEqual(self.client.put('/api/lectures/Lecture1/notes/2', json={'text': '## p.3\nno'}).status_code, 422)
        tutor.write_notes('Lecture1', {8: 'unchanged'})
        before = tutor.notes_path('Lecture1').read_bytes()
        with TestClient(tutor.app, raise_server_exceptions=False) as client:
            with patch.object(tutor, 'write_notes', side_effect=OSError('disk full')):
                self.assertEqual(client.post(url, json={'changes': [change]}).status_code, 500)
            with patch.object(Path, 'write_bytes', side_effect=OSError('backup unavailable')):
                self.assertEqual(client.post(url, json={'changes': [change]}).status_code, 500)
        self.assertEqual(tutor.notes_path('Lecture1').read_bytes(), before)

    def test_cross_origin_rejected(self):
        reply = self.client.put('/api/lectures/Lecture1/notes/1', json={'text': 'x'}, headers={'Origin': 'https://example.com'})
        self.assertEqual(reply.status_code, 403)
        self.assertEqual(self.client.get('/', headers={'Host': 'attacker.example'}).status_code, 400)


if __name__ == '__main__': unittest.main()
