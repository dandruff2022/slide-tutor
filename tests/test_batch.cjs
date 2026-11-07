const {test, before} = require('node:test');
const assert = require('node:assert/strict');
let createNoteSaves, proposalText, batchChanges, offerBatch;
before(async () => ({createNoteSaves, proposalText, batchChanges, offerBatch} = await import('../static/note-batch.mjs')));
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

test('proposal source stays hidden, including incomplete streaming fences', () => {
  for (let i = 1; i <= '```note-proposal'.length; i++) {
    assert.equal(proposalText('Answer\n' + '```note-proposal'.slice(0, i)), 'Answer\n');
  }
  assert.equal(proposalText('Answer\n```note-proposal\n{"text":"```latex"}'), 'Answer\n');
  assert.equal(proposalText('Answer\n```latex\nx=y\n```'), 'Answer\n```latex\nx=y\n');
  assert.equal(proposalText('normal answer'), 'normal answer');
});

test('debounced saves serialize old and new writes before a batch can start', async () => {
  const order = []; let release;
  const saves = createNoteSaves(async (lecture, page, text) => {
    order.push(text);
    if (text === 'old') await new Promise(resolve => { release = resolve; });
  }, () => {}, 1);
  saves.save('L', 2, 'old'); await pause();
  saves.save('L', 2, 'new');
  const flushing = saves.flush().then(() => order.push('batch'));
  await pause(); assert.deepEqual(order, ['old']);
  release(); await flushing;
  assert.deepEqual(order, ['old', 'new', 'batch']);
  saves.save('L', 2, 'superseded'); saves.save('L', 2, 'latest'); saves.save('L', 3, 'other page');
  await saves.flush();
  assert.deepEqual(order.slice(-2), ['latest', 'other page']);
});

test('failed saves are retained and flush aborts rather than allowing a batch overwrite', async () => {
  let fail = true, written = 0;
  const saves = createNoteSaves(async () => { written++; if (fail) throw new Error('offline'); }, () => {}, 10000);
  saves.save('L', 1, 'keep locally');
  await assert.rejects(saves.flush(), /offline/);
  fail = false; await saves.flush();
  assert.equal(written, 2);
});

test('batch and inverse reject local changes and preserve empty-note equivalence', () => {
  const proposal = {changes: [{page: 2, before: 'source', text: ''}, {page: 5, before: '', text: 'source'}]};
  assert.deepEqual(batchChanges(proposal, {2: 'source'}), proposal.changes);
  assert.deepEqual(batchChanges(proposal, {5: 'source'}, true), [
    {page: 2, before: '', text: 'source'}, {page: 5, before: 'source', text: ''}
  ]);
  assert.throws(() => batchChanges(proposal, {2: 'edited'}), /p.2 changed/);
  assert.throws(() => batchChanges(proposal, {5: 'edited'}, true), /p.5 changed/);
});

test('stream integration offers nothing on disconnect/error or an unvalidated proposal block', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../static/app.js'), 'utf8');
  const send = source.slice(source.indexOf('async function send(mode)'), source.indexOf('// 🔗 between response'));
  async function run(events) {
    let offers = 0, lastStatus = '';
    const elements = Object.fromEntries(['prompt', 'ask', 'check', 'response', 'response-lang', 'note-lang', 'model'].map(id => {
      const el = new Element('div'); el.value = id === 'prompt' ? 'Move note to p.5' : 'en'; el.dataset = {};
      el.replaceChildren = (...children) => { el.children = children; }; return [id, el];
    }));
    const state = {lecture: 'L', page: 2, pdf: {}, notes: {2: 'source'}};
    let read = false;
    const context = {state, $: id => elements[id], history: [], historyIndex: 0, pending: '', linked: false, thread: [],
      localStorage: {setItem() {}}, document: {createElement: tag => new Element(tag)},
      saves: {flush: async () => {}}, slideCanvas: async () => ({toDataURL: () => 'image'}),
      api: async () => ({body: {getReader: () => ({read: async () => {
        if (read) return {done: true}; read = true;
        return {value: new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')), done: false};
      }})}}), TextDecoder, setTimeout, clearTimeout, status(text) { lastStatus = text; }, updateLink() {}, scrollPanel() {},
      markdown() {}, proposalText, rememberSavedNotes() {}, offerApply() { offers++; }, offerBatch() { offers++; }, goPage() {}, renderNotes() {}, track() {}, lockNotes() {}
    };
    await vm.runInNewContext(send + '\nsend("ask")', context);
    if (events.some(e => e.type === 'proposal') && events.at(-1)?.type === 'done' && !offers) throw new Error(lastStatus);
    return offers;
  }
  const delta = {type: 'delta', text: '```note-proposal\n{"text":"```latex\\nwrong\\n```"}'};
  assert.equal(await run([delta]), 0);
  assert.equal(await run([delta, {type: 'proposal', proposal: {}}, {type: 'error', message: 'failed'}]), 0);
  assert.equal(await run([delta, {type: 'proposal', proposal: {}}]), 0);
  assert.equal(await run([delta, {type: 'done'}]), 0);
  assert.equal(await run([delta, {type: 'proposal', proposal: {}}, {type: 'done'}]), 1);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.dataset = {}; }
  querySelectorAll() { return this.children.filter(child => child.dataset?.applied === 'true'); }
  append(...items) { this.children.push(...items); }
  remove() { this.removed = true; }
}
function fixture({flush = async () => {}, fail = false} = {}) {
  global.document = {createElement: tag => new Element(tag)};
  const state = {lecture: 'L', notes: {2: 'source', 5: 'existing', 8: 'unrelated'}};
  const proposal = {lecture: 'L', summary: '<script>not HTML</script>', intent: 'Move to p.5', changes: [
    {page: 2, before: 'source', text: ''}, {page: 5, before: 'existing', text: 'existing\nsource'}
  ]};
  const container = new Element('div'), requests = [], messages = [], saved = [];
  offerBatch(proposal, {state, container, saves: {flush}, status: text => messages.push(text), onSaved: (lecture, notes) => saved.push({lecture, notes}),
    api: async (url, options) => {
      const {changes} = JSON.parse(options.body); requests.push(changes);
      if (fail) throw new Error('conflict');
      return {json: async () => ({notes: Object.fromEntries(changes.map(c => [c.page, c.text]))})};
    }, renderNotes() {}, goPage() {}, track() {}, lock: value => { state.noteTransaction = value; }});
  const box = container.children[0], [apply, undo, cancel] = box.children.slice(-3);
  return {state, proposal, requests, messages, saved, box, apply, undo, cancel};
}

test('preview/cancel never writes; explicit apply and undo update the complete batch', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  assert.equal(f.box.children[1].textContent, '<script>not HTML</script>');
  await f.apply.onclick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].length, 2);
  assert.deepEqual(f.state.notes, {2: '', 5: 'existing\nsource', 8: 'unrelated'});
  assert.equal(f.undo.hidden, false);
  assert.equal(f.box.dataset.applied, 'true');
  assert.equal(f.cancel.textContent, 'Dismiss Undo');
  assert.deepEqual(f.saved[0], {lecture: 'L', notes: {2: '', 5: 'existing\nsource'}});
  await f.undo.onclick();
  assert.equal(f.box.dataset.applied, 'false');
  assert.deepEqual(f.state.notes, {2: 'source', 5: 'existing', 8: 'unrelated'});
  const cancelled = fixture(); cancelled.cancel.onclick();
  assert.equal(cancelled.box.removed, true); assert.equal(cancelled.requests.length, 0);
});

test('local conflict, save failure, server conflict, and lecture change leave notes unchanged', async () => {
  const local = fixture(); local.state.notes[5] = 'local edit'; await local.apply.onclick();
  assert.equal(local.requests.length, 0); assert.match(local.messages.at(-1), /Local note/);
  const save = fixture({flush: async () => { throw new Error('save failed'); }}); await save.apply.onclick();
  assert.equal(save.requests.length, 0); assert.equal(save.state.notes[2], 'source');
  const server = fixture({fail: true}); await server.apply.onclick();
  assert.equal(server.state.notes[2], 'source'); assert.equal(server.undo.hidden, true);
  const lecture = fixture(); lecture.state.lecture = 'other'; await lecture.apply.onclick();
  assert.equal(lecture.requests.length, 0);
  assert.equal(server.state.noteTransaction, false);
});
