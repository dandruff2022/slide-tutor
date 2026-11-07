import {noteValue} from './note-batch.mjs';

export const lineClipboardType = 'application/x-slide-tutor-cut';

export function selectedLines(text, indices) {
  const lines = text.split('\n'), picked = [...new Set(indices)].sort((a, b) => a - b);
  if (!picked.length || picked.some((index, i) => !Number.isInteger(index) || index < 0 || index >= lines.length || (i && index !== picked[i - 1] + 1))) {
    throw new Error('Select consecutive note lines.');
  }
  const first = picked[0], end = picked.at(-1) + 1;
  const start = lines.slice(0, first).reduce((n, line) => n + line.length + 1, 0);
  const content = lines.slice(first, end).join('\n');
  // Remove one separator with the moved lines, but never copy that separator to the clipboard.
  const removeStart = end === lines.length && first > 0 ? start - 1 : start;
  const removeEnd = end < lines.length ? start + content.length + 1 : text.length;
  return {first, end, start, contentEnd: start + content.length, removeStart, removeEnd, text: content};
}

export function matchesCut(cut, lecture, notes, token, text) {
  return !!cut && cut.lecture === lecture && cut.token === token && cut.text === text && (notes[cut.page] || '') === cut.before;
}

// Destination offsets refer to the original note. null means append as complete lines.
export function planPaste({notes, page, text, target = null, cut = null}) {
  text = text.replace(/\r\n?/g, '\n');
  const before = notes[page] || '';
  let base = before, start = target?.start ?? before.length, end = target?.end ?? before.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > before.length) throw new Error('Paste destination changed.');
  const changes = [];
  if (cut) {
    if ((notes[cut.page] || '') !== cut.before) throw new Error('Cut source changed. Nothing was moved.');
    const source = cut.before.slice(0, cut.removeStart) + cut.before.slice(cut.removeEnd);
    if (cut.page === page) {
      // Pasting inside the cut selection is a no-op, not a duplicate or a deletion.
      if (target && start <= cut.contentEnd && end >= cut.start) return [];
      base = source;
      const shift = offset => offset >= cut.removeEnd ? offset - (cut.removeEnd - cut.removeStart) : Math.min(offset, cut.removeStart);
      start = shift(start); end = shift(end);
    } else changes.push({page: cut.page, before: cut.before, text: source});
  }
  if (!target) { start = end = base.length; if (base && !base.endsWith('\n')) text = '\n' + text; }
  const after = base.slice(0, start) + text + base.slice(end);
  changes.push({page, before, text: after});
  return changes.filter(change => noteValue(change.before) !== noteValue(change.text));
}

// Both move and inverse Undo use the existing atomic endpoint, never two single-page writes.
export async function commitClipboard(changes, {state, api, saves, lock, onSaved, renderNotes}) {
  if (state.loading || state.noteTransaction) throw new Error('Notes are busy; paste again when ready.');
  if (!changes.length) return [];
  const {lecture, notes} = state;
  lock(true);
  try {
    await saves.flush();
    if (state.lecture !== lecture || state.notes !== notes) throw new Error('Lecture changed. Nothing was pasted.');
    if (changes.some(change => noteValue(notes[change.page] || '') !== noteValue(change.before))) throw new Error('Notes changed. Nothing was pasted.');
    const result = await (await api(`/api/lectures/${lecture}/notes/batch`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({changes})
    })).json();
    Object.assign(notes, result.notes); onSaved(lecture, result.notes);
    state.editLine = null; renderNotes();
    return changes.map(change => ({...change, text: result.notes[change.page]}));
  } finally { lock(false); }
}
