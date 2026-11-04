# slide-tutor — notes for agents

See README.md for what the app does. This file covers what the user doesn't see.
`run.sh` launches `tray.py`; courses come from `~/Library/Application Support/slide-tutor/courses.json`. Each course keeps data in `<parent of slides>/slide-tutor/data`; paths below are relative to that folder.

## Usage log (for improving the tutor)
`data/logs/events.jsonl`: append-only, one JSON object per line, local only, never shown in the UI.
Written by `log()` in app.py; the page posts UI events through `track()` in static/app.js → `POST /api/event`.
Every line has `ts` (local ISO time), `kind`, `lecture`, `page`.

| kind | extra fields | meaning |
|---|---|---|
| `chat` | `mode` (ask/check), `question`, `note`, `thread` (earlier turns if linked: `mode`, `question`, `answer`; a check can be followed up too), `response_lang`, `note_lang`, `model`, `answer`, `error` (null = ok, `"cancelled"` = browser left), `seconds`, `hires` (model asked for the 1600px image), `pages` (pages whose text it asked for; either one means 2 calls), `usage` (final call: `input_tokens` uncached, `cache_read_input_tokens`, `output_tokens`), `first_usage` (first call when it asked for more) | one tutor request (before 2026-11-03 also `cost_usd`) |
| `suggested_note_added` / `suggested_note_undone` | `text` | the AI's suggested note was kept / reverted |
| `check_fix_applied` / `check_fix_undone` | `text` | Check note's cleaned LaTeX was applied / reverted |
| `selection_added_to_note` | `text` | user copied part of an answer into the note |
| `slide_text_asked` | `quote` | user asked about selected slide text |
| `note_lines_deleted` / `note_delete_undone` | `lines` | user deleted note lines / undid it (also undoes a move) |
| `note_lines_moved` | `lines`, `to` | user dragged selected note lines to line index `to` (in the old numbering) |
| `link_on` / `link_off` | | follow-up thread toggled |

Useful signals: undone suggestions or fixes (bad output), follow-up questions right after an answer (unclear answer),
long `seconds` or non-null `error`, which pages get asked about most. Correlate by `lecture` + `page` + `ts`.

```sh
jq -c 'select(.kind=="chat") | {ts, page, mode, question, error, seconds}' data/logs/events.jsonl
jq -r '.kind' data/logs/events.jsonl | sort | uniq -c
```

Keep logging silent (no UI) and make sure it never breaks a request. If you add a UI action worth learning from,
`track('<snake_case_kind>', {...})` it and add a row above.
