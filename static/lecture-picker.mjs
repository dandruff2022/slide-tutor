// Application-owned popup: native select menus vary with OS placement and available screen space.
export function mountLecturePicker({button, list, onSelect, focusReader}) {
  let lectures = [], selected = '', active = 0, prefix = '', typedAt = 0;
  const opened = () => !list.hidden;
  function close(restore = false) {
    list.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (restore) button.focus({preventScroll: true});
  }
  function highlight(index) {
    active = Math.max(0, Math.min(lectures.length - 1, index));
    [...list.children].forEach((option, i) => option.classList.toggle('active', i === active));
    const option = list.children[active];
    if (option) {
      list.setAttribute('aria-activedescendant', option.id);
      // Scroll only the popup, never the fixed-viewport document.
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }
  function open(last = false) {
    if (button.disabled || !lectures.length) return;
    list.hidden = false; button.setAttribute('aria-expanded', 'true');
    list.focus({preventScroll: true}); prefix = '';
    highlight(last ? lectures.length - 1 : Math.max(0, lectures.findIndex(l => l.id === selected)));
  }
  function commit() {
    const lecture = lectures[active];
    if (!lecture || button.disabled) return;
    close(); focusReader(); onSelect(lecture.id);
  }
  button.onclick = () => opened() ? close() : open();
  button.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); open(event.key === 'End');
      if (event.key === 'Home') highlight(0);
    }
  });
  list.addEventListener('keydown', event => {
    if (event.key === 'Tab') { close(true); return; }
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commit(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      highlight(event.key === 'Home' ? 0 : event.key === 'End' ? lectures.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now(); prefix = (now - typedAt < 700 ? prefix : '') + event.key.toLowerCase(); typedAt = now;
      const index = lectures.findIndex(l => l.label.toLowerCase().startsWith(prefix));
      if (index >= 0) highlight(index);
    }
  });
  list.onclick = event => {
    const option = event.target.closest('[role="option"]');
    if (!option || !list.contains(option)) return;
    highlight(Number(option.dataset.index)); commit();
  };
  document.addEventListener('pointerdown', event => {
    if (!button.contains(event.target) && !list.contains(event.target)) close();
  });
  document.addEventListener('focusin', event => {
    if (event.target !== button && !list.contains(event.target)) close();
  });
  return {
    setLectures(items) {
      lectures = items;
      list.replaceChildren(...items.map((lecture, i) => {
        const option = document.createElement('div');
        option.id = `lecture-option-${i}`; option.dataset.index = i;
        option.setAttribute('role', 'option'); option.textContent = lecture.label;
        option.setAttribute('aria-selected', 'false'); return option;
      }));
      button.disabled = !items.length;
    },
    select(id) {
      selected = id; button.value = id;
      button.textContent = lectures.find(l => l.id === id)?.label || 'Choose lecture';
      button.setAttribute('aria-label', `Lecture: ${button.textContent}`);
      [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(lectures[i].id === id)));
    },
    close
  };
}
