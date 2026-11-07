// Canonical note values match the Markdown section writer (empty/absent notes are equivalent).
export const noteValue = text => text?.trim() ? text.replace(/^\n+|\n+$/g, '') : '';

export function proposalText(answer) {
  // Hide even a partially streamed fence; it must never fall back to a current-page apply block.
  const at = answer.search(/^```note-proposal\b/m);
  if (at >= 0) return answer.slice(0, at);
  const line = answer.slice(answer.lastIndexOf('\n') + 1);
  return line && '```note-proposal'.startsWith(line) ? answer.slice(0, -line.length) : answer;
}

export function createNoteSaves(write, onError = () => {}, delay = 400) {
  const pending = new Map();
  let tail = Promise.resolve();
  function enqueue(item) {
    clearTimeout(item.timer); item.timer = null;
    const task = tail.then(async () => {
      if (pending.get(item.key) !== item) return;
      try {
        await write(item.lecture, item.page, item.text);
        if (pending.get(item.key) === item) pending.delete(item.key);
      } catch (error) { onError(error); throw error; }
    });
    tail = task.catch(() => {});
    return task;
  }
  return {
    save(lecture, page, text) {
      const key = `${lecture}:${page}`;
      clearTimeout(pending.get(key)?.timer);
      const item = {key, lecture, page, text};
      pending.set(key, item);
      item.timer = setTimeout(() => { enqueue(item).catch(() => {}); }, delay);
    },
    async flush() {
      // Await in-flight writes too. Retry failed saves, but propagate failures to the caller.
      await tail;
      while (pending.size) {
        const items = [...pending.values()];
        await Promise.all(items.map(enqueue));
      }
    }
  };
}

export function batchChanges(proposal, notes, undo = false) {
  return proposal.changes.map(change => {
    const before = undo ? change.text : change.before, text = undo ? change.before : change.text;
    if (noteValue(notes[change.page] || '') !== noteValue(before)) {
      throw new Error(`Local note p.${change.page} changed. Nothing was applied; request a new proposal.`);
    }
    return {page: change.page, before, text};
  });
}

export function offerBatch(proposal, {state, container, api, saves, renderNotes, status, goPage, track, lock, onSaved = () => {}}) {
  const box = document.createElement('section'); box.className = 'note-proposal';
  const heading = document.createElement('h3'); heading.textContent = `Review note changes · ${proposal.lecture}`;
  const summary = document.createElement('p'); summary.textContent = proposal.summary;
  const intent = document.createElement('p'); intent.textContent = `Interpreted intent: “${proposal.intent || 'current page only'}”`;
  box.append(heading, summary, intent);
  for (const change of proposal.changes) {
    const details = document.createElement('details'), title = document.createElement('summary');
    title.textContent = `p.${change.page}${!change.text ? ' — note will be emptied' : ''}`;
    const jump = document.createElement('button'); jump.textContent = `View slide p.${change.page}`;
    jump.onclick = () => state.lecture === proposal.lecture ? goPage(change.page) : status(`Open ${proposal.lecture} to review.`);
    details.append(title, jump);
    for (const [label, text] of [['Before', change.before], ['After', change.text]]) {
      const caption = document.createElement('strong'), source = document.createElement('pre');
      caption.textContent = label; source.textContent = text || '[empty note]';
      details.append(caption, source);
    }
    box.append(details);
  }
  const apply = document.createElement('button'), undo = document.createElement('button'), cancel = document.createElement('button');
  apply.textContent = `Apply changes to ${proposal.changes.map(c => `p.${c.page}`).join(', ')}`;
  undo.textContent = 'Undo all changes'; undo.hidden = true; cancel.textContent = 'Cancel';
  cancel.onclick = () => { box.remove(); track('note_proposal_cancelled'); };
  let running = false;
  async function transact(inverse) {
    if (running || state.noteTransaction || state.loading) return;
    if (state.lecture !== proposal.lecture) return status(`Open ${proposal.lecture} before applying or undoing.`);
    running = true; apply.disabled = undo.disabled = cancel.disabled = true; lock(true);
    try {
      const notes = state.notes;
      await saves.flush();
      if (state.lecture !== proposal.lecture || state.notes !== notes) throw new Error('Lecture changed; nothing was applied.');
      const changes = batchChanges(proposal, notes, inverse);
      const result = await (await api(`/api/lectures/${proposal.lecture}/notes/batch`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({changes})
      })).json();
      Object.assign(notes, result.notes); onSaved(proposal.lecture, result.notes);
      state.editLine = null; renderNotes();
      apply.hidden = !inverse; undo.hidden = inverse;
      box.dataset.applied = String(!inverse); cancel.textContent = inverse ? 'Cancel' : 'Dismiss Undo';
      status(inverse ? 'All note changes undone.' : 'All note changes saved — Undo all changes is available.');
      track(inverse ? 'note_batch_undone' : 'note_batch_applied', {pages: changes.map(c => c.page)});
    } catch (error) { status(error.message); }
    finally { running = false; lock(false); apply.disabled = undo.disabled = cancel.disabled = false; }
  }
  apply.onclick = () => transact(false); undo.onclick = () => transact(true);
  box.append(apply, undo, cancel); container.append(box);
}
