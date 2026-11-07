const {test} = require('node:test');
const assert = require('node:assert/strict');

test('formatting the first line of a pasted multiline editor preserves the later lines', async t => {
  const {mountNoteTools} = await import('../static/note-tools.mjs');
  const oldDocument = global.document, oldSelection = global.getSelection;
  t.after(() => { global.document = oldDocument; global.getSelection = oldSelection; });
  const state = {lecture: 'L', page: 1, editLine: 0, notes: {1: 'first\nsecond'}};
  let toolbar;
  const editor = {value: state.notes[1], selectionStart: 0, selectionEnd: 5, isConnected: true,
    matches: () => true, focus() {}, setSelectionRange() {},
    oninput() { state.notes[1] = editor.value; }};
  const element = () => ({children: [], style: {}, dataset: {},
    setAttribute() {}, addEventListener() {}, append(child) { this.children.push(child); },
    contains: () => false, querySelectorAll: () => []});
  global.document = {activeElement: editor, createElement: element, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    body: {append(el) { toolbar = el; }}};
  global.getSelection = () => ({rangeCount: 0});
  mountNoteTools({state, setNote: text => { state.notes[1] = text; },
    renderNotes() { editor.isConnected = false; document.activeElement = null; },
    status() {}, getUndo() {}, setUndo() {}, track() {}});
  toolbar.children[0].onclick();
  assert.equal(state.notes[1], '**first**\nsecond');
});
