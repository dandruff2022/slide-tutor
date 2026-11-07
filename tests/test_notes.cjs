// Rendering decisions without CDN or browser dependencies; browser checks cover layout and KaTeX.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

function element() {
  return {
    className: '', style: {}, children: [], dataset: {},
    classList: {add() {}, remove() {}},
    append(...children) { this.children.push(...children); }
  };
}
const source = readFileSync(join(__dirname, '../static/app.js'), 'utf8');
const context = vm.createContext({
  document: {createElement: element},
  katex: {render(formula, el) { el.formula = formula; }}
});
vm.runInContext(source.slice(source.indexOf('// Keep source-line boundaries'), source.indexOf('async function api(')) +
  '\nfunction markdown(el, text) { el.markdown = text; }\nfunction noteMarkdown(el, text) { el.markdown = text; }', context);
let formatting;
test.before(async () => { formatting = await import('../static/note-format.mjs'); context.rawFormula = formatting.rawFormula; });
const render = text => context.renderLine(text);

test('explicit nesting and formula continuation keep indentation without code blocks', () => {
  const item = render('  - Child with $x$');
  assert.equal(item.style.marginLeft, '1em');
  assert.equal(item.children[0].textContent, '•');
  assert.equal(item.children[1].markdown, 'Child with $x$');
  const formula = render('    x_1=2');
  assert.equal(formula.style.marginLeft, '2em');
  assert.equal(formula.formula, 'x_1=2');
  const prose = render('    Continuation text');
  assert.equal(prose.markdown, 'Continuation text');
});

test('ordered markers are literal and independent of Markdown list numbering', () => {
  for (const text of ['3. Define $x$', '3) Define $x$']) {
    const item = render(text);
    assert.match(item.children[0].textContent, /^3[.)]$/);
    assert.equal(item.children[1].markdown, 'Define $x$');
  }
  const legacy = render(String.raw`4.\quad x_1=2`);
  assert.equal(legacy.children[0].textContent, '4.');
  assert.equal(legacy.children[1].formula, 'x_1=2');
});

test('headings, gaps and tables retain source boundaries for editing', () => {
  assert.equal(render('### Section').markdown, '### Section');
  const lines = ['### Section', '', '1. Parent', '   - Child', '     x_1=2', '  | A | B |', '  | --- | --- |', '  | a | b |'];
  const ranges = context.blocks(lines);
  assert.deepEqual(JSON.parse(JSON.stringify(ranges)), [[0,1],[1,2],[2,3],[3,4],[4,5],[5,8]]);
  const table = context.renderBlock(lines, 5, 8);
  assert.equal(table.style.marginLeft, '1em');
  assert.ok(table.markdown.startsWith('| A | B |'));
  context.lines = lines;
  const rendered = vm.runInContext('renderLines(lines)', context);
  assert.equal(rendered.length, ranges.length);
  assert.equal(rendered[1].innerHTML, '&nbsp;');
});

test('raw mathematical signs are preserved rather than converted into list markers', () => {
  for (const sign of ['-', '+']) {
    const formula = `${sign} \\frac{x_1}{2}`;
    assert.equal(render(formula).formula, formula);
  }
  const item = render(String.raw`- \quad x_1=2`);
  assert.equal(item.children[0].textContent, '•');
  assert.equal(item.children[1].formula, 'x_1=2');
});

test('math stays math; prose and inline math stay Markdown', () => {
  assert.equal(render(String.raw`p_\theta(x)=x^2`).formula, String.raw`p_\theta(x)=x^2`);
  assert.equal(render('Use $q_\\phi$ here.').markdown, 'Use $q_\\phi$ here.');
  assert.equal(render('The variable snake_case is text').markdown, 'The variable snake_case is text');
});
