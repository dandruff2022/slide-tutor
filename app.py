"""Local slide tutor: stateless model endpoint calls grounded in the current slide and its note."""
import asyncio
import base64
import json
import os
import re
import shlex
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader
from starlette.middleware.trustedhost import TrustedHostMiddleware

ROOT = Path(__file__).resolve().parent
# One code base, several courses: tray.py sets its own slides folder, data folder, name and port.
SLIDES = Path(os.getenv("SLIDE_TUTOR_SLIDES", str(ROOT.parent / "slides")))
DATA = Path(os.getenv("SLIDE_TUTOR_DATA", str(ROOT / "data")))
COURSE = os.getenv("SLIDE_TUTOR_COURSE", "this course")
for folder in (DATA / "cache", DATA / "notes"):
    folder.mkdir(parents=True, exist_ok=True)
# Model calls go to the Anthropic API or any Anthropic-compatible endpoint. Gateways that key their prompt cache on a
# session id get a fixed one per course, so questions on a page reuse the cached prompt and slide.
ROUTER = os.getenv("SLIDE_TUTOR_ROUTER", "https://api.anthropic.com")
MODEL = os.getenv("SLIDE_TUTOR_MODEL", "claude-sonnet-5-5")
# Model menu choices: SLIDE_TUTOR_MODELS="id=Label,id=Label"; ids must match the endpoint.
MODELS = dict(item.split("=", 1) if "=" in item else (item, item) for item in
              os.getenv("SLIDE_TUTOR_MODELS", "claude-sonnet-5-5=Claude Sonnet 5.5,claude-haiku-4-5-20251001=Claude Haiku 4.5").split(","))
MODELS.setdefault(MODEL, MODEL)
CACHE_SESSION = str(uuid.uuid5(uuid.NAMESPACE_URL, f"slide-tutor/{COURSE}"))
transport = None  # tests swap in an httpx.MockTransport
app = FastAPI()
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


@app.middleware("http")
async def local_requests(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("origin") not in (None, f"http://127.0.0.1:{os.getenv('PORT', '8765')}", f"http://localhost:{os.getenv('PORT', '8765')}"):
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site requests are not allowed."}, status_code=403)
    if int(request.headers.get("content-length", "0")) > 25_000_000:
        return JSONResponse({"detail": "Request exceeds 25 MB."}, status_code=413)
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"  # revalidate (etag), so edits show up on reload
    return response


def lecture_path(lecture: str) -> Path:
    if not re.fullmatch(r"\w[\w.\-]{0,79}", lecture) or not (SLIDES / f"{lecture}.pdf").is_file():
        raise HTTPException(404, "Unknown lecture")
    return SLIDES / f"{lecture}.pdf"


def label(lecture):
    """Lecture12 -> Lecture 12, 13_MPI_examples -> 13 MPI examples."""
    return re.sub(r"^Lecture(?=\d)", "Lecture ", lecture).replace("_", " ")


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(path)


cache_lock = threading.Lock()


def metadata(lecture):
    with cache_lock:
        return build_metadata(lecture)


def build_metadata(lecture):
    path = lecture_path(lecture)
    cache = DATA / "cache" / f"{lecture}.json"
    stamp = [path.stat().st_mtime_ns, path.stat().st_size]
    if cache.exists():
        saved = json.loads(cache.read_text())
        if saved.get("stamp") == stamp:
            return saved
    texts = [(page.extract_text() or "") for page in PdfReader(path).pages]
    result = {"stamp": stamp, "pages": len(texts), "texts": texts,
              "outline": [{"page": i + 1, "heading": next((s.strip()[:180] for s in text.splitlines() if s.strip()), "[Image-only page]")} for i, text in enumerate(texts)]}
    atomic_json(cache, result)
    return result


def checked_page(meta, page):
    if not 1 <= page <= meta["pages"]:
        raise HTTPException(422, "Page outside lecture")


def notes_path(lecture):
    lecture_path(lecture)
    return DATA / "notes" / f"{lecture}.md"


def read_notes(lecture):
    """Notes are one markdown file per lecture with a `## p.N` heading per page."""
    path = notes_path(lecture)
    parts = re.split(r"^## p\.(\d+)[ \t]*$", path.read_text() if path.exists() else "", flags=re.M)
    return {int(parts[i]): parts[i + 1].strip("\n") for i in range(1, len(parts) - 1, 2)}


note_locks = {}
note_locks_guard = threading.Lock()


def note_lock(lecture):
    with note_locks_guard:
        return note_locks.setdefault(lecture, threading.Lock())


def note_value(text):
    return text.strip("\n") if text.strip() else ""


def write_notes(lecture, notes):
    text = "".join(f"## p.{page}\n{body.strip(chr(10))}\n\n" for page, body in sorted(notes.items()) if body.strip())
    path = notes_path(lecture)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text)
    temporary.replace(path)


@app.get("/api/lectures")
def lectures():
    def order(path):  # by the first number in the file name (1, 1.5, 2, ... 10), then by name
        number = re.search(r"\d+(?:\.\d+)?", path.stem)
        return (float(number.group()) if number else float("inf"), path.stem)
    return [{"id": path.stem, "label": label(path.stem)} for path in sorted(SLIDES.glob("*.pdf"), key=order)
            if re.fullmatch(r"\w[\w.\-]{0,79}", path.stem)]


@app.get("/api/lectures/{lecture}/outline")
def outline(lecture: str):
    meta = metadata(lecture)
    return {"lecture": lecture, "pages": meta["pages"], "outline": meta["outline"]}


@app.get("/api/lectures/{lecture}/pages/{page}/text")
def page_text(lecture: str, page: int):
    meta = metadata(lecture)
    checked_page(meta, page)
    return {"page": page, "label": "noisy extracted text, trust the image for math", "text": meta["texts"][page - 1]}


@app.get("/api/lectures/{lecture}/notes")
def get_notes(lecture: str):
    return read_notes(lecture)


class Note(BaseModel):
    text: str = Field(default="", max_length=50000)
    before: str | None = Field(default=None, max_length=50000)


@app.put("/api/lectures/{lecture}/notes/{page}")
def put_note(lecture: str, page: int, body: Note):
    checked_page(metadata(lecture), page)
    if re.search(r"^## p\.\d+[ \t]*$", body.text, re.M):
        raise HTTPException(422, "Page headings belong outside the note body.")
    with note_lock(lecture):
        notes = read_notes(lecture)
        if body.before is not None and note_value(notes.get(page, "")) != note_value(body.before):
            raise HTTPException(409, "Note changed on disk or in another tab. Copy your edits before reloading; nothing was saved.")
        notes[page] = body.text
        write_notes(lecture, notes)
    return {"ok": True}


class NoteChange(BaseModel):
    page: int = Field(strict=True)
    before: str = Field(max_length=50000)
    text: str = Field(max_length=50000)


class NoteBatch(BaseModel):
    changes: list[NoteChange] = Field(min_length=1, max_length=100)


@app.post("/api/lectures/{lecture}/notes/batch")
def batch_notes(lecture: str, body: NoteBatch):
    meta = metadata(lecture)
    pages = [change.page for change in body.changes]
    if len(set(pages)) != len(pages):
        raise HTTPException(422, "Duplicate note pages")
    for change in body.changes:
        checked_page(meta, change.page)
        if re.search(r"^## p\.\d+[ \t]*$", change.text, re.M):
            raise HTTPException(422, "Page headings belong outside the note body.")
    with note_lock(lecture):
        notes = read_notes(lecture)
        conflicts = [c.page for c in body.changes if note_value(notes.get(c.page, "")) != note_value(c.before)]
        if conflicts:
            raise HTTPException(409, f"Notes changed on {', '.join(f'p.{p}' for p in conflicts)}. Nothing was applied; request a new proposal.")
        path = notes_path(lecture)
        backup = path.parent / "backups"
        backup.mkdir(exist_ok=True)
        backup = backup / f"{lecture}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex}.md"
        # Back up the exact original file before the one atomic replacement. Failure leaves it untouched.
        backup.write_bytes(path.read_bytes() if path.exists() else b"")
        notes.update({c.page: c.text for c in body.changes})
        write_notes(lecture, notes)
    return {"ok": True, "notes": {p: note_value(notes[p]) for p in pages}}


class Turn(BaseModel):
    mode: Literal["ask", "check"] = "ask"
    question: str = Field(default="", max_length=30000)  # a check's question is its typed request, if any
    answer: str = Field(max_length=60000)


class Chat(BaseModel):
    lecture: str
    page: int
    mode: Literal["ask", "check"] = "ask"
    text: str = Field(default="", max_length=30000)
    note: str = Field(default="", max_length=50000)
    image: str = Field(max_length=6_000_000)  # current slide, ~1000px: sent first
    image_hires: str = Field(max_length=12_000_000)  # current slide, 1600px: sent only if the model asks
    response_lang: Literal["en", "zh"] = "en"
    note_lang: Literal["en", "zh"] = "en"
    thread: list[Turn] = Field(default=[], max_length=4)  # linked follow-up: earlier Q&A, oldest first
    model: str = MODEL


@app.get("/api/models")
def models():
    return {"default": MODEL, "models": [{"id": k, "label": v} for k, v in MODELS.items()]}


def validate_image(data):
    if not re.fullmatch(r"data:image/png;base64,[A-Za-z0-9+/=]+", data):
        raise HTTPException(422, "Slides must be PNG data URLs.")
    try:
        raw = base64.b64decode(data.split(",", 1)[1], validate=True)
    except ValueError:
        raise HTTPException(422, "Invalid image encoding")
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(422, "Invalid image file")


def event(kind, **values):
    return f"data: {json.dumps({'type': kind, **values})}\n\n"


# Usage log for improving the tutor later (not shown in the UI; see CLAUDE.md). Never breaks a request.
log_lock = threading.Lock()
def log(kind, **fields):
    try:
        path = DATA / "logs/events.jsonl"
        path.parent.mkdir(exist_ok=True)
        line = json.dumps({"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "kind": kind, **fields}, ensure_ascii=False)
        with log_lock, path.open("a") as f:
            f.write(line + "\n")
    except Exception:
        pass


class UiEvent(BaseModel):
    kind: str = Field(pattern=r"^[a-z_]{1,40}$")
    lecture: str = Field(default="", max_length=40)
    page: int = 0
    data: dict = {}


@app.post("/api/event")
def ui_event(body: UiEvent):
    fields = {**body.data, "lecture": body.lecture, "page": body.page}
    fields.pop("kind", None)
    log(body.kind, **fields)
    return {"ok": True}


# Request-only replies are hidden context lookups, never instructions to write notes.
WANT = r"\[\[(HIRES|(?:PAGES|NOTES) [0-9a-z ,\-]+)\]\]"
MAYBE_WANT = re.compile(r"\s*(?:\[(?:\[[A-Za-z0-9 ,\-]*(?:\]\]?)?)?\s*)*")
EXTRA_TEXT_LIMIT = 120_000
NOTE_CONTEXT_LIMIT = 120_000
PROPOSAL = re.compile(r"^```note-proposal[ \t]*\n([\s\S]*?)^```[ \t]*$", re.M)


def wants(answer, total):
    """(hires, slide pages, note pages) if the reply consists only of valid requests."""
    if not re.fullmatch(rf"\s*(?:{WANT}\s*)+", answer):
        return None
    hires, pages, notes = False, set(), set()
    for item in re.findall(WANT, answer):
        if item == "HIRES":
            hires = True
            continue
        target = notes if item.startswith("NOTES") else pages
        for part in item[6:].split(","):
            if part.strip() == "all":
                target.update(range(1, total + 1))
            elif m := re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*", part):
                target.update(range(max(1, int(m[1])), min(total, int(m[2] or m[1])) + 1))
            else:
                return None
    return hires, sorted(pages), sorted(notes)


def note_index(notes, total):
    lines = []
    for page, text in sorted(notes.items()):
        if 1 <= page <= total and text.strip():
            heading = next((s.lstrip("# ")[:90] for s in text.splitlines() if s.strip()), "")
            lines.append(f"p.{page}: {heading}")
    return ("NOTE INDEX (headings only; not full notes, not edit authorization):\n" +
            ("\n".join(lines)[:12000] or "[no saved notes]") + "\n\n")


def parse_proposal(answer, body, meta, snapshots):
    """Only complete, inspected replacements become reviewable; originals are server-owned."""
    if "```note-proposal" not in answer:
        return None
    matches = list(PROPOSAL.finditer(answer))
    if len(matches) != 1 or answer[matches[0].end():].strip():
        raise ValueError("Incomplete or multiple note proposals")
    value = json.loads(matches[0][1])
    if not isinstance(value, dict) or value.get("scope") not in ("current", "multiple"):
        raise ValueError("Invalid proposal scope")
    summary, intent = value.get("summary"), value.get("intent", "")
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 2000:
        raise ValueError("Invalid proposal summary")
    if not isinstance(intent, str) or len(intent) > 1000:
        raise ValueError("Invalid intent quote")
    if value["scope"] == "multiple" and (not intent.strip() or intent not in body.text):
        raise ValueError("Cross-page intent must quote the current user's request")
    changes = value.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
        raise ValueError("Invalid proposal changes")
    seen, checked = set(), []
    for change in changes:
        if not isinstance(change, dict):
            raise ValueError("Invalid page replacement")
        page, text = change.get("page"), change.get("text")
        if type(page) is not int or not 1 <= page <= meta["pages"] or page in seen:
            raise ValueError("Duplicate or invalid proposal page")
        if page not in snapshots or (value["scope"] == "current" and page != body.page):
            raise ValueError("Proposal includes an uninspected or out-of-scope note")
        if not isinstance(text, str) or len(text) > 50000 or re.search(r"^## p\.\d+[ \t]*$", text, re.M):
            raise ValueError("Invalid note replacement text")
        seen.add(page)
        checked.append({"page": page, "before": snapshots[page], "text": note_value(text)})
    if sum(len(c["text"]) for c in checked) > NOTE_CONTEXT_LIMIT:
        raise ValueError("Proposal exceeds note size limit")
    return {"lecture": body.lecture, "scope": value["scope"], "intent": intent,
            "summary": summary, "changes": checked}


def build_content(body, meta, want=None, notes=None, snapshots=None, final_round=False):
    """Keep slide text/image as a cacheable prefix; note lookups go on the question side."""
    hires, pages = (want[0], want[1]) if want else (False, [])
    text = (f"User is viewing {label(body.lecture)}, page {body.page} of {meta['pages']}.\n"
            f"Noisy extracted text of the current page (trust the image for math):\n{meta['texts'][body.page - 1][:12000]}\n\n")
    for p in (body.page - 1, body.page + 1):
        if 1 <= p <= meta["pages"]:
            text += f"Noisy extracted text of p.{p} (adjacent context, no image):\n{meta['texts'][p - 1][:4000]}\n\n"
    image = body.image_hires if hires else body.image
    text += f"Slide p.{body.page} (CURRENT)" + (", high resolution" if hires else "") + ":"
    request = ""
    if want:
        extra = "".join(f"--- p.{p} ---\n{meta['texts'][p - 1].strip() or '[no extractable text: image-only page]'}\n" for p in pages)
        if len(extra) > EXTRA_TEXT_LIMIT:
            extra = extra[:EXTRA_TEXT_LIMIT] + "\n[truncated]\n"
        if pages:
            request += f"NOISY EXTRACTED TEXT OF THE REQUESTED PAGES (no images):\n{extra}\n"
        request += ("This is the follow-up to your request: answer now if sufficient; one more context lookup is allowed.\n\n"
                    if not final_round else "Context lookup limit reached: answer now, without further [[...]] requests.\n\n")
    request += note_index(notes or {}, meta["pages"])
    for page, content in sorted((snapshots or {}).items()):
        if page != body.page:
            request += f"USER'S COMPLETE NOTE p.{page} (context only, not permission to edit):\n{content or '[empty note]'}\nEND NOTE p.{page}\n\n"
    request += f"USER'S NOTE FOR THIS PAGE (work in progress, may be partial or wrong):\n{body.note or '[empty note]'}\n\n"
    names = {"en": "English", "zh": "Simplified Chinese"}
    request += (f"LANGUAGE: write your reply in {names[body.response_lang]}. "
                f"Plain-text lines inside any note block you write are in {names[body.note_lang]}; math stays LaTeX. "
                "These are saved preferences: if the user's question or request below asks for a language, follow that instead.\n\n")
    if body.thread:
        request += "EARLIER IN THIS THREAD (the request below follows up on this):\n"
        request += "".join((f"CHECK REQUEST: {t.question or 'check the note'}" if t.mode == "check" else f"Q: {t.question}")
                           + f"\nA: {t.answer}\n\n" for t in body.thread)
    if body.mode == "check":
        request += "CHECK REQUEST: check the user's note for this page."
        if body.text.strip():
            request += f"\nUSER'S REQUEST FOR THIS CHECK (takes priority over the default check format):\n{body.text}"
    else:
        request += f"QUESTION:\n{body.text}"
    return [{"type": "text", "text": text},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image.split(",", 1)[1]},
             "cache_control": {"type": "ephemeral", "ttl": "1h"}},  # used by Claude models; others may cache prefixes on their own
            {"type": "text", "text": request}]


def proxy_env():
    # A server launched from Claude Code is not a child agent of that session.
    return {k: v for k, v in os.environ.items() if k not in {
        "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"}}


async def ensure_proxies():
    """If the endpoint is down, run SLIDE_TUTOR_START_CMD (optional) to start it."""
    if not (command := shlex.split(os.getenv("SLIDE_TUTOR_START_CMD", ""))):
        return
    try:
        async with httpx.AsyncClient(transport=transport, timeout=2) as client:
            await client.get(ROUTER)
    except httpx.TransportError:
        process = await asyncio.create_subprocess_exec(os.path.expanduser(command[0]), *command[1:], env=proxy_env(),
                                                       stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(process.wait(), 60)


async def stream_reply(content, usage, model):
    """One streamed /v1/messages call: yields text deltas and fills `usage`."""
    body = {"model": model, "max_tokens": 16000, "stream": True, "output_config": {"effort": "medium"},
            "system": (ROOT / "prompts/system.md").read_text().replace("{COURSE}", COURSE),
            "messages": [{"role": "user", "content": content}]}
    headers = {"anthropic-version": "2023-06-01", "x-claude-code-session-id": CACHE_SESSION}
    if key := os.getenv("SLIDE_TUTOR_API_KEY"):
        headers["x-api-key"] = key
    elif "api.anthropic.com" in ROUTER:
        raise RuntimeError("No API key yet: choose Set API Key… in the menu bar.")
    async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(300, connect=5)) as client:
        async with client.stream("POST", f"{ROUTER}/v1/messages", json=body, headers=headers) as response:
            if response.status_code != 200:
                detail = (await response.aread()).decode(errors="replace")[:4000]
                raise RuntimeError(f"model endpoint returned {response.status_code}: {detail}")
            complete = False
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                item = json.loads(line[6:])
                if item.get("type") == "message_start":
                    usage.update(item.get("message", {}).get("usage") or {})
                elif item.get("type") == "message_delta":
                    usage.update(item.get("usage") or {})
                    if item.get("delta", {}).get("stop_reason") in ("max_tokens", "refusal"):
                        raise RuntimeError("The model did not complete its answer. No note changes are available.")
                elif item.get("type") == "message_stop":
                    complete = True
                elif item.get("type") == "error":
                    raise RuntimeError(item.get("error", {}).get("message") or "model error")
                elif item.get("type") == "content_block_delta" and item.get("delta", {}).get("type") == "text_delta":
                    yield item["delta"]["text"]
            if not complete:
                raise RuntimeError("The model stream ended early. No note changes are available.")


@app.post("/api/chat")
async def chat(body: Chat):
    meta = await asyncio.to_thread(metadata, body.lecture)
    checked_page(meta, body.page)
    if body.mode == "check" and not body.note.strip():
        raise HTTPException(422, "Write a note for this page before checking it.")
    if body.mode == "ask" and not body.text.strip():
        raise HTTPException(422, "Type a question first.")
    if body.model not in MODELS:
        raise HTTPException(422, "Unknown model")
    validate_image(body.image)
    validate_image(body.image_hires)
    notes = await asyncio.to_thread(read_notes, body.lecture)
    notes[body.page] = note_value(body.note)

    async def generate():
        answer, error, started = "", "cancelled", asyncio.get_running_loop().time()
        want, usage, first = None, {}, None
        snapshots, requested_notes, retrieval_usage = {body.page: notes[body.page]}, set(), []
        try:
            await ensure_proxies()
            for attempt in range(3):  # at most two lookups, then a final answer
                usage, held, answer = {}, True, ""
                async for text in stream_reply(build_content(body, meta, want, notes, snapshots, attempt == 2), usage, body.model):
                    answer += text
                    if not held:
                        yield event("delta", text=text)
                    elif len(answer) > 300 or not MAYBE_WANT.fullmatch(answer):
                        held = False
                        yield event("delta", text=answer)
                lookup = wants(answer, meta["pages"])
                if lookup:
                    if attempt == 2:
                        raise RuntimeError("Context lookup limit reached; ask a more specific question.")
                    hires, pages, note_pages = lookup
                    old_hires, old_pages = (want[0], set(want[1])) if want else (False, set())
                    new_notes = [p for p in note_pages if p not in snapshots]
                    if not ((hires and not old_hires) or set(pages) - old_pages or new_notes):
                        raise RuntimeError("Repeated context request; no new context was requested.")
                    for p in new_notes:
                        text = notes.get(p, "")
                        if len(text) > 50000 or sum(len(v) for v in snapshots.values()) + len(text) > NOTE_CONTEXT_LIMIT:
                            raise RuntimeError("Requested notes exceed the context limit. Request fewer pages; no notes were changed.")
                        snapshots[p] = text
                    requested_notes.update(note_pages)
                    want = (hires or old_hires, sorted(old_pages | set(pages)))
                    first = first or usage
                    retrieval_usage.append(usage)
                    reading = (["the slide at high resolution"] if hires else []) + \
                              ([f"the text of {len(pages)} page{'s' * (len(pages) > 1)}"] if pages else []) + \
                              ([f"notes on {', '.join(f'p.{p}' for p in note_pages)}"] if note_pages else [])
                    yield event("status", message=f"Reading {' and '.join(reading)}…")
                    continue
                if held and answer:
                    yield event("delta", text=answer)
                break
            if not answer.strip():
                raise RuntimeError("The model returned no text.")
            try:
                proposal = parse_proposal(answer, body, meta, snapshots)
            except (ValueError, TypeError) as exc:
                raise RuntimeError(f"Invalid note proposal: {exc}. Nothing was applied.") from exc
            if proposal:
                yield event("proposal", proposal=proposal)
            error = None
            yield event("done")
        except httpx.TimeoutException:
            error = "The model timed out. Check the model endpoint/authentication."
            yield event("error", message=error)
        except httpx.TransportError as exc:
            error = f"Can't reach the model endpoint at {ROUTER} ({exc}). Check the model endpoint/authentication."
            yield event("error", message=error)
        except Exception as exc:
            error = f"Chat failed: {str(exc)[:12000]}"
            yield event("error", message=error)
        finally:  # error stays "cancelled" if the browser disconnected (the stream is closed with the generator)
            log("chat", lecture=body.lecture, page=body.page, mode=body.mode, question=body.text, note=body.note,
                thread=[t.model_dump() for t in body.thread], response_lang=body.response_lang, note_lang=body.note_lang,
                model=body.model, answer=answer, error=error, seconds=round(asyncio.get_running_loop().time() - started, 1),
                hires=bool(want and want[0]), pages=want[1] if want else [], note_pages=sorted(requested_notes),
                usage=usage, first_usage=first, retrieval_usage=retrieval_usage)
    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/slides/{lecture}.pdf")
def pdf(lecture: str):
    return FileResponse(lecture_path(lecture), media_type="application/pdf")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return HTMLResponse((ROOT / "static/index.html").read_text().replace("{COURSE}", COURSE))
