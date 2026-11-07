const {test, before} = require('node:test');
const assert = require('node:assert/strict');
let selectedLines, matchesCut, planPaste, commitClipboard;
before(async () => ({selectedLines, matchesCut, planPaste, commitClipboard} = await import('../static/note-clipboard.mjs')));
const cutFor = (text, indices, page = 1) => ({...selectedLines(text, indices), before: text, page, lecture: 'L', token: 'local-token'});

test('line clipboard preserves exact Unicode, math and indentation without deleting its source', () => {
  const text = 'before\n  - 中文\n    x_1=2\nafter', copy = selectedLines(text, [1, 2]);
  assert.equal(copy.text, '  - 中文\n    x_1=2'); assert.equal(text, 'before\n  - 中文\n    x_1=2\nafter');
  assert.throws(() => selectedLines(text, [0, 2]), /consecutive/);
});
test('a pending Cut requires a matching local token, clipboard text, lecture and unchanged source', () => {
  const notes = {1: 'a\nb'}, cut = cutFor(notes[1], [0]);
  assert.equal(matchesCut(cut, 'L', notes, 'local-token', 'a'), true);
  for (const [lecture, source, token, text] of [['Other', notes, 'local-token', 'a'], ['L', {1: 'edited'}, 'local-token', 'a'], ['L', notes, '', 'a'], ['L', notes, 'local-token', 'new clipboard']]) {
    assert.equal(matchesCut(cut, lecture, source, token, text), false);
  }
});
test('copy pastes replace a range or append whole lines, preserving other text', () => {
  assert.deepEqual(planPaste({notes: {2: 'before\nafter'}, page: 2, text: 'one\r\ntwo'}), [{page: 2, before: 'before\nafter', text: 'before\nafter\none\ntwo'}]);
  assert.equal(planPaste({notes: {2: 'hello world'}, page: 2, text: 'new', target: {start: 6, end: 11}})[0].text, 'hello new');
});
test('same-page Cut moves in either direction and pasting into itself does nothing', () => {
  const notes = {1: 'a\nb\nc\nd'};
  assert.equal(planPaste({notes, page: 1, text: 'b\nc', cut: cutFor(notes[1], [1, 2])})[0].text, 'a\nd\nb\nc');
  assert.equal(planPaste({notes, page: 1, text: 'c\nd', target: {start: 0, end: 0}, cut: cutFor(notes[1], [2, 3])})[0].text, 'c\nda\nb');
  assert.deepEqual(planPaste({notes, page: 1, text: 'b', target: {start: 2, end: 3}, cut: cutFor(notes[1], [1])}), []);
  assert.deepEqual(planPaste({notes: {1: 'a'}, page: 1, text: 'a', cut: cutFor('a', [0])}), []);
});
test('cross-page Cut plans source and destination together and rejects stale sources', () => {
  const notes = {1: 'a\nb\nc', 2: 'existing'}, cut = cutFor(notes[1], [1]);
  assert.deepEqual(planPaste({notes, page: 2, text: 'b', cut}), [
    {page: 1, before: 'a\nb\nc', text: 'a\nc'}, {page: 2, before: 'existing', text: 'existing\nb'}]);
  assert.throws(() => planPaste({notes: {...notes, 1: 'edited'}, page: 2, text: 'b', cut}), /source changed/);
});
function transaction({fail = false, failFlush = false} = {}) {
  const state = {lecture: 'L', notes: {1: 'source', 2: 'existing'}}, writes = [], saved = [], locks = [];
  const deps = {state, saves: {flush: async () => { if (failFlush) throw new Error('save failed'); }},
    api: async (url, options) => {
      writes.push(JSON.parse(options.body).changes); if (fail) throw new Error('conflict');
      return {json: async () => ({notes: Object.fromEntries(writes.at(-1).map(c => [c.page, c.text]))})};
    }, lock(locked) { state.noteTransaction = locked; locks.push(locked); }, onSaved: (...args) => saved.push(args), renderNotes() {}};
  const changes = [{page: 1, before: 'source', text: ''}, {page: 2, before: 'existing', text: 'existing\nsource'}];
  return {state, deps, changes, writes, saved, locks};
}
test('move and Undo are each one snapshot-checked transaction with saved-cache refresh', async () => {
  const f = transaction(), committed = await commitClipboard(f.changes, f.deps);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.state.notes, {1: '', 2: 'existing\nsource'});
  assert.equal(f.saved.length, 1); assert.deepEqual(f.locks, [true, false]);
  await commitClipboard(committed.map(c => ({page: c.page, before: c.text, text: c.before})), f.deps);
  assert.deepEqual(f.state.notes, {1: 'source', 2: 'existing'}); assert.equal(f.writes.length, 2);
});
test('a failed Paste retains the preceding Undo handle in the app integration', async () => {
  const vm = require('node:vm'), {readFileSync} = require('node:fs'), {join} = require('node:path');
  const source = readFileSync(join(__dirname, '../static/app.js'), 'utf8'), handlers = {};
  const previousUndo = {lecture: 'L', page: 1, text: 'deleted lines'};
  const state = {lecture: 'L', page: 1, notes: {1: 'remaining'}};
  const context = {state, undoNote: previousUndo, pendingCut: null, planPaste, matchesCut, selectedLines, commitClipboard,
    lineClipboardType: 'application/x-slide-tutor-cut', pickedLines: () => [],
    $: () => ({contains: () => true, focus() {}}), document: {addEventListener: (name, handler) => { handlers[name] = handler; }},
    api: async () => { throw new Error('offline'); }, saves: {flush: async () => {}},
    lockNotes(locked) { state.noteTransaction = locked; if (locked) context.undoNote = null; },
    rememberSavedNotes() {}, renderNotes() {}, cancelPendingCut() {}, status() {}, track() {},
    getSelection: () => ({removeAllRanges() {}})};
  vm.createContext(context);
  const start = source.indexOf('const clipboardWrites =');
  vm.runInContext(source.slice(start, source.indexOf("$('notes').addEventListener('pointerdown'", start)), context);
  await handlers.paste({target: {closest: () => null}, clipboardData: {getData: type => type === 'text/plain' ? 'paste' : ''}, preventDefault() {}});
  assert.equal(context.undoNote, previousUndo); assert.equal(state.notes[1], 'remaining');
});

test('deferred Paste into the unsaved + line editor appends complete lines', async () => {
  const vm = require('node:vm'), {readFileSync} = require('node:fs'), {join} = require('node:path');
  const source = readFileSync(join(__dirname, '../static/app.js'), 'utf8'), handlers = {};
  const state = {lecture: 'L', page: 1, editLine: 2, notes: {1: 'first\nsecond'}};
  const editor = {selectionStart: 0, selectionEnd: 0};
  const context = {state, undoNote: null, pendingCut: cutFor(state.notes[1], [0]), planPaste, matchesCut, selectedLines, commitClipboard,
    lineClipboardType: 'application/x-slide-tutor-cut', pickedLines: () => [],
    $: () => ({contains: () => true, focus() {}}), document: {addEventListener: (name, handler) => { handlers[name] = handler; }},
    api: async (url, options) => ({json: async () => ({notes: Object.fromEntries(JSON.parse(options.body).changes.map(c => [c.page, c.text]))})}),
    saves: {flush: async () => {}}, lockNotes(locked) { state.noteTransaction = locked; if (locked) context.undoNote = null; },
    rememberSavedNotes() {}, renderNotes() {}, cancelPendingCut() { context.pendingCut = null; }, status() {}, track() {},
    getSelection: () => ({removeAllRanges() {}})};
  vm.createContext(context);
  const start = source.indexOf('const clipboardWrites =');
  vm.runInContext(source.slice(start, source.indexOf("$('notes').addEventListener('pointerdown'", start)), context);
  await handlers.paste({target: {closest: selector => selector === '.note.current textarea' ? editor : null},
    clipboardData: {getData: type => type === 'text/plain' ? 'first' : 'local-token'}, preventDefault() {}});
  assert.equal(state.notes[1], 'second\nfirst'); assert.equal(context.undoNote.kind, 'clipboard');
});

test('save/network/local conflicts and overlapping transactions leave both notes unchanged', async () => {
  for (const config of [{fail: true}, {failFlush: true}]) {
    const f = transaction(config); await assert.rejects(commitClipboard(f.changes, f.deps));
    assert.deepEqual(f.state.notes, {1: 'source', 2: 'existing'}); assert.equal(f.state.noteTransaction, false);
  }
  const local = transaction(); local.state.notes[1] = 'changed';
  await assert.rejects(commitClipboard(local.changes, local.deps), /Notes changed/); assert.equal(local.writes.length, 0);
  const busy = transaction(); busy.state.noteTransaction = true;
  await assert.rejects(commitClipboard(busy.changes, busy.deps), /busy/); assert.equal(busy.writes.length, 0);
});
