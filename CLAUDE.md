# slide-tutor — notes for agents

See README.md for what the app does. This file covers what the user doesn't see.
`run.sh` launches `tray.py`; courses come from `~/Library/Application Support/slide-tutor/courses.json`. Each course keeps data in `<parent of slides>/slide-tutor/data`; paths below are relative to that folder.
On Windows, `run.cmd` launches `tray_win.py` (config in `%APPDATA%\slide-tutor`). It sets `PYTHONUTF8=1` for the servers because app.py reads files with the default encoding; keep that unless app.py passes `encoding` everywhere. `tests/test_tray.py` is macOS-only (it imports rumps).

## Feature documentation
- Update the user manual in README.md whenever implementing a user-facing feature, in the same change.
- Do not add new screenshots or images during implementation for now. If a feature needs an illustration, leave an English TODO placeholder instead; generate the needed images when preparing a user-authorized GitHub push.

## Tests
Run `.venv/bin/python -m unittest discover -s tests` and `node --test tests/*.cjs`.
The optional `tests/browser_*.js` checks require a disposable Review sandbox course; see README.md and each script's header. Never use real course notes or paid model calls.

## Reader note gestures
- The user explicitly authorized both formerly deferred gesture fixes on 2026-11-07.
- A plain click on a line edits it (the user rejected a per-line Edit button on 2026-11-07 as visually heavy). Decide on click, never mousedown, and skip editing when the pointer moved (text drag), when the click only clears an existing selection, or when it is part of a double-click (edit waits ~250 ms so native word selection survives). Enter edits the first selected line. Leaving an editor must not rebuild the line under the new click or selection.
- Drag selected lines with their dedicated handle, not the text. Auto-scroll only the notes panel at its top/bottom edges, refresh the drop marker while scrolling, and stop on exit, cancellation, navigation, or drag end.
- Keep multi-line selection, deferred Cut, atomic cross-page moves, and Undo intact. Test with disposable notes; do not touch existing services or real course notes.

## Note scope and transactions
- Vague requests default to the current page; infer cross-page edits only from clear intent in the current user's request. Reading notes from other pages never grants editing permission.
- Cross-page proposals are previews, not direct model writes. Validate complete inspected snapshots server-side, then require explicit review/apply. Apply and inverse undo share the per-lecture lock with single-page saves; never bypass conflict checks or split a move into separate writes.
- Keep autosaves serialized and drained before chat/batch writes. Test with temporary notes and mocked model replies, not the user's course notes or paid calls.

## Usage log (for improving the tutor)
`data/logs/events.jsonl`: append-only, one JSON object per line, local only, never shown in the UI.
Written by `log()` in app.py; UI events use `track()` in static/app.js and the note modules → `POST /api/event`.
Every line has `ts` (local ISO time), `kind`, `lecture`, `page`.

| kind | extra fields | meaning |
|---|---|---|
| `chat` | `mode` (ask/check), `question`, `note`, `thread` (earlier turns if linked: `mode`, `question`, `answer`; a check can be followed up too), `response_lang`, `note_lang`, `model`, `answer`, `error` (null = ok, `"cancelled"` = browser left), `seconds`, `hires` (model asked for the 1600px image), `pages` (requested slide text), `note_pages` (requested complete notes; up to two lookup rounds), `usage` (final call: `input_tokens` uncached, `cache_read_input_tokens`, `output_tokens`), `first_usage` (first lookup call), `retrieval_usage` (all lookup-call usage) | one tutor request (before 2026-11-03 also `cost_usd`) |
| `suggested_note_added` / `suggested_note_undone` | `text` | the AI's suggested note was kept / reverted |
| `check_fix_applied` / `check_fix_undone` | `text` | Check note's cleaned LaTeX was applied / reverted |
| `selection_added_to_note` | `text` | user copied part of an answer into the note |
| `slide_text_asked` | `quote` | user asked about selected slide text |
| `note_lines_deleted` | `lines` (source text) | user deleted selected note lines |
| `note_delete_undone` | | user undid a delete or drag move |
| `note_lines_moved` | `lines`, `to` | user dragged selected note lines to line index `to` (in the old numbering) |
| `note_lines_cut_pending` | `lines` | user marked source line indices for a deferred cut; no note was changed |
| `note_clipboard_pasted` | `pages`, `moved` | user pasted copied lines or committed an atomic deferred move |
| `note_clipboard_undone` | `pages` | user atomically undid the last rendered-line paste/move |
| `note_formatted` | `format` | user applied emphasis, a marker color, or cleared a highlight |
| `note_batch_applied` / `note_batch_undone` | `pages` | user applied / undid a reviewed atomic note transaction |
| `note_proposal_cancelled` | | user clicked Cancel on a preview or Dismiss Undo on an applied proposal; no note write |
| `link_on` / `link_off` | | follow-up thread toggled |

Useful signals: undone suggestions or fixes (bad output), follow-up questions right after an answer (unclear answer),
long `seconds` or non-null `error`, which pages get asked about most. Correlate by `lecture` + `page` + `ts`.

```sh
jq -c 'select(.kind=="chat") | {ts, page, mode, question, error, seconds}' data/logs/events.jsonl
jq -r '.kind' data/logs/events.jsonl | sort | uniq -c
```

Keep logging silent (no UI) and make sure it never breaks a request. If you add a UI action worth learning from,
`track('<snake_case_kind>', {...})` it and add a row above.
