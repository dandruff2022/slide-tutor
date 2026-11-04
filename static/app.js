import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const $ = id => document.getElementById(id);
const state = {lecture: '', page: 1, total: 0, pdf: null, notes: {}, editLine: null, caret: null, renderGen: 0, busy: false, renderId: 0};
const mathOptions = {delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false},{left:'\\[',right:'\\]',display:true}], throwOnError:false, strict:false, trust:false};

// Scrolls only the panel. el.scrollIntoView would also scroll the overflow:hidden page, pushing the layout up.
function scrollPanel(panel, el, start = false) {
  const p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (start || r.top < p.top) panel.scrollTop += r.top - p.top;
  else if (r.bottom > p.bottom) panel.scrollTop += Math.min(r.bottom - p.bottom, r.top - p.top);
}
function status(text='') { $('status').textContent = text; }
function markdown(el, text) {
  // Protect math from Markdown's underscore/backslash processing before KaTeX sees it.
  const equations = [];
  const prefix = 'MATH' + Math.random().toString(36).slice(2) + 'TOKEN';
  const safe = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?\$/g, value => `${prefix}${equations.push(value)-1}END`);
  el.innerHTML = DOMPurify.sanitize(marked.parse(safe));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) equations.forEach((eq,i) => { walker.currentNode.textContent = walker.currentNode.textContent.replaceAll(`${prefix}${i}END`, () => eq); });
  renderMathInElement(el, mathOptions);
}
// Each note line is one step. A line without $ or `code` that looks like LaTeX renders as display math.
function renderLine(line) {
  const div = document.createElement('div'); div.className = 'note-line';
  if (!line.trim()) { div.innerHTML = '&nbsp;'; return div; }
  if (/[$`]/.test(line) || !/[\\^_]/.test(line)) { markdown(div, line); return div; }
  try { katex.render(line, div, {displayMode: true, throwOnError: true, strict: false}); }
  catch (error) {
    // Prose with an underscore (snake_case, __global__) or CJK text isn't broken LaTeX: show it as text.
    if (!line.includes('\\') || /[\u3400-\u9fff]/.test(line)) { div.textContent = line; return div; }
    div.className += ' render-error'; div.textContent = `${line}  ⟵ ${error.message}`;
  }
  return div;
}
// Consecutive lines starting with | form one Markdown table block; every other line is its own block. [start, end) pairs.
function blocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    if (lines[i].trim().startsWith('|')) while (end < lines.length && lines[end].trim().startsWith('|')) end++;
    out.push([i, end]); i = end;
  }
  return out;
}
function renderBlock(lines, start, end) {
  if (end - start < 2) return renderLine(lines[start]);
  const div = document.createElement('div'); div.className = 'note-line'; markdown(div, lines.slice(start, end).join('\n')); return div;
}
const renderLines = lines => blocks(lines).filter(([s, e]) => lines.slice(s, e).join('').trim()).map(([s, e]) => renderBlock(lines, s, e));
async function api(url, options={}) {
  const res = await fetch(url, options);
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status}).`); }
  return res;
}

// ---- Notes: one document per lecture, a section per page; only the current page is editable.
const saveTimers = new Map();  // per lecture+page, so switching pages never drops a pending save
function saveNote(page = state.page, lecture = state.lecture) {
  const key = `${lecture}:${page}`, text = state.notes[page] || '';
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => api(`/api/lectures/${lecture}/notes/${page}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})})
    .then(() => status()).catch(error => status(`Note not saved: ${error.message}`)), 400));
}
function setNote(text) { state.notes[state.page] = text; saveNote(); }
function renderNotes() {
  const pages = new Set(Object.keys(state.notes).filter(p => state.notes[p].trim()).map(Number));
  pages.add(state.page);
  state.renderGen++;  // editors from the previous render must ignore their blur
  $('notes').replaceChildren();
  for (const page of [...pages].sort((a, b) => a - b)) {
    const section = document.createElement('div'); section.className = 'note' + (page === state.page ? ' current' : '');
    const head = document.createElement('button'); head.className = 'note-head'; head.textContent = `p.${page}`; head.onmousedown = event => { event.preventDefault(); goPage(page); };
    const body = document.createElement('div'); body.className = 'note-body';
    section.append(head, body); $('notes').append(section);
    const text = state.notes[page] || '';
    if (page !== state.page) { body.append(...renderLines(text.split('\n'))); continue; }
    currentNote(body, text);
    scrollPanel($('notes'), section);
  }
}
// Current page: every line stays rendered except the one being edited (click a line to edit only it).
function currentNote(body, text) {
  const lines = text ? text.split('\n') : [];
  const edit = i => event => { event.preventDefault(); state.editLine = i; state.caret = null; renderNotes(); };
  for (const [start, end] of blocks(lines)) {
    // A table being edited shows its other rows as source, so Enter and ↑/↓ work row by row.
    const source = end - start > 1 && state.editLine !== null && state.editLine >= start && state.editLine < end;
    for (const [s, e] of source ? lines.slice(start, end).map((_, k) => [start + k, start + k + 1]) : [[start, end]]) {
      if (s === state.editLine) { lineEditor(body, lines, s); continue; }
      let div;
      if (source) { div = document.createElement('div'); div.className = 'note-line note-source'; div.textContent = lines[s]; }
      else div = renderBlock(lines, s, e);
      div.dataset.i = s; div.dataset.n = e - s;
      // A plain click edits the line (in a table: the clicked row); a drag selects lines instead (see pickedLines). While editing, mousedown jumps straight to the line.
      const at = event => { const row = event.target.closest('tr'); return row ? s + (row.rowIndex && row.rowIndex + 1) : s; };
      div.onmousedown = event => { if (state.editLine !== null) edit(at(event))(event); };
      div.onclick = event => { if (getSelection().isCollapsed) edit(at(event))(event); };
      body.append(div);
    }
  }
  if (state.editLine !== null && state.editLine >= lines.length) lineEditor(body, lines, lines.length);
  else { const add = document.createElement('div'); add.className = 'note-add'; add.textContent = lines.length ? '+ line' : `Click to write a note for p.${state.page}… (LaTeX lines render as math)`; add.onmousedown = edit(lines.length); body.append(add); }
}
function lineEditor(body, lines, i) {
  const area = document.createElement('textarea'); area.rows = 1; area.value = lines[i] ?? '';
  const gen = state.renderGen;
  const grow = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
  const commit = () => setNote(lines.join('\n'));
  const move = (line, caret) => { state.editLine = line; state.caret = caret; renderNotes(); };
  area.oninput = () => { lines[i] = area.value; commit(); grow(); };
  area.onkeydown = event => {
    const at = area.selectionStart, collapsed = at === area.selectionEnd;
    if (event.key === 'Enter' && !event.shiftKey) {  // split the line at the caret
      event.preventDefault(); lines.splice(i, 1, area.value.slice(0, at), area.value.slice(area.selectionEnd)); commit(); move(i + 1, 0);
    } else if (event.key === 'Backspace' && collapsed && at === 0 && i > 0) {  // join with the line above
      event.preventDefault(); const caret = lines[i - 1].length; lines[i - 1] += area.value; lines.splice(i, 1); commit(); move(i - 1, caret);
    } else if (event.key === 'ArrowUp' && i > 0 && !area.value.slice(0, at).includes('\n')) { event.preventDefault(); move(i - 1, null); }
    else if (event.key === 'ArrowDown' && i < lines.length - 1) { event.preventDefault(); move(i + 1, null); }
    else if (event.key === 'Escape') area.blur();
    else if (event.key === 'Tab') { event.preventDefault(); area.setRangeText('  ', at, area.selectionEnd, 'end'); area.oninput(); }
  };
  area.onblur = () => {
    if (gen !== state.renderGen) return;
    state.editLine = null; setNote(lines.join('\n').replace(/\n+$/, '')); renderNotes();
  };
  // Focus synchronously: keys typed right after Enter must land in the new line, not be dropped.
  body.append(area); grow(); area.focus();
  const caret = state.caret ?? area.value.length; area.setSelectionRange(caret, caret);
}

// Drag across rendered lines of the current note to select them: Backspace/Delete removes every line the
// selection touches, ⌘X / ⌘C cut / copy them as source, dragging the selection moves them, ⌘Z undoes the last delete or move.
let undoNote = null, pickedHint = false;
function pickedDivs() {
  const selection = getSelection(), body = document.querySelector('.note.current .note-body');
  if (!body || state.editLine !== null || !selection.rangeCount || selection.isCollapsed || !$('notes').contains(selection.getRangeAt(0).commonAncestorContainer)) return [];
  return [...body.querySelectorAll('.note-line')].filter(div => selection.containsNode(div, true));
}
const pickedLines = () => pickedDivs().flatMap(div => Array.from({length: Number(div.dataset.n)}, (_, k) => Number(div.dataset.i) + k));
function deletePicked(picked) {
  const text = state.notes[state.page] || '';
  undoNote = {lecture: state.lecture, page: state.page, text};
  setNote(text.split('\n').filter((_, i) => !picked.includes(i)).join('\n'));
  track('note_lines_deleted', {lines: picked.map(i => text.split('\n')[i])});
  getSelection().removeAllRanges(); renderNotes();
  status(`Deleted ${picked.length} line${picked.length > 1 ? 's' : ''} from p.${state.page} — ⌘Z to undo`);
}
document.addEventListener('selectionchange', () => {
  const picked = pickedLines();
  document.querySelectorAll('.note-line.picked').forEach(div => div.classList.remove('picked'));
  for (const div of pickedDivs()) div.classList.add('picked');
  if (picked.length) status(`${picked.length} line${picked.length > 1 ? 's' : ''} selected — drag to move, Backspace to delete`);
  else if (pickedHint) status();
  pickedHint = picked.length > 0;
});
for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
  const picked = pickedLines(); if (!picked.length) return;
  const lines = state.notes[state.page].split('\n');
  event.preventDefault(); event.clipboardData.setData('text/plain', picked.map(i => lines[i]).join('\n'));
  if (type === 'cut') deletePicked(picked);
});

// Dragging the picked lines: the drop point is the gap above or below the line under the pointer.
let dragged = null;
function dropIndex(event) {
  const body = document.querySelector('.note.current .note-body');
  if (!body?.contains(event.target)) return null;
  const div = event.target.closest('.note-line[data-i]');
  if (!div) return (state.notes[state.page] || '').split('\n').length;  // "+ line" or empty space: the end
  const {top, height} = div.getBoundingClientRect(), i = Number(div.dataset.i);
  return event.clientY < top + height / 2 ? i : i + Number(div.dataset.n);
}
function markDrop(index) {
  document.querySelectorAll('.drop-before,.drop-after').forEach(div => div.classList.remove('drop-before', 'drop-after'));
  if (index === null) return;
  const divs = [...document.querySelectorAll('.note.current .note-line[data-i]')];
  const below = divs.find(div => Number(div.dataset.i) === index);
  if (below) below.classList.add('drop-before'); else divs.at(-1)?.classList.add('drop-after');
}
document.addEventListener('dragstart', event => {
  const picked = pickedLines(); if (!picked.length) return;
  dragged = picked; event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', picked.map(i => state.notes[state.page].split('\n')[i]).join('\n'));
});
document.addEventListener('dragover', event => {
  if (!dragged) return;
  const index = dropIndex(event); markDrop(index);
  if (index !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
});
document.addEventListener('drop', event => {
  if (!dragged) return;
  event.preventDefault();
  const index = dropIndex(event), picked = dragged; dragged = null; markDrop(null);
  if (index === null || (index >= picked[0] && index <= picked.at(-1) + 1)) return;  // dropped onto itself
  const text = state.notes[state.page], lines = text.split('\n');
  const moving = picked.map(i => lines[i]), rest = lines.filter((_, i) => !picked.includes(i));
  rest.splice(index > picked.at(-1) ? index - picked.length : index, 0, ...moving);
  undoNote = {lecture: state.lecture, page: state.page, text};
  setNote(rest.join('\n')); getSelection().removeAllRanges(); renderNotes();
  status(`Moved ${picked.length} line${picked.length > 1 ? 's' : ''} — ⌘Z to undo`);
  track('note_lines_moved', {lines: moving, to: index});
});
document.addEventListener('dragend', () => { dragged = null; markDrop(null); });

// ---- Slides
async function slideCanvas(pdf, pageNumber, width) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({scale: Math.min(2, width / page.getViewport({scale: 1}).width)});
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff'}).promise;
  return canvas;
}
async function goPage(value) {
  if (!state.pdf) return;
  const number = Math.trunc(Number(value)), before = state.page;
  state.page = Math.max(1, Math.min(state.total, Number.isFinite(number) ? number : state.page));
  $('page').value = state.page; state.editLine = null; renderNotes();
  if (linked && state.page !== before) unlink();  // a follow-up thread stays on one page
  localStorage.setItem('slide-tutor-position', JSON.stringify({lecture: state.lecture, page: state.page}));
  const id = ++state.renderId;
  const [canvas, pdfPage] = await Promise.all([slideCanvas(state.pdf, state.page, 2000), state.pdf.getPage(state.page)]);
  const text = await pdfPage.getTextContent();
  if (id !== state.renderId) return;
  $('slide').width = canvas.width; $('slide').height = canvas.height; $('slide').getContext('2d').drawImage(canvas, 0, 0);
  Object.assign(state, {pdfPage, text}); layoutSlide();
}
// Fit the slide into its box and lay pdf.js's invisible text layer over it so slide text is selectable.
let textLayer = null;
function layoutSlide() {
  if (!state.pdfPage) return;
  const natural = state.pdfPage.getViewport({scale: 1}), box = $('slide-box');
  const scale = Math.min(box.clientWidth / natural.width, box.clientHeight / natural.height);
  const viewport = state.pdfPage.getViewport({scale});
  Object.assign($('slide').style, {width: `${viewport.width}px`, height: `${viewport.height}px`});
  textLayer?.cancel(); $('text-layer').replaceChildren();
  $('text-layer').style.setProperty('--scale-factor', scale);
  textLayer = new pdfjsLib.TextLayer({textContentSource: state.text, container: $('text-layer'), viewport});
  textLayer.render().then(() => {
    const end = document.createElement('div'); end.className = 'endOfContent'; $('text-layer').append(end);
    highlightFind();
  }).catch(() => {});
}
new ResizeObserver(layoutSlide).observe($('slide-box'));
async function loadLecture(lecture, page = 1) {
  status('Loading…');
  try {
    const [pdf, notes] = await Promise.all([pdfjsLib.getDocument(`/slides/${lecture}.pdf`).promise, api(`/api/lectures/${lecture}/notes`).then(r => r.json())]);
    state.pdf?.destroy();
    Object.assign(state, {pdf, lecture, total: pdf.numPages, notes});
    $('lecture').value = lecture; $('page').max = pdf.numPages; $('total').textContent = `/ ${pdf.numPages}`;
    if (linked) unlink();
    status(); await goPage(page);
    if ($('find').value) find(0, false);
  } catch (error) { status(`Could not load lecture: ${error.message}`); }
}

// ---- Find (⌘F): search every page of the lecture; Enter / Shift+Enter jump to the next / previous matching page.
const norm = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
let lectureText = null;  // {pdf, pages: Promise<string[]>}, extracted once per lecture
function pageTexts() {
  const pdf = state.pdf;
  if (lectureText?.pdf !== pdf) lectureText = {pdf, pages: Promise.all(Array.from({length: pdf.numPages}, (_, i) =>
    pdf.getPage(i + 1).then(page => page.getTextContent()).then(content => norm(content.items.map(item => item.str).join(' ')))))};
  return lectureText.pages;
}
async function find(step = 0, jump = true) {
  const query = norm($('find').value), pdf = state.pdf;
  const pages = query && pdf ? await pageTexts() : [];
  if (pdf !== state.pdf || query !== norm($('find').value)) return;  // superseded by newer typing or another lecture
  const matches = pages.flatMap((text, i) => text.includes(query) ? [i + 1] : []);
  let target = null;
  if (step > 0) target = matches.find(p => p > state.page) ?? matches[0];
  else if (step < 0) target = matches.findLast(p => p < state.page) ?? matches.at(-1);
  else if (jump && !matches.includes(state.page)) target = matches.find(p => p > state.page) ?? matches[0];
  if (target && target !== state.page) goPage(target);
  const at = matches.indexOf(state.page) + 1;
  $('find-count').textContent = !query ? '' : matches.length ? `${at || '–'}/${matches.length} pages` : 'no match';
  highlightFind();
}
function highlightFind() {
  const query = norm($('find').value);
  for (const span of $('text-layer').querySelectorAll('span')) span.classList.toggle('hit', !!query && norm(span.textContent).includes(query));
}
$('find').oninput = () => find();
$('find').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? -1 : 1); }
  else if (event.key === 'Escape') { $('find').value = ''; find(); $('find').blur(); }
});

// ---- Ask / Check: stateless, only the latest answer is shown.
const history = JSON.parse(localStorage.getItem('slide-tutor-prompts') || '[]');
let historyIndex = history.length, pending = '';
async function send(mode) {
  if (state.busy || !state.pdf) return;
  const text = $('prompt').value.trim();
  const {lecture, page} = state, note = state.notes[page] || '';
  if (mode === 'ask' && !text) return status('Type a question first.');
  if (mode === 'check' && !note.trim()) return status('Write a note for this page first.');
  if (text) {  // Check also sends whatever is typed (e.g. "is step 3 right?")
    if (history.at(-1) !== text) history.push(text);
    localStorage.setItem('slide-tutor-prompts', JSON.stringify(history.slice(-50)));
    historyIndex = history.length; pending = ''; $('prompt').value = '';
  }
  const follow = linked;  // linked: keep the thread on screen and send it along
  state.busy = true; $('ask').disabled = $('check').disabled = true; updateLink(); status(`Thinking about p.${page}…`);
  if (!follow) { $('response').replaceChildren(); Object.assign($('response').dataset, {lecture, page}); }  // whose note a selection goes to
  let answer = '', frame = null;
  const q = document.createElement('div'), out = document.createElement('div');
  if (follow) { q.className = 'thread-q'; q.textContent = `↳ ${mode === 'check' ? `Check note${text ? `: ${text}` : ''}` : text}`; $('response').append(q); scrollPanel($('response'), q, true); }
  $('response').append(out);
  try {
    // Neighbors go as extracted text (server side); the model gets image_hires only if it asks for it.
    const image = (await slideCanvas(state.pdf, page, 1000)).toDataURL('image/png');
    const image_hires = (await slideCanvas(state.pdf, page, 1600)).toDataURL('image/png');
    const res = await api('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({lecture, page, mode, text, note, image, image_hires, response_lang: $('response-lang').value, note_lang: $('note-lang').value, model: $('model').value || undefined, thread: follow ? thread : []})});
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      buffer += decoder.decode(value, {stream: true}); let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const record = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        if (!record.startsWith('data: ')) continue;
        const item = JSON.parse(record.slice(6));
        if (item.type === 'error') throw new Error(item.message);
        if (item.type === 'status') status(item.message);
        if (item.type === 'delta') { answer += item.text; frame ??= setTimeout(() => { frame = null; markdown(out, answer); }, 80); }
      }
    }
    clearTimeout(frame); status();
    // Check → ```latex block replaces the note; Ask → optional ```note block is a suggestion appended to it.
    // A follow-up in a thread that started with a check may also return the whole edited note as ```latex.
    const editing = mode === 'check' || (follow && thread.some(t => t.mode === 'check'));
    const fixed = editing && answer.match(/```latex\s*\n([\s\S]*?)```/i);
    const suggested = mode === 'ask' && answer.match(/```note\s*\n([\s\S]*?)```\s*$/i);
    markdown(out, suggested ? answer.slice(0, suggested.index) : answer);
    // Questions and checks can both be followed up on (a check keeps its ```latex block so edits can build on it).
    thread = [...(follow ? thread : []), {mode, question: text, answer: suggested ? answer.slice(0, suggested.index) : answer}].slice(-4);
    if (fixed) offerApply(fixed[1].trim(), lecture, page, 'replace');
    if (suggested) {
      const box = document.createElement('div'); box.className = 'suggested';
      const label = document.createElement('div'); label.className = 'suggested-label'; label.textContent = 'Suggested note';
      box.append(label, ...renderLines(suggested[1].trim().split('\n')));
      $('response').append(box); offerApply(suggested[1].trim(), lecture, page, 'append');
    }
  } catch (error) { clearTimeout(frame); if (answer) markdown(out, answer); else { q.remove(); out.remove(); } status(error.message); }
  finally { state.busy = false; $('ask').disabled = $('check').disabled = false; updateLink(); }
}
// 🔗 between response and prompt: on = the next question follows up on the answers shown (last 4 Q&A sent as text).
let thread = [], linked = false;
function updateLink() {
  if (!thread.length) linked = false;
  const link = $('link'); link.disabled = state.busy || !thread.length; link.setAttribute('aria-pressed', linked);
  $('check').title = linked ? "Check the note again as part of this thread (plus anything typed)" : "Check this page's note (plus anything typed in the prompt)";
  link.title = !thread.length ? 'Follow up: ask something first' : linked ? 'Linked: next question follows up on the answers above (click to unlink)' : 'Link: make the next question a follow-up to this answer';
  document.querySelector('main').classList.toggle('linked', linked);
  $('prompt').placeholder = linked ? 'Follow up, e.g. "only change step 2"…  (Enter = Ask)' : 'Ask about this slide…  (Enter = Ask, ↑↓ = history)';
}
function unlink() { linked = false; thread = thread.slice(-1); updateLink(); }  // keep the last answer so it can be re-linked
$('link').onclick = () => { if (linked) unlink(); else { linked = true; updateLink(); } track(linked ? 'link_on' : 'link_off'); $('prompt').focus(); };
// Silent usage log (data/logs/events.jsonl, see CLAUDE.md); failures are ignored.
function track(kind, data = {}) {
  fetch('/api/event', {method: 'POST', headers: {'Content-Type': 'application/json'}, keepalive: true,
    body: JSON.stringify({kind, lecture: state.lecture, page: state.page, data})}).catch(() => {});
}
function offerApply(text, lecture, page, how) {
  const apply = document.createElement('button'); apply.className = 'apply'; apply.textContent = `${how === 'append' ? 'Add' : 'Apply'} to note p.${page}`;
  const undo = document.createElement('button'); undo.className = 'apply'; undo.textContent = 'Undo'; undo.hidden = true;
  let previous = null;
  apply.onclick = () => {
    if (state.lecture !== lecture || state.page !== page) return status(`Go back to p.${page} to apply.`);
    previous = state.notes[page] || ''; setNote(how === 'append' && previous.trim() ? `${previous.trimEnd()}\n${text}` : text); state.editLine = null; renderNotes(); apply.hidden = true; undo.hidden = false;
    track(how === 'append' ? 'suggested_note_added' : 'check_fix_applied', {text});
  };
  undo.onclick = () => {
    if (state.lecture !== lecture || state.page !== page) return status(`Go back to p.${page} to undo.`);
    setNote(previous); renderNotes(); undo.hidden = true; apply.hidden = false;
    track(how === 'append' ? 'suggested_note_undone' : 'check_fix_undone', {text});
  };
  $('response').append(apply, undo);
}

// ---- Select part of the response → "Add to note" appends it (math as LaTeX source) to the note of the page it answered.
function selectionToNoteText(range) {
  const outer = node => node.parentElement?.closest('.katex-display') || node.parentElement?.closest('.katex');
  const start = outer(range.startContainer), end = outer(range.endContainer);  // never cut an equation in half
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
  const box = document.createElement('div'); box.append(range.cloneContents());
  const tex = el => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent.replace(/\s+/g, ' ').trim() || el.textContent;
  box.querySelectorAll('.katex-display').forEach(el => el.replaceWith(`\n${tex(el)}\n`));  // own line → renders as display math
  box.querySelectorAll('.katex').forEach(el => el.replaceWith(`$${tex(el)}$`));
  box.querySelectorAll('code').forEach(el => { if (!el.closest('pre')) el.replaceWith(`\`${el.textContent}\``); });  // keeps __x__ from turning into bold/math
  if (box.querySelector('tr') && !box.querySelector('table')) {  // selection inside one table: rows came without it
    const table = document.createElement('table'); table.append(...box.childNodes); box.append(table);
  }
  box.querySelectorAll('table').forEach(table => {  // back to Markdown rows; the first selected row becomes the header
    const rows = [...table.rows].map(row => `| ${[...row.cells].map(cell => cell.textContent.replace(/\s+/g, ' ').trim()).join(' | ')} |`);
    if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat(table.rows[0].cells.length)}`);
    table.replaceWith(`\n${rows.join('\n')}\n`);
  });
  box.querySelectorAll('p,li,pre,h1,h2,h3,h4,br').forEach(el => el.after('\n'));
  return box.textContent.replace(/\n{2,}/g, '\n').trim();
}
// One pop-up for selections: "Add to note" in the response, "Ask about this" on the slide text.
const popup = Object.assign(document.createElement('button'), {className: 'popup', hidden: true});
document.body.append(popup);
popup.onmousedown = event => event.preventDefault();  // keep the selection alive
function selectionArea() {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return null;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  return $('response').contains(node) ? 'response' : $('text-layer').contains(node) ? 'slide' : null;
}
document.addEventListener('mouseup', event => {
  if (event.target === popup) return;
  setTimeout(() => {  // the selection settles after mouseup
    const area = selectionArea();
    popup.hidden = !area; if (!area) return;
    popup.dataset.area = area; popup.textContent = area === 'response' ? `Add to note p.${$('response').dataset.page}` : 'Ask about this';
    // Up and to the right of the pointer so it never covers the cursor; below it if there's no room above.
    const above = event.clientY - popup.offsetHeight - 10;
    Object.assign(popup.style, {left: `${Math.min(event.clientX + 10, innerWidth - popup.offsetWidth - 4)}px`,
                                top: `${above >= 4 ? above : event.clientY + 24}px`});
  });
});
document.addEventListener('selectionchange', () => { if (!selectionArea()) popup.hidden = true; });
popup.onclick = () => {
  const selection = getSelection();
  if (!selection.rangeCount) return;
  if (popup.dataset.area === 'response') {
    // Goes to the page the response is about, which may not be the page on screen now.
    const {lecture, page} = $('response').dataset;
    if (lecture !== state.lecture) return status(`Go back to ${lecture} to add this.`);
    const text = selectionToNoteText(selection.getRangeAt(0));
    const note = (state.notes[page] || '').trimEnd();
    if (text) { state.notes[page] = note ? `${note}\n${text}` : text; saveNote(Number(page)); state.editLine = null; renderNotes(); status(`Added to note p.${page}`); track('selection_added_to_note', {text, page: Number(page)}); }
  } else {
    // Sendable as-is, and reads naturally if the user keeps typing after it.
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    track('slide_text_asked', {quote});
    const ask = `On p.${state.page}, the slide says "${quote}". Could you explain what this means here? `;
    const prompt = $('prompt'); prompt.value = prompt.value.trim() ? `${prompt.value.trimEnd()}\n${ask}` : ask;
    prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }
  selection.removeAllRanges(); popup.hidden = true;
};

// ---- Wiring
$('ask').onclick = () => send('ask');
$('check').onclick = () => send('check');
$('prompt').addEventListener('keydown', event => {
  const area = event.target, before = area.value.slice(0, area.selectionStart), after = area.value.slice(area.selectionEnd);
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send('ask'); }
  else if (event.key === 'ArrowUp' && !before.includes('\n') && historyIndex > 0) {
    event.preventDefault(); if (historyIndex === history.length) pending = area.value; area.value = history[--historyIndex];
  } else if (event.key === 'ArrowDown' && !after.includes('\n') && historyIndex < history.length) {
    event.preventDefault(); area.value = ++historyIndex === history.length ? pending : history[historyIndex];
  }
});
// 🌐 menu: response and note languages and the model, remembered across reloads.
const langs = JSON.parse(localStorage.getItem('slide-tutor-lang') || '{}');
for (const id of ['response-lang', 'note-lang', 'model']) {
  $(id).value = langs[id] || 'en';
  $(id).onchange = () => { langs[id] = $(id).value; localStorage.setItem('slide-tutor-lang', JSON.stringify(langs)); };
}
api('/api/models').then(r => r.json()).then(({default: fallback, models}) => {
  for (const m of models) $('model').append(new Option(m.label, m.id));
  $('model').value = models.some(m => m.id === langs.model) ? langs.model : fallback;
}).catch(() => {});  // no list: requests use the server's default model
document.addEventListener('mousedown', event => { if (!$('lang').contains(event.target)) $('lang').open = false; });
$('lecture').onchange = event => loadLecture(event.target.value);
$('page').onchange = event => goPage(event.target.value);
$('prev').onclick = () => goPage(state.page - 1);
$('next').onclick = () => goPage(state.page + 1);
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('find').focus(); $('find').select(); return; }
  if (event.target.closest('input,textarea,select')) return;
  if (event.key === 'Backspace' || event.key === 'Delete') { const picked = pickedLines(); if (picked.length) { event.preventDefault(); deletePicked(picked); } return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && undoNote?.lecture === state.lecture) {
    event.preventDefault(); const {page, text} = undoNote; undoNote = null;
    state.notes[page] = text; saveNote(page); renderNotes(); status(`Restored note p.${page}`); track('note_delete_undone'); return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const step = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1}[event.key];
  if (step) { event.preventDefault(); goPage(state.page + step); }
});
// Two-finger scroll / mouse wheel over the slide flips pages like the arrow keys: one page per gesture.
// Trackpad momentum keeps sending decaying events for 1-3 s after the fingers lift, so after a flip we ignore
// events until one starts a new gesture: 120 ms of quiet, a >60 ms gap (mouse notches), a reversal, or, once
// the deltas have started decaying, one jumping above twice the trough (a new swipe during momentum).
// Pinch zoom passes through.
let wheelSum = 0, wheelLock = false, wheelTimer = null, wheelLastAt = 0, wheelLast = 0;
let wheelDir = 0, wheelTrough = 0, wheelDecaying = false;
$('slide-box').addEventListener('wheel', event => {
  if (event.ctrlKey) return;
  event.preventDefault();
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelSum = 0; wheelLock = false; }, 120);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $('slide-box').clientHeight : 1;
  const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
  const size = Math.abs(delta), dir = Math.sign(delta), now = performance.now(), gap = now - wheelLastAt;
  const last = wheelLast; wheelLastAt = now; wheelLast = size;
  if (wheelLock) {
    const fresh = size >= 4 && (dir !== wheelDir || (size >= 10 && (gap > 60 || (wheelDecaying && size > wheelTrough * 2))));
    if (!fresh) {
      if (size < last) wheelDecaying = true;
      wheelTrough = wheelDecaying ? Math.min(wheelTrough, size) : size;
      return;
    }
    wheelLock = false; wheelSum = 0;
  }
  wheelSum += delta;
  if (Math.abs(wheelSum) >= 30) {
    wheelLock = true; wheelDir = Math.sign(wheelSum); wheelTrough = size; wheelDecaying = false;
    goPage(state.page + wheelDir);
  }
}, {passive: false});
async function init() {
  const lectures = await (await api('/api/lectures')).json();
  for (const l of lectures) $('lecture').append(new Option(l.label, l.id));
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('slide-tutor-position')) || {}; } catch {}
  await loadLecture(lectures.some(l => l.id === saved.lecture) ? saved.lecture : lectures[0].id, saved.page || 1);
}
// Classic CDN scripts must finish before Markdown / math rendering.
if (document.readyState === 'complete') init(); else window.addEventListener('load', init, {once: true});
