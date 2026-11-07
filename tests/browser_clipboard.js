// Paste into DevTools on a disposable "Review sandbox" course. Uses real DOM clipboard events,
// an in-memory DataTransfer (no system clipboard access), and real note writes; no model calls.
(async () => {
  if (!document.title.includes('Review sandbox')) throw new Error('Use disposable sandbox notes.');
  const $ = id => document.getElementById(id), passed = [], originalFetch = window.fetch;
  const check = (value, message) => { if (!value) throw new Error(message); passed.push(message); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(); } throw new Error($('status').textContent); };
  const notes = async () => (await originalFetch('/api/lectures/Lecture2/notes')).json();
  const page = n => { $('page').value = n; $('page').dispatchEvent(new Event('change')); $('notes').focus(); };
  const select = () => {
    $('notes').focus(); const lines = document.querySelectorAll('.note.current .note-line[data-i]');
    const range = document.createRange(); range.setStartBefore(lines[0]); range.setEndAfter(lines[1]);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  };
  const clipboard = (type, data, target = $('notes')) => {
    const event = new ClipboardEvent(type, {clipboardData: data, bubbles: true, cancelable: true}); target.dispatchEvent(event); return event;
  };
  const undo = () => $('notes').dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true, cancelable: true}));
  try {
    await wait(() => $('lecture').value && !$('notes').inert);
    if ($('lecture').value !== 'Lecture2') {
      $('lecture').click(); [...$('lecture-list').children].find(option => option.textContent === 'Lecture 2').click();
      await wait(() => $('lecture').value === 'Lecture2' && !$('notes').inert);
    }
    page(3);
    const initial = await notes(), fixture = 'alpha\n  beta\nx_1=2';
    if (initial[4] || (initial[3] && initial[3] !== fixture)) throw new Error('Use fresh sandbox pages 3 and 4.');
    if (!initial[3]) {
      document.querySelector('.note.current .note-add').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
      const editor = document.querySelector('.note.current textarea'); editor.value = fixture; editor.dispatchEvent(new Event('input')); editor.blur();
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    select(); const copy = new DataTransfer(); clipboard('copy', copy);
    check(copy.getData('text/plain') === 'alpha\n  beta', 'Copy exports exact source and indentation');
    select(); const cancelled = new DataTransfer(); clipboard('cut', cancelled);
    check(document.querySelectorAll('.cut-pending').length === 2 && (await notes())[3] === 'alpha\n  beta\nx_1=2', 'Cut grays lines without deleting or saving them');
    $('notes').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    check(!document.querySelector('.cut-pending'), 'Escape cancels Cut without deleting');
    select(); const move = new DataTransfer(); clipboard('cut', move); page(4);
    check(document.querySelectorAll('.cut-pending').length === 2, 'Pending Cut remains visible across pages');
    check(!clipboard('paste', move, $('prompt')).defaultPrevented, 'Prompt Paste does not commit Cut');
    window.fetch = async (...args) => String(args[0]).endsWith('/notes/batch') ? new Response('{"detail":"simulated conflict"}', {status: 409, headers: {'Content-Type': 'application/json'}}) : originalFetch(...args);
    clipboard('paste', move); await wait(() => $('status').textContent.includes('simulated conflict'));
    check((await notes())[3] === 'alpha\n  beta\nx_1=2' && !(await notes())[4] && document.querySelectorAll('.cut-pending').length === 2, 'A failed Paste leaves source, destination and pending Cut intact');
    window.fetch = originalFetch;
    clipboard('paste', move); await wait(() => $('status').textContent.startsWith('Moved'));
    let result = await notes();
    check(result[3] === 'x_1=2' && result[4] === 'alpha\n  beta' && !document.querySelector('.cut-pending'), 'Paste commits both pages atomically and clears gray state');
    undo(); await wait(() => $('status').textContent === 'Clipboard paste undone.');
    result = await notes(); check(result[3] === 'alpha\n  beta\nx_1=2' && !result[4], 'Ctrl+Z restores both pages together');
    clipboard('paste', move); await wait(() => $('status').textContent.startsWith('Pasted'));
    result = await notes(); check(result[3] === 'alpha\n  beta\nx_1=2' && result[4] === 'alpha\n  beta', 'A consumed Cut token pastes as Copy without deleting twice');
    undo(); await wait(() => $('status').textContent === 'Clipboard paste undone.');
    page(3); select(); const samePage = new DataTransfer(); clipboard('cut', samePage);
    document.querySelector('.note.current .note-add').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
    clipboard('paste', samePage, document.querySelector('.note.current textarea'));
    await wait(() => $('status').textContent.startsWith('Moved'));
    check((await notes())[3] === 'x_1=2\nalpha\n  beta', 'Same-page Cut can paste into the new + line editor');
    undo(); await wait(() => $('status').textContent === 'Clipboard paste undone.');
    return {passed};
  } finally { window.fetch = originalFetch; }
})();
