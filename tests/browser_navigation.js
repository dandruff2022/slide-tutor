// Paste this async expression into DevTools on an isolated tutor whose course is "Review sandbox".
// It exercises the real DOM/app; all model replies are mocked. It writes only disposable sandbox notes.
(async () => {
  if (!document.title.includes('Review sandbox')) throw new Error('Use a disposable Review sandbox course, not real notes.');
  const $ = id => document.getElementById(id), passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
  const wait = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for the UI: ' + $('status').textContent);
  };
  const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true}));
  const choose = async id => {
    $('lecture').click();
    [...$('lecture-list').children].find(option => option.textContent.replaceAll(' ', '') === id).click();
    await wait(() => $('lecture').value === id && !$('notes').inert && !$('status').textContent.includes('Loading'));
  };
  const writeNote = text => {
    document.querySelector('.note.current .note-add').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
    const editor = document.querySelector('.note.current textarea');
    editor.value = text; editor.dispatchEvent(new Event('input')); editor.blur();
  };
  const originalFetch = window.fetch;
  try {
    await wait(() => $('lecture').value && !$('notes').inert);
    $('lecture').click();
    check(document.activeElement === $('lecture-list'), 'Popup takes keyboard focus');
    const list = $('lecture-list'), height = list.getBoundingClientRect().height;
    check(height <= Math.min(320, innerHeight / 2) + 1 && getComputedStyle(list).overflowY === 'auto', 'Popup has bounded scrollable height');
    key(list, 'End');
    check(list.getAttribute('aria-activedescendant') === list.lastElementChild.id && list.scrollTop > 0, 'End reveals the last lecture');
    key(list, 'Escape');
    check(list.hidden && document.activeElement === $('lecture'), 'Escape cancels and restores trigger focus');
    $('lecture').click(); key(list, 'Tab');
    check(list.hidden, 'Tab dismisses the popup');
    $('lecture').click(); $('prompt').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    check(list.hidden, 'Outside pointer dismisses the popup');
    await choose('Lecture1');
    check(document.activeElement === $('slide-box'), 'Lecture selection restores reader focus');
    check($('lecture').getAttribute('aria-label').includes('Lecture 1'), 'Trigger announces the selected lecture');
    key($('slide-box'), 'ArrowRight');
    check($('page').value === '2', 'Reader arrows flip pages');
    $('prompt').focus(); key($('prompt'), 'ArrowRight');
    check($('page').value === '2', 'Prompt arrows do not flip pages');
    key($('prompt'), 'Escape');
    check(document.activeElement === $('slide-box'), 'Prompt Escape returns to reader');
    $('prompt').focus(); $('text-layer').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    check(document.activeElement === $('slide-box'), 'Clicking slide text restores reader focus');
    // Delay the older lecture response so it finishes after the newer choice.
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith('/api/lectures/Lecture3/notes')) await new Promise(resolve => setTimeout(resolve, 500));
      return response;
    };
    $('lecture').click(); [...list.children].find(o => o.textContent === 'Lecture 3').click();
    await choose('Lecture2'); await new Promise(resolve => setTimeout(resolve, 700));
    check($('lecture').value === 'Lecture2', 'An older lecture response cannot replace the newest selection');
    // Keep the answer visible while navigating, without contacting a model endpoint.
    window.fetch = async (...args) => String(args[0]) === '/api/chat' ? new Response(
      'data: ' + JSON.stringify({type: 'delta', text: 'Answer\n```note\nsandbox suggestion\n```'}) + '\n\n' +
      'data: {"type":"done"}\n\n', {headers: {'Content-Type': 'text/event-stream'}}) : originalFetch(...args);
    writeNote('source note');
    $('prompt').value = 'Sandbox question'; $('ask').click();
    await wait(() => [...$('response').querySelectorAll('.apply')].some(b => b.textContent.startsWith('Add to current')) && !$('ask').disabled);
    $('next').click(); writeNote('destination note');
    const add = [...$('response').querySelectorAll('.apply')].find(b => b.textContent.startsWith('Add to current'));
    check(add.textContent === 'Add to current page (p.2)' && !add.disabled, 'Suggestion label follows the current destination');
    add.click();
    const undo = [...$('response').querySelectorAll('.apply')].find(b => !b.hidden && b.textContent.startsWith('Undo'));
    await wait(() => !document.querySelector('.note.current textarea'));
    await new Promise(resolve => setTimeout(resolve, 600));
    let notes = await (await originalFetch('/api/lectures/Lecture2/notes')).json();
    check(notes[1] === 'source note' && notes[2] === 'destination note\nsandbox suggestion', 'Suggestion appends to destination without changing its source note');
    $('prev').click(); check(undo.disabled, 'Undo is disabled away from its actual destination');
    $('next').click(); undo.click(); await new Promise(resolve => setTimeout(resolve, 600));
    notes = await (await originalFetch('/api/lectures/Lecture2/notes')).json();
    check(notes[2] === 'destination note', 'Undo restores the destination note');
    const proposal = {lecture: 'Lecture2', scope: 'multiple', intent: 'Move p.1 to p.2', summary: 'Sandbox move', changes: [
      {page: 1, before: notes[1], text: ''}, {page: 2, before: notes[2], text: notes[2] + '\n' + notes[1]}
    ]};
    let propose = true;
    window.fetch = async (...args) => {
      if (String(args[0]) !== '/api/chat') return originalFetch(...args);
      const events = [{type: 'delta', text: propose ? 'Review this move.' : 'Another answer.'},
        ...(propose ? [{type: 'proposal', proposal}] : []), {type: 'done'}];
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {headers: {'Content-Type': 'text/event-stream'}});
    };
    $('prompt').value = proposal.intent; $('ask').click();
    await wait(() => $('response').querySelector('.note-proposal') && !$('ask').disabled);
    const box = $('response').querySelector('.note-proposal'), controls = box.querySelectorAll('button');
    [...controls].find(button => button.textContent.startsWith('Apply changes')).click();
    await wait(() => box.dataset.applied === 'true' && !$('notes').inert);
    propose = false; $('prompt').value = 'Another sandbox question'; $('ask').click();
    await wait(() => !$('ask').disabled);
    check(box.isConnected, 'Applied batch Undo survives the next question');
    [...controls].find(button => button.textContent === 'Undo all changes').click();
    await wait(() => box.dataset.applied === 'false' && !$('notes').inert);
    writeNote('after batch'); await new Promise(resolve => setTimeout(resolve, 600));
    notes = await (await originalFetch('/api/lectures/Lecture2/notes')).json();
    check(notes[1] === 'source note' && notes[2] === 'destination note\nafter batch', 'Batch Undo refreshes the snapshot for the next autosave');
    return {passed};
  } finally { window.fetch = originalFetch; }
})();
