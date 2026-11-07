const {test} = require('node:test');
const assert = require('node:assert/strict');
let edgeScrollSpeed, noteAutoScroll;
test.before(async () => ({edgeScrollSpeed, noteAutoScroll} = await import('../static/note-drag.mjs')));
const rect = {left: 100, right: 400, top: 20, bottom: 420, height: 400};

test('scroll speed is directional, bounded and confined to the panel edges', () => {
  assert.equal(edgeScrollSpeed(rect, 200, 20), -600);
  assert.equal(edgeScrollSpeed(rect, 200, 420), 600);
  assert.equal(edgeScrollSpeed(rect, 200, 44), -300);
  assert.equal(edgeScrollSpeed(rect, 200, 396), 300);
  for (const [x, y] of [[200, 200], [99, 20], [401, 420], [200, 19], [200, 421]]) {
    assert.equal(edgeScrollSpeed(rect, x, y), 0);
  }
});

test('stationary edge drag scrolls each frame and recomputes the drop target', () => {
  let callback, id = 0, updates = 0;
  const cancelled = [], panel = {scrollTop: 200, getBoundingClientRect: () => rect};
  const scroll = noteAutoScroll(panel, (x, y) => { assert.equal(x, 200); assert.equal(y, 20); updates++; },
    fn => { callback = fn; return ++id; }, handle => cancelled.push(handle));
  scroll.move(200, 20); assert.equal(id, 1);
  scroll.move(200, 20); assert.equal(id, 1); // one animation loop, not one per dragover
  callback(100); assert.equal(panel.scrollTop, 190);
  callback(116); assert.equal(panel.scrollTop, 180.4);
  callback(1116); assert.equal(panel.scrollTop, 150.4); // cap delayed frames
  assert.equal(updates, 3);
  scroll.stop(); assert.deepEqual(cancelled, [4]);
  const before = panel.scrollTop; callback(1132); assert.equal(panel.scrollTop, before);
});

test('center, panel exit and explicit stop cancel scrolling; bottom edge restarts it', () => {
  let callback, id = 0;
  const cancelled = [], panel = {scrollTop: 0, getBoundingClientRect: () => rect};
  const scroll = noteAutoScroll(panel, () => {}, fn => { callback = fn; return ++id; }, handle => cancelled.push(handle));
  scroll.move(200, 420); callback(0); assert.equal(panel.scrollTop, 10);
  scroll.move(200, 200); assert.deepEqual(cancelled, [2]);
  scroll.move(200, 420); scroll.move(401, 420); assert.deepEqual(cancelled, [2, 3]);
  scroll.move(200, 420); callback(1000); assert.equal(panel.scrollTop, 20);
  scroll.stop(); scroll.stop(); assert.deepEqual(cancelled, [2, 3, 5]);
});
