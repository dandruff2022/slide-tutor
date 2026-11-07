// Scroll only the notes panel; keep ticking when the pointer is stationary at an edge.
export function edgeScrollSpeed(rect, x, y) {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return 0;
  const edge = Math.min(48, rect.height / 4);
  if (y < rect.top + edge) return -600 * (1 - (y - rect.top) / edge);
  if (y > rect.bottom - edge) return 600 * (1 - (rect.bottom - y) / edge);
  return 0;
}

export function noteAutoScroll(panel, update, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let frame = null, point = null, previous = null;
  const stop = () => {
    if (frame !== null) cancel(frame);
    frame = point = previous = null;
  };
  const tick = time => {
    frame = null;
    if (!point) return;
    const speed = edgeScrollSpeed(panel.getBoundingClientRect(), point.x, point.y);
    if (!speed) { stop(); return; }
    const elapsed = previous === null ? 1 / 60 : Math.min((time - previous) / 1000, .05);
    previous = time;
    panel.scrollTop += speed * elapsed;
    update(point.x, point.y);
    frame = request(tick);
  };
  return {
    move(x, y) {
      point = {x, y};
      if (!edgeScrollSpeed(panel.getBoundingClientRect(), x, y)) { stop(); return; }
      if (frame === null) frame = request(tick);
    },
    stop
  };
}
