// Run with Playwright available via NODE_PATH, against a disposable "Review sandbox" course.
// Requires a four-page Lecture2. p.1 is 80 lines: `Line 000 sample selectable text`
// through `Line 079 sample selectable text`; p.2 is `Other page must stay unchanged`.
// p.3/p.4 must be empty. The script modifies them; recreate the fixture before rerunning.
// Never point this at a real course: clipboard regression tests write sandbox notes.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 850}, ignoreHTTPSErrors: true});
  const errors = [], passed = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, message) => { assert.ok(value, message); passed.push(message); };
  const notes = () => page.evaluate(async () => (await fetch('/api/lectures/Lecture2/notes')).json());
  const select = async (first, last) => {
    await page.evaluate(([first, last]) => {
      document.getElementById('notes').focus();
      const a = document.querySelector(`.note.current .note-line[data-i="${first}"]`);
      const b = document.querySelector(`.note.current .note-line[data-i="${last}"]`);
      const range = document.createRange(); range.selectNodeContents(a); range.setEndAfter(b);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    }, [first, last]);
    await page.waitForFunction(() => document.querySelector('.has-picked .note-drag'));
  };
  const begin = async (first, last) => {
    await select(first, last);
    const handle = page.locator('.has-picked .note-drag').first();
    await handle.scrollIntoViewIfNeeded();
    const r = await handle.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 12, r.y + r.height / 2 + 8, {steps: 5});
  };
  const scrollTop = () => page.locator('#notes').evaluate(el => el.scrollTop);
  const undo = async () => { await page.locator('#notes').focus(); await page.keyboard.press('Control+z'); };
  try {
    await page.goto(process.env.SLIDE_TUTOR_TEST_URL || 'http://127.0.0.1:18793');
    assert.match(await page.title(), /Review sandbox/);
    await page.waitForSelector('.note.current .note-line');
    const original = await notes();
    assert.equal(original[1], Array.from({length: 80}, (_, i) => `Line ${String(i).padStart(3, '0')} sample selectable text`).join('\n'));
    assert.equal(original[2], 'Other page must stay unchanged');
    const editor = page.locator('.note.current textarea'), settle = () => page.waitForTimeout(400);  // past the double-click wait
    const lineAt = i => page.locator(`.note.current .note-line[data-i="${i}"]`);
    const line = lineAt(0);
    await line.dblclick(); await settle();
    check(await page.evaluate(() => !getSelection().isCollapsed) && !await editor.count(), 'Double-click selects a word, not an editor');
    await line.click(); await settle();
    check(!await editor.count(), 'A click that clears a selection does not edit');
    const a = await line.boundingBox(), b = await lineAt(2).boundingBox();
    await page.mouse.move(a.x + 3, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + 100, b.y + b.height / 2, {steps: 10}); await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll('.picked').length >= 3); await settle();
    check(!await editor.count(), 'Native text drag selects multiple lines without editing');
    await page.locator('#notes').focus(); await page.keyboard.press('Enter');
    check(await editor.inputValue() === 'Line 000 sample selectable text', 'Enter edits the first selected line');
    await page.keyboard.press('Escape');
    await line.click(); await settle();
    check(await editor.count() === 1, 'Plain click enters a line editor');
    await lineAt(1).click(); await settle();
    check(await editor.inputValue() === 'Line 001 sample selectable text', 'Click switches directly between rows without blur swallowing it');
    await page.keyboard.press('Enter'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape');
    check(!await editor.count(), 'Enter, join and Escape retain line-editor behavior');
    await line.click(); await settle();
    // Click-drag another line while the first editor blurs: the target must survive.
    const target = await page.locator('.note.current .note-line[data-i="2"]').boundingBox();
    await page.mouse.move(target.x + 2, target.y + 8); await page.mouse.down();
    await page.mouse.move(target.x + 110, target.y + 8, {steps: 8}); await page.mouse.up();
    await settle();
    check(await page.evaluate(() => !getSelection().isCollapsed) && !await editor.count(), 'Leaving an editor does not swallow a text-selection gesture');
    await page.waitForTimeout(650);
    check(JSON.stringify(await notes()) === JSON.stringify(original), 'Clicks, selections and unchanged editor blur preserve source');

    // Trusted mouse events, not synthetic DragEvents, exercise the native handle drag.
    await begin(0, 1);
    const panel = await page.locator('#notes').boundingBox();
    await page.mouse.move(panel.x + 160, panel.y + panel.height - 6, {steps: 15});
    const before = await scrollTop(); await page.waitForTimeout(650); const after = await scrollTop();
    check(after > before + 80, 'Bottom-edge drag auto-scrolls with a stationary pointer');
    const marker = await page.locator('.drop-before,.drop-after').getAttribute('data-i');
    await page.waitForTimeout(400);
    check(await page.locator('.drop-before,.drop-after').getAttribute('data-i') !== marker, 'Drop marker follows newly exposed lines');
    await page.mouse.move(panel.x + 180, panel.y + panel.height / 2, {steps: 5});
    await page.waitForTimeout(100);
    const held = await scrollTop(); await page.waitForTimeout(150);
    check(await scrollTop() === held, 'Center stops auto-scroll');
    const index = await page.locator('.drop-before,.drop-after').evaluate(el => Number(el.dataset.i) + (el.classList.contains('drop-after') ? Number(el.dataset.n) : 0));
    await page.mouse.up(); await page.waitForTimeout(650);
    const moved = await notes(), expected = original[1].split('\n'), moving = expected.splice(0, 2);
    expected.splice(index - 2, 0, ...moving);
    check(moved[1] === expected.join('\n') && moved[2] === original[2], 'Drop moves the exact multi-line source and preserves other pages');
    await undo(); await page.waitForTimeout(650);
    check((await notes())[1] === original[1], 'Undo restores a drag move');

    await page.locator('#notes').evaluate(el => { el.scrollTop = 800; });
    await begin(28, 29);
    await page.mouse.move(panel.x + 150, panel.y + 6, {steps: 10});
    const upBefore = await scrollTop(); await page.waitForTimeout(650);
    check(await scrollTop() < upBefore - 80, 'Top-edge drag scrolls upward with a stationary pointer');
    await page.mouse.move(panel.x - 30, panel.y + 10, {steps: 5});
    const left = await scrollTop(); await page.waitForTimeout(150);
    check(await scrollTop() === left, 'Leaving the panel stops auto-scroll');
    await page.mouse.up(); await page.waitForTimeout(150);
    check((await notes())[1] === original[1], 'Outside drop changes nothing');

    await page.locator('#notes').evaluate(el => { el.scrollTop = 500; });
    await begin(18, 19);
    await page.mouse.move(panel.x + 160, panel.y + panel.height - 6, {steps: 10});
    await page.waitForTimeout(100); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.waitForTimeout(100);
    const cancelled = await scrollTop(); await page.waitForTimeout(150);
    check(await scrollTop() === cancelled && !await page.locator('.drop-before,.drop-after').count(), 'Escape cancels drag scrolling and clears marker');
    check((await notes())[1] === original[1], 'Cancelled drag preserves source');
    await page.locator('#notes').evaluate(el => { el.scrollTop = 500; });
    await begin(18, 19);
    await page.mouse.move(panel.x + 160, panel.y + panel.height - 6, {steps: 10});
    await page.evaluate(() => { const input = document.getElementById('page'); input.value = 2; input.dispatchEvent(new Event('change')); });
    await page.mouse.up(); await page.waitForTimeout(100);
    const navigated = await scrollTop(); await page.waitForTimeout(150);
    check(await scrollTop() === navigated && !await page.locator('.moving-lines,.drop-before,.drop-after').count(), 'Page navigation cancels scrolling and clears drag state');
    check((await notes())[1] === original[1], 'Navigation during drag preserves source');
    const clipboard = await page.evaluate(readFileSync(join(__dirname, 'browser_clipboard.js'), 'utf8'));
    passed.push(...clipboard.passed);
    await page.evaluate(() => { const input = document.getElementById('page'); input.value = 4; input.dispatchEvent(new Event('change')); });
    await page.locator('.note.current .note-add').click();
    const tableText = 'Before table\n| A | B |\n| --- | --- |\n| one | two |\n\nx_1=2\nAfter table';
    await page.locator('.note.current textarea').fill(tableText); await page.keyboard.press('Escape');
    await page.locator('.note.current tr').nth(1).click(); await settle();
    check(await editor.inputValue() === '| one | two |', 'Clicking a table row edits that source row');
    await page.keyboard.press('ArrowUp');
    check(await editor.inputValue() === '| --- | --- |', 'Arrow navigation retains table source row boundaries');
    await page.keyboard.press('Escape');
    check(await page.locator('.note.current table').count() === 1 && !await editor.count(), 'Leaving a table editor restores the rendered table');
    await page.locator('.note.current tr').nth(1).click(); await settle();
    await lineAt(6).click(); await settle();
    check(await page.locator('.note.current table').count() === 1 && await editor.inputValue() === 'After table', 'Clicking a line from a table editor restores the table and edits that line');
    await page.keyboard.press('Escape');
    check(await page.locator('.note.current .note-gap').count() === 1 && await page.locator('.note.current .katex-display').count() === 1, 'Blank lines and formulas remain rendered');
    await page.waitForTimeout(650);
    check((await notes())[4] === tableText, 'Table editing and blur preserve exact saved source');
    check(errors.length === 0, `No uncaught browser errors: ${errors.join('; ')}`);
    console.log(JSON.stringify({passed}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
