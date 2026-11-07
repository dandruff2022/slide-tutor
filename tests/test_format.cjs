const {test, before} = require('node:test');
const assert = require('node:assert/strict');
let formatNote, highlights, protectedSpans;
before(async () => ({formatNote, highlights, protectedSpans} = await import('../static/note-format.mjs')));
const range = (start, end, line = 0) => ({line, start, end});

test('emphasis wraps the exact occurrence, preserving surrounding whitespace', () => {
  for (const [kind, marker] of [['italic', '*'], ['bold', '**'], ['both', '***']]) {
    const result = formatNote('same same same', [range(5, 9)], kind);
    assert.equal(result.text, `same ${marker}same${marker} same`);
    assert.deepEqual(result.ranges, [range(5 + marker.length, 9 + marker.length)]);
  }
  assert.equal(formatNote('  hello  ', [range(0, 9)], 'bold').text, '  **hello**  ');
});

test('existing emphasis is upgraded without nesting', () => {
  assert.equal(formatNote('*word*', [range(1, 5)], 'bold').text, '**word**');
  assert.equal(formatNote('**word**', [range(2, 6)], 'both').text, '***word***');
  assert.equal(formatNote('**word**', [range(0, 8)], 'italic').text, '*word*');
});

test('all marker colors replace and clear an existing marker', () => {
  for (const color of ['yellow', 'green', 'blue', 'pink', 'purple']) {
    const open = color === 'yellow' ? '==' : `=={${color}}`;
    const result = formatNote('word', [range(0, 4)], color);
    assert.equal(result.text, `${open}word==`);
    assert.equal(highlights(result.text)[0].color, color);
    assert.equal(formatNote(result.text, result.ranges, 'clear').text, 'word');
    assert.equal(formatNote(result.text, result.ranges, 'blue').text, '=={blue}word==');
  }
});

test('multi-line formatting keeps heading/list prefixes and indentation', () => {
  const source = '### Title\n1. Parent\n   - Child\n     Continuation';
  const result = formatNote(source, [range(0, 9), range(0, 9, 1), range(0, 10, 2), range(0, 17, 3)], 'bold');
  assert.equal(result.text, '### **Title**\n1. **Parent**\n   - **Child**\n     **Continuation**');
});

test('inline/display math, code, and table source are protected', () => {
  const source = 'Word $x_1$ and `snake_case` done';
  const result = formatNote(source, [range(0, source.length)], 'bold');
  assert.equal(result.text, '**Word** $x_1$ **and** `snake_case` **done**');
  for (const source of [String.raw`x_1=\sum_i y_i`, '| cell | cell |', '`code`', '$x$']) {
    assert.equal(formatNote(source, [range(0, source.length)], 'blue').text, source);
  }
  assert.deepEqual(protectedSpans('a $x$ b `y`'), [[2, 5], [8, 11]]);
});

test('unsupported colors, out-of-date line ranges, and empty selections are safe', () => {
  assert.throws(() => formatNote('a', [range(0, 1)], 'red'), /Unknown note format/);
  assert.equal(formatNote('a', [range(0, 1, 9)], 'bold').text, 'a');
  assert.equal(formatNote('a', [range(0, 0)], 'bold').text, 'a');
  assert.equal(highlights('`==code==` $x==y$').length, 0);
  assert.equal(highlights('=={red}not a marker==').length, 0);
  assert.equal(highlights('==a=b==')[0].content, 'a=b');
  assert.equal(highlights('==use $x_1$ here==')[0].content, 'use $x_1$ here');
});

test('recoloring or clearing a selection handles every intersected highlight', () => {
  const source = '==one== and =={green}two==';
  assert.equal(formatNote(source, [range(0, source.length)], 'clear').text, 'one and two');
  assert.equal(formatNote(source, [range(0, source.length)], 'pink').text, '=={pink}one and two==');
  assert.equal(formatNote('=={green}word==', [range(10, 11)], 'blue').text, '=={blue}word==');
});

test('multilingual and surrogate-pair offsets use the editor UTF-16 convention', () => {
  const source = '中文 😀 中文';
  const result = formatNote(source, [range(6, 8)], 'bold');
  assert.equal(result.text, '中文 😀 **中文**');
});
