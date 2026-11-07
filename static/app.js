import {lineClipboardType, selectedLines, matchesCut, planPaste, commitClipboard} from './note-clipboard.mjs';
import {mountLecturePicker} from './lecture-picker.mjs';
import {noteAutoScroll} from './note-drag.mjs';
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import {installNoteSyntax, mappedInline, rawFormula} from './note-format.mjs';
import {mountNoteTools} from './note-tools.mjs';
import {createNoteSaves, proposalText, offerBatch, noteValue} from './note-batch.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const $ = id => document.getElementById(id);
const state = {lecture: '', page: 1, total: 0, pdf: null, notes: {}, editLine: null, caret: null, renderGen: 0, busy: false, renderId: 0};
const focusReader = () => $('slide-box').focus({preventScroll: true});
const lecturePicker = mountLecturePicker({button: $('lecture'), list: $('lecture-list'), onSelect: loadLecture, focusReader});
let lectureLoadId = 0;
const mathOptions = {delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false},{left:'\\[',right:'\\]',display:true}], throwOnError:false, strict:false, trust:false};

// Scrolls only the panel. el.scrollIntoView would also scroll the overflow:hidden page, pushing the layout up.
function scrollPanel(panel, el, start = false) {
  const p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (start || r.top < p.top) panel.scrollTop += r.top - p.top;
  else if (r.bottom > p.bottom) panel.scrollTop += Math.min(r.bottom - p.bottom, r.top - p.top);
}
function status(text='') { $('status').textContent = text; }
function markdown(el, text) {
  installNoteSyntax(marked);
  // Protect math from Markdown's underscore/backslash processing before KaTeX sees it.
  const equations = [];
  const prefix = 'MATH' + Math.random().toString(36).slice(2) + 'TOKEN';
  const safe = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?\$/g, value => `${prefix}${equations.push(value)-1}END`);
  el.innerHTML = DOMPurify.sanitize(marked.parse(safe));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) equations.forEach((eq,i) => { walker.currentNode.textContent = walker.currentNode.textContent.replaceAll(`${prefix}${i}END`, () => eq); });
  renderMathInElement(el, mathOptions);
}
function noteMarkdown(el, text, offset) {
  const heading = text.match(/^(#{1,6})\s+/);
  const tag = heading ? `h${heading[1].length}` : 'p';
  const prefix = heading ? heading[0].length : 0;
  el.innerHTML = DOMPurify.sanitize(`<${tag}>${mappedInline(text.slice(prefix), offset + prefix, marked)}</${tag}>`);
  renderMathInElement(el, mathOptions);
}
// Keep source-line boundaries for editing; indentation and markers carry the hierarchy.
function noteLine(line) {
  const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
  const text = line.trimStart();
  // A leading mathematical sign is not a list bullet. Use an explicit \\quad after a marker for formula list items.
  const formula = /^[-+*]\s+/.test(text) && !/^[-+*]\s+\\quad\b/.test(text) && rawFormula(text);
  const item = !formula && text.match(/^(\d+[.)]|[-+*])(?:\s+|(?=\\quad))(?:\\quad\s*)?(.*)$/);
  return {indent, text: item ? item[2] : text, marker: item ? item[1] : null, prefix: line.length - (item ? item[2] : text).length};
}
function renderLine(line, offset = 0) {
  const {indent, text, marker, prefix} = noteLine(line);
  offset += prefix;
  const div = document.createElement('div'); div.className = 'note-line';
  div.style.marginLeft = `${indent * .5}em`;
  if (!text.trim()) { div.classList.add('note-gap'); div.innerHTML = '&nbsp;'; return div; }
  if (marker) {
    div.classList.add('note-item');
    if (/^\d/.test(marker)) div.classList.add('note-ordered');
    const label = document.createElement('span'); label.className = 'note-marker';
    label.textContent = /^\d/.test(marker) ? marker : '•';
    const content = renderLine(text, offset); content.classList.remove('note-line'); content.classList.add('note-content');
    div.append(label, content); return div;
  }
  const formula = text;
  line = text;
  if (!rawFormula(formula)) {
    noteMarkdown(div, line, offset); return div;
  }
  div.dataset.noteMath = 'true';
  try {
    katex.render(formula, div, {displayMode: true, throwOnError: true, strict: false});
  }
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
  const div = document.createElement('div'); div.className = 'note-line';
  div.style.marginLeft = `${noteLine(lines[start]).indent * .5}em`;
  markdown(div, lines.slice(start, end).map(line => line.trimStart()).join('\n')); return div;
}
const renderLines = lines => blocks(lines).map(([s, e]) => {
  const block = renderBlock(lines, s, e); block.dataset.i = s; block.dataset.n = e - s; return block;
});
async function api(url, options={}) {
  const res = await fetch(url, options);
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status}).`); }
  return res;
}

// ---- Notes: one document per lecture, a section per page; only the current page is editable.
const savedNotes = new Map();
function rememberSavedNotes(lecture, notes) {
  for (const [page, text] of Object.entries(notes)) savedNotes.set(`${lecture}:${page}`, text);
}
const saves = createNoteSaves(async (lecture, page, text) => {
  const key = `${lecture}:${page}`, before = savedNotes.get(key) || '';
  await api(`/api/lectures/${lecture}/notes/${page}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text, before})});
  savedNotes.set(key, text);
}, error => status(`Note not saved: ${error.message}`));
function saveNote(page = state.page, lecture = state.lecture) {
  if (!state.noteTransaction) saves.save(lecture, page, state.notes[page] || '');
}
function lockNotes(locked) {
  state.noteTransaction = locked;
  $('notes').inert = locked || !!state.loading;
  $('lecture').disabled = locked;
  if (locked) { lecturePicker.close(); cancelNoteDrag(); }
  refreshNoteActions();
  if (locked) { undoNote = null; getSelection().removeAllRanges(); }
}
function setNote(text) {
  if (state.noteTransaction || state.loading) return;
  if (undoNote?.kind === 'format' && undoNote.after !== text) undoNote = null;
  if (undoNote?.kind === 'clipboard' && undoNote.changes.some(change => change.page === state.page && noteValue(change.text) !== noteValue(text))) undoNote = null;
  state.notes[state.page] = text; saveNote(); paintPendingCut();
}
function renderNotes() {
  cancelNoteDrag();
  const pages = new Set(Object.keys(state.notes).filter(p => state.notes[p].trim()).map(Number));
  pages.add(state.page);
  state.renderGen++;  // editors from the previous render must ignore their blur
  $('notes').replaceChildren();
  for (const page of [...pages].sort((a, b) => a - b)) {
    const section = document.createElement('div'); section.className = 'note' + (page === state.page ? ' current' : ''); section.dataset.page = page;
    const head = document.createElement('button'); head.className = 'note-head'; head.textContent = `p.${page}`; head.onmousedown = event => { event.preventDefault(); goPage(page); };
    const body = document.createElement('div'); body.className = 'note-body';
    section.append(head, body); $('notes').append(section);
    const text = state.notes[page] || '';
    if (page !== state.page) { body.append(...renderLines(text.split('\n'))); continue; }
    currentNote(body, text);
    scrollPanel($('notes'), section);
  }
  paintPendingCut();
}
// Current page: a plain click edits the line; drags, double-clicks and clicks that clear a selection only select.
const startEdit = i => { state.editLine = i; state.caret = null; renderNotes(); };
let notePress = null, editTimer = 0;
$('notes').addEventListener('pointerdown', event => {
  clearTimeout(editTimer);
  // Recorded before the browser collapses the selection; a textarea's own selection does not count.
  const selection = getSelection();
  const selected = !selection.isCollapsed && !!selection.toString() && $('notes').contains(selection.anchorNode) && !document.activeElement?.matches('textarea');
  notePress = {x: event.clientX, y: event.clientY, selected};
});
$('notes').addEventListener('mousedown', event => { if (event.detail > 1) clearTimeout(editTimer); });
function clickToEdit(div, at) {
  div.onclick = event => {
    const press = notePress; notePress = null;
    if (!press || press.selected || event.detail > 1 || !getSelection().isCollapsed || event.target.closest('a,button,.note-drag')) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
    // Wait out a possible second click so double-click keeps native word selection.
    const line = at(event), gen = state.renderGen;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      if (gen === state.renderGen && state.editLine === null && getSelection().isCollapsed && !state.loading && !state.noteTransaction) startEdit(line);
    }, 250);
  };
}
function currentNote(body, text) {
  const lines = text ? text.split('\n') : [];
  const edit = i => event => { event.preventDefault(); startEdit(i); };
  for (const [start, end] of blocks(lines)) {
    // A table being edited shows its other rows as source, so Enter and ↑/↓ work row by row.
    const source = end - start > 1 && state.editLine !== null && state.editLine >= start && state.editLine < end;
    for (const [s, e] of source ? lines.slice(start, end).map((_, k) => [start + k, start + k + 1]) : [[start, end]]) {
      if (s === state.editLine) { lineEditor(body, lines, s); continue; }
      let div;
      if (source) { div = document.createElement('div'); div.className = 'note-line note-source'; div.textContent = lines[s]; }
      else div = renderBlock(lines, s, e);
      div.dataset.i = s; div.dataset.n = e - s;
      // In a table, the clicked row (rows after the header skip the | --- | separator line).
      body.append(noteRow(div, event => { const row = event.target.closest('tr'); return row ? s + (row.rowIndex && row.rowIndex + 1) : s; }));
    }
  }
  if (state.editLine !== null && state.editLine >= lines.length) lineEditor(body, lines, lines.length);
  else { const add = document.createElement('div'); add.className = 'note-add'; add.textContent = lines.length ? '+ line' : `Click to write a note for p.${state.page}… (LaTeX lines render as math)`; add.onmousedown = edit(lines.length); body.append(add); }
}
// The drag handle sits in the gutter and shows only beside selected lines.
function noteRow(div, at) {
  const row = document.createElement('div'); row.className = 'note-row';
  const handle = document.createElement('span'); handle.className = 'note-drag';
  handle.textContent = '⠿'; handle.draggable = true; handle.title = 'Drag selected lines to move';
  handle.setAttribute('aria-label', handle.title);
  clickToEdit(div, at);
  row.append(handle, div); return row;
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
  area.onblur = event => {
    if (gen !== state.renderGen) return;
    state.editLine = null; setNote(lines.join('\n').replace(/\n+$/, ''));
    if (event.relatedTarget !== $('notes')) { renderNotes(); return; }
    // Do not rebuild the line under a new text-selection gesture on blur.
    if (i < (state.notes[state.page] || '').split('\n').length && state.notes[state.page]) {
      const div = renderLine(lines[i] || ''); div.dataset.i = i; div.dataset.n = 1;
      area.replaceWith(noteRow(div, () => i));
    } else area.remove();
    if (!body.querySelector('.note-add')) {
      const add = document.createElement('div'); add.className = 'note-add'; add.textContent = '+ line';
      add.onmousedown = event => { event.preventDefault(); move(state.notes[state.page] ? state.notes[state.page].split('\n').length : 0, null); };
      body.append(add);
    }
    // Reassemble table source rows once there is no live text selection to preserve.
    // A click on a line may still become an edit, so wait for it before rebuilding the DOM under the click.
    if (body.querySelector('.note-source')) body.onpointerup = event => {
      if (event.target.closest('button,.note-add,.note-drag')) return;
      const gen = state.renderGen, reassemble = () => { if (gen === state.renderGen && state.editLine === null && getSelection().isCollapsed) renderNotes(); };
      if (event.target.closest('.note-line')) setTimeout(reassemble, 300); else reassemble();
    };
  };
  // Focus synchronously: keys typed right after Enter must land in the new line, not be dropped.
  body.append(area); grow(); area.focus();
  const caret = state.caret ?? area.value.length; area.setSelectionRange(caret, caret);
}

// Drag across rendered lines of the current note to select them: Backspace/Delete removes every line the
// selection touches, ⌘X / ⌘C cut / copy them as source, dragging the selection moves them, ⌘Z undoes the last delete or move.
let undoNote = null, pickedHint = false, pendingCut = null;
mountNoteTools({state, setNote, renderNotes, status, getUndo: () => undoNote, setUndo: value => { undoNote = value; }, track});
function pickedDivs() {
  const selection = getSelection(), body = document.querySelector('.note.current .note-body');
  if (!body || state.editLine !== null || !selection.rangeCount || selection.isCollapsed || !$('notes').contains(selection.getRangeAt(0).commonAncestorContainer)) return [];
  const range = selection.getRangeAt(0);
  return [...body.querySelectorAll('.note-line')].filter(div => {
    if (!range.intersectsNode(div)) return false;
    const part = document.createRange(); part.selectNodeContents(div);
    if (range.comparePoint(part.startContainer, part.startOffset) < 0) part.setStart(range.startContainer, range.startOffset);
    if (range.comparePoint(part.endContainer, part.endOffset) > 0) part.setEnd(range.endContainer, range.endOffset);
    return !part.collapsed && part.toString().length > 0;
  });
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
  for (const row of document.querySelectorAll('.note-row')) row.classList.toggle('has-picked', !!row.querySelector('.picked'));
  if (picked.length) status(`${picked.length} line${picked.length > 1 ? 's' : ''} selected — drag the ⠿ handle to move, Backspace to delete`);
  else if (pickedHint) status(pendingCut ? 'Cut pending — paste into a note to move; Escape to cancel.' : '');
  pickedHint = picked.length > 0;
});
function paintPendingCut() {
  if (pendingCut && (pendingCut.lecture !== state.lecture || pendingCut.before !== (state.notes[pendingCut.page] || ''))) {
    pendingCut = null; status('Pending cut cancelled: source changed. Clipboard text is still available as a copy.');
  }
  for (const section of $('notes').querySelectorAll('.note')) {
    for (const line of section.querySelectorAll('.note-line[data-i]')) {
      const i = Number(line.dataset.i), n = Number(line.dataset.n);
      const pending = !!pendingCut && Number(section.dataset.page) === pendingCut.page && i < pendingCut.end && i + n > pendingCut.first;
      line.classList.toggle('cut-pending', pending);
      line.title = pending ? 'Pending cut — removed only after pasting into a note. Escape cancels.' : '';
    }
  }
}
function cancelPendingCut(message = '') {
  if (!pendingCut) return;
  pendingCut = null; paintPendingCut(); if (message) status(message);
}
for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
  const picked = pickedLines();
  if (state.loading || state.noteTransaction) { if (picked.length) event.preventDefault(); return; }
  cancelPendingCut('Pending cut cancelled; source lines were kept.');
  if (!picked.length || !event.clipboardData) return;  // ordinary input clipboard behavior stays native
  const before = state.notes[state.page] || '', selection = selectedLines(before, picked);
  event.preventDefault(); event.clipboardData.setData('text/plain', selection.text);
  if (type !== 'cut') return;
  const token = crypto.randomUUID();
  try { event.clipboardData.setData(lineClipboardType, token); } catch {}  // unsupported custom types safely degrade to Copy
  if (event.clipboardData.getData(lineClipboardType) !== token) return status('Copied lines; this browser cannot mark a deferred cut.');
  pendingCut = {...selection, before, lecture: state.lecture, page: state.page, token};
  getSelection().removeAllRanges(); paintPendingCut(); $('notes').focus({preventScroll: true});
  status(`Cut ${picked.length} line${picked.length === 1 ? '' : 's'} — paste into a note to move; Escape to cancel.`);
  track('note_lines_cut_pending', {lines: picked});
});
const clipboardWrites = {state, api, saves, lock: lockNotes, onSaved: rememberSavedNotes, renderNotes};
document.addEventListener('paste', async event => {
  const editor = event.target.closest?.('.note.current textarea'), picked = pickedLines();
  if (!editor && event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
  if (!$('notes').contains(event.target) && !picked.length) return;
  if (state.loading || state.noteTransaction) { event.preventDefault(); return; }
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  const cut = matchesCut(pendingCut, state.lecture, state.notes, event.clipboardData.getData(lineClipboardType), text) ? pendingCut : null;
  if (pendingCut && !cut) cancelPendingCut('Clipboard or source changed; pasting a copy.');
  if (editor && !cut) return;  // retain native caret/Undo behavior for normal editor pastes
  event.preventDefault();
  const lecture = state.lecture, page = state.page, before = state.notes[page] || '';
  let target = null;
  if (editor) {
    const offset = before.split('\n').slice(0, state.editLine).reduce((n, line) => n + line.length + 1, 0);
    // The '+ line' editor is not in the saved source until input: paste there as a line append.
    if (offset <= before.length) target = {start: offset + editor.selectionStart, end: offset + editor.selectionEnd};
  } else if (picked.length) {
    const selected = selectedLines(before, picked); target = {start: selected.start, end: selected.contentEnd};
  }
  const previousUndo = undoNote;
  try {
    const changes = planPaste({notes: state.notes, page, text, target, cut});
    const committed = await commitClipboard(changes, clipboardWrites);
    cancelPendingCut(); getSelection().removeAllRanges();
    undoNote = committed.length ? {kind: 'clipboard', lecture, changes: committed} : previousUndo;
    $('notes').focus({preventScroll: true});
    status(committed.length ? `${cut ? 'Moved' : 'Pasted'} note lines to p.${page} — ⌘Z / Ctrl+Z to undo.` : 'Lines are already at that destination.');
    if (committed.length) track('note_clipboard_pasted', {pages: committed.map(change => change.page), moved: !!cut});
  } catch (error) { undoNote = previousUndo; status(`Nothing pasted: ${error.message}`); }
});
async function undoClipboard(transaction) {
  try {
    await commitClipboard(transaction.changes.map(change => ({page: change.page, before: change.text, text: change.before})), clipboardWrites);
    undoNote = null; cancelPendingCut();
    status('Clipboard paste undone.'); track('note_clipboard_undone', {pages: transaction.changes.map(change => change.page)});
  } catch (error) { undoNote = transaction; status(`Nothing undone: ${error.message}`); }
}
$('notes').addEventListener('pointerdown', event => {
  if (!event.target.closest('textarea,button,a')) $('notes').focus({preventScroll: true});
});

// Dragging the picked lines: the drop point is the gap above or below the line under the pointer.
let dragged = null, dragSource = null;
const dragScroll = noteAutoScroll($('notes'), (x, y) => markDrop(dropIndex({target: document.elementFromPoint(x, y), clientY: y})));
function cancelNoteDrag() {
  dragged = dragSource = null; dragScroll.stop(); markDrop(null); $('notes').classList.remove('moving-lines');
}
$('notes').addEventListener('pointerdown', event => {
  dragSource = null;
  const row = event.target.closest('.note-drag')?.closest('.note-row');
  if (event.button !== 0 || !row?.querySelector('.picked') || state.editLine !== null || state.loading || state.noteTransaction) return;
  dragSource = {picked: pickedLines(), lecture: state.lecture, page: state.page, text: state.notes[state.page]};
});
function dropIndex(event) {
  const body = document.querySelector('.note.current .note-body');
  if (!event.target || !body?.contains(event.target)) return null;
  const div = event.target.closest('.note-row')?.querySelector('.note-line[data-i]') || event.target.closest('.note-line[data-i]');
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
  if (!event.target.closest?.('.note-drag') || !dragSource?.picked.length || state.loading || state.noteTransaction ||
      dragSource.lecture !== state.lecture || dragSource.page !== state.page || dragSource.text !== state.notes[state.page]) {
    if (event.target.closest?.('.note.current')) event.preventDefault();
    return;
  }
  dragged = dragSource.picked; $('notes').classList.add('moving-lines'); event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragged.map(i => dragSource.text.split('\n')[i]).join('\n'));
});
for (const type of ['dragenter', 'dragover']) document.addEventListener(type, event => {
  if (!dragged) return;
  dragScroll.move(event.clientX, event.clientY);
  const index = dropIndex(event); markDrop(index);
  if (index !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
});
$('notes').addEventListener('dragleave', event => { if (!$('notes').contains(event.relatedTarget)) dragScroll.stop(); });
document.addEventListener('drop', event => {
  if (!dragged) return;
  event.preventDefault();
  const index = dropIndex(event), picked = dragged, source = dragSource; cancelNoteDrag();
  if (state.loading || state.noteTransaction || source.lecture !== state.lecture || source.page !== state.page || source.text !== state.notes[state.page]) return;
  if (index === null || (index >= picked[0] && index <= picked.at(-1) + 1)) return;  // dropped onto itself
  const text = state.notes[state.page], lines = text.split('\n');
  const moving = picked.map(i => lines[i]), rest = lines.filter((_, i) => !picked.includes(i));
  rest.splice(index > picked.at(-1) ? index - picked.length : index, 0, ...moving);
  undoNote = {lecture: state.lecture, page: state.page, text};
  setNote(rest.join('\n')); getSelection().removeAllRanges(); renderNotes();
  status(`Moved ${picked.length} line${picked.length > 1 ? 's' : ''} — ⌘Z to undo`);
  track('note_lines_moved', {lines: moving, to: index});
});
document.addEventListener('dragend', cancelNoteDrag);
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelNoteDrag(); });
window.addEventListener('blur', cancelNoteDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelNoteDrag(); });

// ---- Slides
async function slideCanvas(pdf, pageNumber, width) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({scale: Math.min(2, width / page.getViewport({scale: 1}).width)});
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff'}).promise;
  return canvas;
}
async function goPage(value) {
  if (!state.pdf || state.loading || state.noteTransaction) return;
  const number = Math.trunc(Number(value)), before = state.page, pdf = state.pdf;
  state.page = Math.max(1, Math.min(state.total, Number.isFinite(number) ? number : state.page));
  const page = state.page, id = ++state.renderId;
  $('page').value = page; state.editLine = null; renderNotes();
  if (linked && page !== before) unlink();
  updateLink(); refreshNoteActions();
  localStorage.setItem('slide-tutor-position', JSON.stringify({lecture: state.lecture, page}));
  try {
    const [canvas, pdfPage] = await Promise.all([slideCanvas(pdf, page, 2000), pdf.getPage(page)]);
    const text = await pdfPage.getTextContent();
    if (id !== state.renderId || pdf !== state.pdf) return;
    $('slide').width = canvas.width; $('slide').height = canvas.height; $('slide').getContext('2d').drawImage(canvas, 0, 0);
    Object.assign(state, {pdfPage, text}); layoutSlide();
    if ($('find').value) find(0, false);
  } catch (error) {
    if (id === state.renderId && pdf === state.pdf) status(`Could not display page: ${error.message}`);
  }
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
  if (state.noteTransaction) return;
  cancelNoteDrag();
  const id = ++lectureLoadId;
  state.loading = true; state.renderId++;
  $('notes').inert = true; refreshNoteActions();
  status('Loading…');
  let task;
  try {
    await saves.flush();
    if (id !== lectureLoadId) return;
    task = pdfjsLib.getDocument(`/slides/${lecture}.pdf`);
    const [pdf, notes] = await Promise.all([task.promise, api(`/api/lectures/${lecture}/notes`).then(r => r.json())]);
    if (id !== lectureLoadId) { await task.destroy(); return; }
    const previous = state.pdf;
    rememberSavedNotes(lecture, Object.fromEntries(Array.from({length: pdf.numPages}, (_, i) => [i + 1, notes[i + 1] || ''])));
    Object.assign(state, {pdf, lecture, total: pdf.numPages, notes, pdfPage: null, loading: false});
    lecturePicker.select(lecture); $('page').max = pdf.numPages; $('total').textContent = `/ ${pdf.numPages}`;
    previous?.destroy();
    if (linked) unlink();
    status(); await goPage(page);
    if (id === lectureLoadId && $('find').value) find(0, false);
  } catch (error) {
    if (task) await task.destroy().catch(() => {});
    if (id === lectureLoadId) {
      lecturePicker.select(state.lecture);
      status(`Could not load lecture: ${error.message}`);
    }
  } finally {
    if (id === lectureLoadId) {
      state.loading = false; $('notes').inert = !!state.noteTransaction; refreshNoteActions();
    }
  }
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
  if (state.busy || state.loading || state.noteTransaction || !state.pdf) return;
  const text = $('prompt').value.trim();
  const {lecture, page, pdf} = state;
  let note = state.notes[page] || '';
  if (mode === 'ask' && !text) return status('Type a question first.');
  if (mode === 'check' && !note.trim()) return status('Write a note for this page first.');
  if (text) {  // Check also sends whatever is typed (e.g. "is step 3 right?")
    if (history.at(-1) !== text) history.push(text);
    localStorage.setItem('slide-tutor-prompts', JSON.stringify(history.slice(-50)));
    historyIndex = history.length; pending = ''; $('prompt').value = '';
  }
  const follow = linked;  // linked: keep the thread on screen and send it along
  const priorThread = follow ? thread.slice() : [];
  state.busy = true; $('ask').disabled = $('check').disabled = true; updateLink(); status(`Thinking about p.${page}…`);
  if (!follow) {
    const applied = [...$('response').querySelectorAll('.note-proposal[data-applied="true"]')];
    $('response').replaceChildren(...applied); Object.assign($('response').dataset, {lecture, page});
  }  // Preserve applied batch Undo controls when replacing the answer.
  let answer = '', frame = null, proposal = null, completed = false;
  const q = document.createElement('div'), out = document.createElement('div');
  if (follow) { q.className = 'thread-q'; q.textContent = `↳ ${mode === 'check' ? `Check note${text ? `: ${text}` : ''}` : text}`; $('response').append(q); scrollPanel($('response'), q, true); }
  $('response').append(out);
  try {
    await saves.flush();
    if (state.lecture !== lecture || state.page !== page) throw new Error('Page changed; send the request again.');
    note = state.notes[page] || '';
    // Neighbors go as extracted text (server side); the model gets image_hires only if it asks for it.
    const image = (await slideCanvas(pdf, page, 1000)).toDataURL('image/png');
    const image_hires = (await slideCanvas(pdf, page, 1600)).toDataURL('image/png');
    const res = await api('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({lecture, page, mode, text, note, image, image_hires, response_lang: $('response-lang').value, note_lang: $('note-lang').value, model: $('model').value || undefined, thread: priorThread})});
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
        if (item.type === 'proposal') proposal = item.proposal;
        if (item.type === 'done') completed = true;
        if (item.type === 'delta') { answer += item.text; frame ??= setTimeout(() => { frame = null; markdown(out, proposalText(answer)); }, 80); }
      }
    }
    clearTimeout(frame);
    if (!completed) throw new Error('Response ended early. No note changes are available.');
    status();
    if (proposal) {
      markdown(out, proposalText(answer));
      offerBatch(proposal, {state, container: $('response'), api, saves, renderNotes, status, goPage, track, lock: lockNotes, onSaved: rememberSavedNotes});
      thread = [...priorThread, {mode, question: text, answer: proposalText(answer)}].slice(-4);
      return;
    }
    if (answer.includes('```note-proposal')) throw new Error('No validated note proposal was received. Nothing was applied.');
    // Check → ```latex block replaces the note; Ask → optional ```note block is a suggestion appended to it.
    // A follow-up in a thread that started with a check may also return the whole edited note as ```latex.
    const editing = mode === 'check' || (follow && priorThread.some(t => t.mode === 'check'));
    const fixed = editing && answer.match(/```latex\s*\n([\s\S]*?)```/i);
    const suggested = mode === 'ask' && answer.match(/```note\s*\n([\s\S]*?)```\s*$/i);
    markdown(out, suggested ? answer.slice(0, suggested.index) : answer);
    // Questions and checks can both be followed up on (a check keeps its ```latex block so edits can build on it).
    thread = [...priorThread, {mode, question: text, answer: suggested ? answer.slice(0, suggested.index) : answer}].slice(-4);
    if (fixed) offerApply(fixed[1].trim(), lecture, page, 'replace', note);
    if (suggested) {
      const box = document.createElement('div'); box.className = 'suggested';
      const label = document.createElement('div'); label.className = 'suggested-label'; label.textContent = 'Suggested note — add to the currently open page';
      box.append(label, ...renderLines(suggested[1].trim().split('\n')));
      $('response').append(box); offerApply(suggested[1].trim(), lecture, page, 'append');
    }
  } catch (error) { clearTimeout(frame); if (answer) markdown(out, proposalText(answer)); else { q.remove(); out.remove(); } status(error.message); }
  finally { state.busy = false; $('ask').disabled = $('check').disabled = false; updateLink(); }
}
// 🔗 between response and prompt: on = the next question follows up on the answers shown (last 4 Q&A sent as text).
let thread = [], linked = false;
function updateLink() {
  const sameContext = $('response').dataset.lecture === state.lecture && Number($('response').dataset.page) === state.page;
  if (!thread.length || !sameContext) linked = false;
  const link = $('link'); link.disabled = state.busy || state.loading || !thread.length || !sameContext; link.setAttribute('aria-pressed', linked);
  $('check').title = linked ? "Check the note again as part of this thread (plus anything typed)" : "Check this page's note (plus anything typed in the prompt)";
  link.title = !thread.length ? 'Follow up: ask something first' : linked ? 'Linked: next question follows up on the answers above (click to unlink)' : 'Link: make the next question a follow-up to this answer';
  document.querySelector('main').classList.toggle('linked', linked);
  $('prompt').placeholder = linked ? 'Follow up, e.g. "only change step 2"…  (Enter = Ask)' : 'Ask about this slide…  (Enter = Ask, ↑↓ = history)';
}
function unlink() { linked = false; thread = thread.slice(-1); updateLink(); }  // keep the last answer so it can be re-linked
$('link').onclick = () => { if (linked) unlink(); else { linked = true; updateLink(); } track(linked ? 'link_on' : 'link_off'); $('prompt').focus(); };
// Silent usage log (data/logs/events.jsonl, see CLAUDE.md); failures are ignored.
function track(kind, data = {}, destination = {lecture: state.lecture, page: state.page}) {
  fetch('/api/event', {method: 'POST', headers: {'Content-Type': 'application/json'}, keepalive: true,
    body: JSON.stringify({kind, ...destination, data})}).catch(() => {});
}
function refreshNoteActions() {
  for (const button of $('response').querySelectorAll('.apply')) button.updateNoteAction?.();
}
function offerApply(text, lecture, page, how, sourceNote = state.notes[page] || '') {
  const apply = document.createElement('button'); apply.className = 'apply';
  const undo = document.createElement('button'); undo.className = 'apply'; undo.hidden = true;
  let destination = null, previous = '', after = '';
  const samePage = (l, p) => state.lecture === l && state.page === p;
  apply.updateNoteAction = () => {
    apply.textContent = how === 'append' ? `Add to current page (p.${state.page})` : `Apply to note p.${page}`;
    apply.title = how === 'append' ? 'Append this suggestion to the currently open page, keeping its existing note.' : `Replace the original note on ${lecture}, p.${page}.`;
    apply.disabled = !!(state.noteTransaction || state.loading || !state.lecture || (how !== 'append' && !samePage(lecture, page)));
  };
  undo.updateNoteAction = () => {
    undo.textContent = destination ? `Undo on ${destination.lecture}, p.${destination.page}` : 'Undo';
    undo.disabled = !!(state.noteTransaction || state.loading || !destination || !samePage(destination.lecture, destination.page));
  };
  apply.onclick = () => {
    if (state.noteTransaction || state.loading || !state.lecture) return;
    if (how !== 'append' && !samePage(lecture, page)) return status(`Go back to ${lecture}, p.${page} to apply.`);
    if (how !== 'append' && (state.notes[page] || '') !== sourceNote) return status('Note changed since this answer. Check it again before replacing.');
    destination = {lecture: state.lecture, page: state.page};
    previous = state.notes[state.page] || '';
    after = how === 'append' && previous.trim() ? `${previous.trimEnd()}\n${text}` : text;
    setNote(after); state.editLine = null; renderNotes(); apply.hidden = true; undo.hidden = false;
    refreshNoteActions();
    track(how === 'append' ? 'suggested_note_added' : 'check_fix_applied', {text});
  };
  undo.onclick = () => {
    if (state.noteTransaction || state.loading || !destination) return;
    if (!samePage(destination.lecture, destination.page)) return status(`Go back to ${destination.lecture}, p.${destination.page} to undo.`);
    if ((state.notes[destination.page] || '') !== after) return status('Note changed after applying. Undo would overwrite your edits; nothing changed.');
    setNote(previous); renderNotes(); undo.hidden = true; apply.hidden = false; refreshNoteActions();
    track(how === 'append' ? 'suggested_note_undone' : 'check_fix_undone', {text});
  };
  $('response').append(apply, undo); refreshNoteActions();
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
  if (state.noteTransaction || state.loading) return;
  const selection = getSelection();
  if (!selection.rangeCount) return;
  if (popup.dataset.area === 'response') {
    // Goes to the page the response is about, which may not be the page on screen now.
    const {lecture, page} = $('response').dataset;
    if (lecture !== state.lecture) return status(`Go back to ${lecture} to add this.`);
    const text = selectionToNoteText(selection.getRangeAt(0));
    const note = (state.notes[page] || '').trimEnd();
    if (text) { state.notes[page] = note ? `${note}\n${text}` : text; saveNote(Number(page)); state.editLine = null; renderNotes(); status(`Added to note p.${page}`); track('selection_added_to_note', {text}, {lecture, page: Number(page)}); }
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
  if (event.isComposing || event.keyCode === 229) return;
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
$('slide-box').addEventListener('pointerdown', focusReader);
$('page').addEventListener('keydown', event => { if (event.key === 'Escape') focusReader(); });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) focusReader(); });
$('page').onchange = event => goPage(event.target.value);
$('prev').onclick = () => goPage(state.page - 1);
$('next').onclick = () => goPage(state.page + 1);
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); $('find').focus(); $('find').select(); return; }
  if (event.key === 'Escape' && pendingCut && !state.noteTransaction && !event.isComposing) {
    event.preventDefault(); cancelPendingCut('Cut cancelled; source lines were kept.');
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && undoNote?.kind === 'clipboard' && undoNote.lecture === state.lecture && !state.loading && !state.noteTransaction && !event.isComposing) {
    const input = event.target.closest('input,textarea,[contenteditable="true"]');
    if (!input || (input.matches('.note.current textarea') && undoNote.changes.some(change => change.page === state.page))) {
      event.preventDefault(); undoClipboard(undoNote); return;
    }
  }
  if (event.isComposing || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (state.loading || state.noteTransaction) return;
  if (event.key === 'Backspace' || event.key === 'Delete') { const picked = pickedLines(); if (picked.length) { event.preventDefault(); deletePicked(picked); } return; }
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {  // keyboard path into editing
    const picked = pickedLines(); if (picked.length) { event.preventDefault(); getSelection().removeAllRanges(); startEdit(picked[0]); } return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && undoNote?.lecture === state.lecture && undoNote.kind !== 'clipboard') {
    event.preventDefault(); const {page, text, after} = undoNote; undoNote = null;
    if (after !== undefined && state.notes[page] !== after) return status('Note changed after formatting. Nothing was undone.');
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
  lecturePicker.setLectures(lectures);
  if (!lectures.length) { status('No lectures found. Add lecture files to this course.'); return; }
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('slide-tutor-position')) || {}; } catch {}
  await loadLecture(lectures.some(l => l.id === saved.lecture) ? saved.lecture : lectures[0].id, saved.page || 1);
}
// Classic CDN scripts must finish before Markdown / math rendering.
if (document.readyState === 'complete') init().catch(error => status(error.message)); else window.addEventListener('load', () => init().catch(error => status(error.message)), {once: true});
