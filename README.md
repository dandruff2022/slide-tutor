# slide-tutor

A local course slide reader with per-page notes and an AI tutor that sees the slide you're on. macOS, runs from the menu bar.

![Asking about a slide](docs/ask.jpg)

*Check note reviews the current page's note step by step:*

![Checking a note](docs/check-note.jpg)

## Setup
Requires macOS and Python 3.10+.

```sh
git clone https://github.com/dandruff2022/slide-tutor.git
cd slide-tutor
./run.sh
```

`run.sh` creates `.venv`, installs the requirements and starts the menu bar app (a small book icon).
Then, from the icon: **Set API Key…** (an [Anthropic API key](https://console.anthropic.com/)) and **Add Slides Folder…**.

## Menu bar
- **Add Slides Folder…**: pick a folder of lecture PDFs. Each course gets its own local server (ports from 8765 up);
  its lectures are the folder's PDFs (names without spaces, e.g. `Lecture3.pdf` or `Lecture3_Transformers.pdf`),
  ordered by the first number in the name. Notes, cache and logs go in `slide-tutor/data/` next to the slides folder.
- **<course> → Open** opens it in the browser; **Remove** forgets the course (its notes stay on disk).
- **Set API Key…** saves the key and restarts the courses.
- **Launch at Login** starts the menu bar app (and all courses) when you log in.

Courses are remembered in `~/Library/Application Support/slide-tutor/courses.json`; the course name (used in the
tutor's prompt) defaults to the slides folder's parent folder name and can be edited there.

## Model endpoint
By default the tutor calls the Anthropic API with your key, choosing between Claude Sonnet 5.5 and Claude Haiku 4.5
in the **🌐** menu (remembered per browser). To use another Anthropic-compatible endpoint (e.g. a LiteLLM proxy) or
other models, add `KEY=VALUE` lines to `~/Library/Application Support/slide-tutor/env` and restart the menu bar app:

```sh
SLIDE_TUTOR_ROUTER=http://127.0.0.1:4000          # endpoint base URL (POST /v1/messages, streamed)
SLIDE_TUTOR_MODELS=model-a=Model A,model-b=Model B  # choices in the 🌐 menu (id=Label,...)
SLIDE_TUTOR_MODEL=model-a                         # default choice
SLIDE_TUTOR_START_CMD=~/bin/start-my-proxy        # optional: run when the endpoint is down
```

## Layout
- **Slide** (left): lecture dropdown, ← → buttons, arrow keys (←↑ previous, →↓ next) or a two-finger scroll / mouse wheel over the slide (one page per gesture). **⌘F** searches every page of the lecture: typing jumps to the first matching page, Enter / Shift+Enter = next / previous match, Esc clears; matches are highlighted on the slide.
- **Notes** (right): one note per lecture, grouped by page. Click a `p.N` heading to jump there. On the current page, click any line to edit just that line (others stay rendered); Enter = new line, Backspace at line start = join, ↑/↓ = move between lines, Esc or click away = done. Drag across lines to select them (touched lines are tinted red): Backspace/Delete removes them, ⌘X / ⌘C cut / copy them as source, dragging the tinted lines moves them (a green line marks where they land), ⌘Z restores the last delete or move. A line with LaTeX (`\`, `^`, `_`) and no `$` renders as display math. Saved to `slide-tutor/data/notes/LectureN.md` next to the slides folder under `## p.N` headings.
- **Add to note**: select text in the response → button at the response panel's top-right appends it to the current page's note (math kept as LaTeX, one equation per line).
- **Prompt** (bottom right): Enter = **Ask**, Shift+Enter = newline, ↑/↓ = previous prompts. **Check note** reviews the current page's note step by step (anything typed in the prompt is sent along, e.g. "is step 3 right?") and offers **Apply to note** (cleaned LaTeX) with **Undo**. **🌐** sets the response language and the note language separately (English / Simplified Chinese). For questions worth keeping, the tutor may end with a **Suggested note** with **Add to note** (appends) and **Undo**.
- **Response** (bottom left): latest answer only. Each request is standalone (no memory, nothing saved); it includes the current slide as a ~1000px image, the extracted text of it and its neighbors, and the current page's note. The page part (text + image) comes before the question and every request carries the same per-course session id, so repeat questions on a page reuse the provider's prompt cache (`cache_read_input_tokens` in the log). Before answering, the model may ask once for more (its reply is hidden): `[[HIRES]]` = the slide at 1600px, `[[PAGES 3-9]]` / `[[PAGES all]]` = the extracted text of those pages, divided by `--- p.N ---`. The server then asks again with that added; the status line shows what it's reading.
- **🔗** (between response and prompt): grey until there's an answer. Click to link: both panels get a green border, and the next question follows up on the answers shown (they stay on screen; the last 4 Q&A are sent as text, kept only in the page). Click again, flip the page, or switch lecture to go back to standalone. A Check note answer can be followed up too: link and ask for a small change ("only rename x to y"), and the reply ends with the whole edited note plus **Apply to note**. Check note while linked re-checks within the thread.

Tutor behavior: `prompts/system.md`. Tests: `.venv/bin/python -m unittest discover -s tests`.

## Credits
Demo slides in the screenshots: MIT 6.7960 Deep Learning, Fall 2024, Lecture 3 "Approximation Theory" by Jeremy
Bernstein, Phillip Isola and Sara Beery, [MIT OpenCourseWare](https://ocw.mit.edu/courses/6-7960-deep-learning-fall-2024/),
licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Code: MIT License.
