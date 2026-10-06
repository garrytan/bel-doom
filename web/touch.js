// On-screen controls for touch screens. The left half of the screen is a floating stick: put a
// finger down anywhere there and drag to move forward or back and to turn; drag past the ring to
// run. The right side has fire, use and strafe buttons. Each finger is tracked by its pointer id,
// so moving, turning, strafing and firing work at the same time. Produces the same key letters as
// the keyboard (wsadqerfu).
export function createTouchControls(layer, onChange) {
  layer.innerHTML = `
    <div class="zone"></div>
    <div class="stick"><div class="knob"></div></div>
    <button class="btn fire" data-key="f">FIRE</button>
    <button class="btn use" data-key="u">USE</button>
    <button class="btn strafe left" data-key="q" aria-label="strafe left">&#9664;</button>
    <button class="btn strafe right" data-key="e" aria-label="strafe right">&#9654;</button>`;
  const zone = layer.querySelector('.zone');
  const stick = layer.querySelector('.stick');
  const knob = layer.querySelector('.knob');
  const buttons = new Map();
  let stickId = null, ox = 0, oy = 0, stickKeys = '';

  const capture = (el, id) => { try { el.setPointerCapture(id); } catch {} };
  const changed = () => onChange(stickKeys + [...buttons.values()].join(''));

  function moveStick(x, y) {
    const r = stick.offsetWidth / 2;
    const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy);
    const k = d > r ? r / d : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    let s = dy < -0.35 * r ? 'w' : dy > 0.35 * r ? 's' : '';
    s += dx < -0.35 * r ? 'a' : dx > 0.35 * r ? 'd' : '';
    if (d > 1.15 * r && /[ws]/.test(s)) s += 'r';
    if (s !== stickKeys) { stickKeys = s; changed(); }
  }

  function endStick() {
    stickId = null;
    stick.classList.remove('active');
    stick.style.left = stick.style.top = knob.style.transform = '';
    if (stickKeys) { stickKeys = ''; changed(); }
  }

  zone.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault();
    stickId = e.pointerId;
    capture(zone, e.pointerId);
    ox = e.clientX; oy = e.clientY;
    stick.style.left = `${ox}px`; stick.style.top = `${oy}px`;
    stick.classList.add('active');
    moveStick(ox, oy);
  });
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e.clientX, e.clientY); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    zone.addEventListener(type, (e) => { if (e.pointerId === stickId) endStick(); });
  }

  for (const btn of layer.querySelectorAll('.btn')) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(btn, e.pointerId);
      buttons.set(e.pointerId, btn.dataset.key);
      btn.classList.add('down');
      changed();
    });
    const release = (e) => {
      if (!buttons.has(e.pointerId)) return;
      buttons.delete(e.pointerId);
      if (![...buttons.values()].includes(btn.dataset.key)) btn.classList.remove('down');
      changed();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(type, release);
  }
  layer.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    reset() {
      endStick();
      buttons.clear();
      for (const btn of layer.querySelectorAll('.btn')) btn.classList.remove('down');
      changed();
    },
  };
}
