const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const source = readFileSync(join(__dirname, '../static/app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
class Element {
  constructor() { this.children = []; this.hidden = false; this.dataset = {}; }
  append(...items) { this.children.push(...items); }
  querySelectorAll() { return this.children; }
}
function actions(how = 'append') {
  const response = new Element(), messages = [], writes = [];
  const state = {lecture: 'L', page: 1, notes: {1: 'original', 2: 'destination'}};
  const context = {state, document: {createElement: () => new Element()}, $: () => response,
    status: text => messages.push(text), renderNotes() {}, track() {},
    setNote(text) { state.notes[state.page] = text; writes.push([state.lecture, state.page, text]); }};
  vm.createContext(context);
  vm.runInContext(section(source.includes('function refreshNoteActions()') ? 'function refreshNoteActions()' : 'function offerApply(', '// ---- Select part'), context);
  context.offerApply('suggestion', 'L', 1, how);
  return {context, state, messages, writes, apply: response.children[0], undo: response.children[1]};
}
test('suggestions append to the current destination, update labels, and keep undo bound to it', () => {
  const f = actions(); f.state.page = 2; f.context.refreshNoteActions();
  assert.match(f.apply.textContent, /current page \(p.2\)/);
  assert.equal(f.apply.disabled, false); f.apply.onclick();
  assert.equal(f.state.notes[1], 'original'); assert.equal(f.state.notes[2], 'destination\nsuggestion');
  f.state.page = 1; f.context.refreshNoteActions(); assert.equal(f.undo.disabled, true);
  f.undo.onclick(); assert.equal(f.state.notes[1], 'original');
  f.state.page = 2; f.undo.onclick(); assert.equal(f.state.notes[2], 'destination');
});
test('suggestions can target another lecture; undo refuses later edits and locked notes', () => {
  const f = actions(); f.state.lecture = 'Other'; f.state.notes = {1: 'other'};
  f.apply.onclick(); assert.deepEqual(f.writes[0], ['Other', 1, 'other\nsuggestion']);
  f.state.notes[1] += '\nmy edit'; f.undo.onclick();
  assert.equal(f.state.notes[1], 'other\nsuggestion\nmy edit'); assert.match(f.messages.at(-1), /changed/);
  const locked = actions(); locked.state.noteTransaction = true; locked.apply.onclick(); assert.equal(locked.writes.length, 0);
});
test('Check replacements remain bound to their source page and refuse stale notes', () => {
  const f = actions('replace'); f.state.page = 2; f.context.refreshNoteActions();
  assert.equal(f.apply.disabled, true); f.apply.onclick(); assert.equal(f.state.notes[2], 'destination');
  f.state.page = 1; f.state.notes[1] = 'later edit'; f.apply.onclick();
  assert.equal(f.state.notes[1], 'later edit'); assert.match(f.messages.at(-1), /changed/);
});
test('autosaves compare the last saved snapshot and retain it after a failure', async () => {
  const {createNoteSaves} = await import('../static/note-batch.mjs');
  const requests = []; let fail = false;
  const context = {createNoteSaves, status() {}, api: async (url, options) => {
    requests.push(JSON.parse(options.body)); if (fail) throw new Error('conflict');
  }};
  vm.createContext(context);
  vm.runInContext(section('const savedNotes =', 'function saveNote('), context);
  context.rememberSavedNotes('L', {1: 'old'});
  await vm.runInContext("saves.save('L', 1, 'new'); saves.flush()", context);
  assert.deepEqual(requests[0], {text: 'new', before: 'old'});
  fail = true;
  await assert.rejects(vm.runInContext("saves.save('L', 1, 'edited'); saves.flush()", context), /conflict/);
  fail = false; await vm.runInContext('saves.flush()', context);
  assert.deepEqual(requests.at(-1), {text: 'edited', before: 'new'});
});

test('newest lecture wins when older loads finish later', async () => {
  const pending = {}, destroyed = [], elements = {}, state = {lecture: 'initial', renderId: 0, notes: {}};
  const context = {state, linked: false, lectureLoadId: 0, saves: {flush: async () => {}}, cancelNoteDrag() {},
    $: id => elements[id] ||= {value: '', setAttribute() {}}, status() {}, refreshNoteActions() {}, rememberSavedNotes() {},
    lecturePicker: {select(id) { elements.lecture ||= {}; elements.lecture.value = id; }},
    pdfjsLib: {getDocument(url) {
      const id = url.match(/\/([^/]+)\.pdf/)[1];
      return {promise: new Promise(resolve => { pending[id] = () => resolve({numPages: 3, destroy: () => destroyed.push(id)}); }), destroy() { destroyed.push(id); }};
    }}, api: async () => ({json: async () => ({})}), goPage: async () => {}, updateLink() {}, find() {}};
  vm.createContext(context); vm.runInContext(section('async function loadLecture(', '// ---- Find'), context);
  const first = context.loadLecture('A');
  await new Promise(resolve => setImmediate(resolve));
  const last = context.loadLecture('B');
  await new Promise(resolve => setImmediate(resolve));
  pending.B(); await last; pending.A(); await first;
  assert.equal(state.lecture, 'B'); assert.equal(elements.lecture.value, 'B');
  if (pending.A) assert.ok(destroyed.includes('A'));
});
