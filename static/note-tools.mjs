import {markerColors, formatNote, highlights} from './note-format.mjs';

export function mountNoteTools({state, setNote, renderNotes, status, getUndo, setUndo, track}) {
  const toolbar = document.createElement('div');
  toolbar.className = 'note-tools'; toolbar.hidden = true;
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Format note selection');
  document.body.append(toolbar);
  let selected = null, sequence = null;
  const currentText = () => state.notes[state.page] || '';
  const valid = selection => selection && selection.lecture === state.lecture && selection.page === state.page && selection.text === currentText();
  const signature = selection => selection && JSON.stringify([selection.lecture, selection.page, selection.text, selection.ranges]);
  function describe(ranges, editor = null) {
    return ranges.length ? {lecture: state.lecture, page: state.page, text: currentText(), ranges, editor} : null;
  }
  function selection() {
    const editor = document.activeElement;
    if (editor?.matches('.note.current textarea')) {
      if (editor.selectionStart === editor.selectionEnd) return null;
      return describe([{line: state.editLine, start: editor.selectionStart, end: editor.selectionEnd}], editor);
    }
    if (editor?.closest('input,textarea,select')) return null;
    const sel = getSelection(), body = document.querySelector('.note.current .note-body');
    if (!body || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    const ranges = [];
    for (const line of body.querySelectorAll('.note-line[data-i]')) {
      if (Number(line.dataset.n) !== 1 || line.querySelector('table')) continue;
      let start = Infinity, end = -1;
      for (const span of line.querySelectorAll('[data-note-start]')) {
        if (!range.intersectsNode(span)) continue;
        const part = document.createRange(); part.selectNodeContents(span);
        if (range.comparePoint(part.startContainer, part.startOffset) < 0) part.setStart(range.startContainer, range.startOffset);
        if (range.comparePoint(part.endContainer, part.endOffset) > 0) part.setEnd(range.endContainer, range.endOffset);
        if (part.collapsed || !part.toString()) continue;
        let a = Number(span.dataset.noteStart), b = Number(span.dataset.noteEnd);
        if (span.dataset.noteKind === 'text') {
          const prefix = document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(part.startContainer, part.startOffset);
          a += prefix.toString().length; b = a + part.toString().length;
        }
        start = Math.min(start, a); end = Math.max(end, b);
      }
      if (start < end) ranges.push({line: Number(line.dataset.i), start, end});
    }
    return describe(ranges);
  }
  function sourcePoint(line, offset, end) {
    const spans = [...document.querySelectorAll(`.note.current .note-line[data-i="${line}"] [data-note-start]`)];
    const span = (end ? spans.reverse() : spans).find(el => Number(el.dataset.noteStart) <= offset && Number(el.dataset.noteEnd) >= offset);
    if (!span) return null;
    if (span.dataset.noteKind === 'text' && span.firstChild?.nodeType === Node.TEXT_NODE) {
      return [span.firstChild, Math.max(0, Math.min(span.textContent.length, offset - Number(span.dataset.noteStart)))];
    }
    return [span.parentNode, [...span.parentNode.childNodes].indexOf(span) + (end ? 1 : 0)];
  }
  function restore(ranges) {
    if (!ranges.length) return;
    const first = ranges[0], last = ranges.at(-1);
    const start = sourcePoint(first.line, first.start, false), end = sourcePoint(last.line, last.end, true);
    if (!start || !end) return;
    const range = document.createRange(); range.setStart(...start); range.setEnd(...end);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }
  function position() {
    let rect;
    if (selected?.editor?.isConnected) rect = selected.editor.getBoundingClientRect();
    else if (getSelection().rangeCount) rect = getSelection().getRangeAt(0).getBoundingClientRect();
    if (!rect) return;
    toolbar.style.left = `${Math.max(6, Math.min(rect.left, innerWidth - toolbar.offsetWidth - 6))}px`;
    // Without room above, go below rather than cover the selection and its drag handle.
    const above = rect.top - toolbar.offsetHeight - 7, top = above >= 6 ? above : rect.bottom + 7;
    toolbar.style.top = `${Math.max(6, Math.min(top, innerHeight - toolbar.offsetHeight - 6))}px`;
  }
  function refresh() {
    if (toolbar.contains(document.activeElement) && valid(selected)) return;
    selected = selection();
    toolbar.hidden = !selected;
    if (!selected) return;
    const color = selected.ranges.map(range => highlights(selected.text.split('\n')[range.line])
      .find(mark => range.start >= mark.start && range.end <= mark.end)?.color);
    for (const button of toolbar.querySelectorAll('[data-color]')) {
      button.setAttribute('aria-pressed', String(color.length > 0 && color.every(value => value === button.dataset.color)));
    }
    position();
  }
  function apply(kind, base = selection() || selected, expected = base?.text) {
    if (state.noteTransaction || state.loading || !base || base.lecture !== state.lecture || base.page !== state.page || expected !== currentText()) { toolbar.hidden = true; sequence = null; return null; }
    const result = formatNote(base.text, base.ranges, kind);
    if (!result.ranges.length) {
      status('Select prose to format; formulas, code and table source stay unchanged.'); return null;
    }
    if (result.text === currentText()) return describe(result.ranges, base.editor);
    setUndo({lecture: state.lecture, page: state.page, text: base.text, after: result.text, kind: 'format', editLine: state.editLine});
    const editor = base.editor?.isConnected ? base.editor : null;
    if (editor && !editor.value.includes('\n') && result.ranges.every(range => range.line === state.editLine)) {
      editor.value = result.text.split('\n')[state.editLine]; editor.oninput();
      editor.focus(); editor.setSelectionRange(result.ranges[0].start, result.ranges.at(-1).end);
    } else {
      setNote(result.text); state.editLine = null; renderNotes(); restore(result.ranges);
    }
    selected = describe(result.ranges, editor);
    toolbar.hidden = false; position();
    track('note_formatted', {format: kind});
    status('Note formatted — ⌘Z to undo');
    return selected;
  }
  function button(label, title, kind, color = false) {
    const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
    item.title = title; item.setAttribute('aria-label', title);
    if (color) { item.className = `note-swatch note-highlight-${kind}`; item.dataset.color = kind; item.setAttribute('aria-pressed', 'false'); }
    item.onclick = () => { sequence = null; apply(kind); refresh(); };
    toolbar.append(item);
  }
  button('B', 'Bold (**)', 'bold'); button('I', 'Italic (*)', 'italic'); button('BI', 'Bold italic (***)', 'both');
  for (const color of markerColors) button('', `${color[0].toUpperCase() + color.slice(1)} highlight${color === 'yellow' ? ' (==)' : ''}`, color, true);
  button('×', 'Clear highlight', 'clear');
  toolbar.onmousedown = event => event.preventDefault();
  toolbar.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { toolbar.hidden = true; selected?.editor?.focus(); return; }
    const buttons = [...toolbar.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
    buttons[(at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
  });
  document.addEventListener('selectionchange', () => { refresh(); if (sequence && signature(selection()) !== sequence.signature) sequence = null; });
  document.addEventListener('mouseup', () => setTimeout(refresh));
  document.addEventListener('keyup', refresh);
  document.addEventListener('mousedown', event => { if (!toolbar.contains(event.target)) { sequence = null; toolbar.hidden = true; } });
  document.addEventListener('scroll', () => { if (!toolbar.hidden) position(); }, true);
  document.addEventListener('keydown', event => {
    const inNote = event.target.matches?.('.note.current textarea') || !!selection() || toolbar.contains(event.target);
    if (event.altKey && event.key === 'F10' && valid(selection() || selected)) {
      event.preventDefault(); event.stopImmediatePropagation(); selected = selection() || selected;
      toolbar.hidden = false; toolbar.querySelector('button').focus(); position(); return;
    }
    const undo = getUndo();
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && inNote &&
        undo?.kind === 'format' && undo.lecture === state.lecture && undo.page === state.page && undo.after === currentText()) {
      event.preventDefault(); event.stopImmediatePropagation();
      setUndo(null); setNote(undo.text); state.editLine = undo.editLine; state.caret = null;
      sequence = null; selected = null; toolbar.hidden = true; renderNotes(); status('Note formatting undone'); return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !['*', '='].includes(event.key)) { sequence = null; return; }
    const now = selection();
    if (!valid(now)) { sequence = null; return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (!sequence || sequence.key !== event.key || sequence.signature !== signature(now)) sequence = {key: event.key, count: 0, base: now};
    sequence.count++;
    if (event.key === '=' && sequence.count === 1) { sequence.signature = signature(now); status('Press = again for yellow highlight'); return; }
    const kind = event.key === '*' ? ['italic', 'bold', 'both'][Math.min(sequence.count, 3) - 1] : 'yellow';
    const active = sequence;
    const result = apply(kind, active.base, now.text);
    if (!result) { sequence = null; return; }
    active.signature = signature(selection()); sequence = active;
  }, true);
}
