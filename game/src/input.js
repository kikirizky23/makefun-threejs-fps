import * as THREE from 'three';

/**
 * input.js — keyboard + mouse + pointer lock for EMBERWORKS.
 *
 * One job: turn raw DOM events into a small, frame-friendly snapshot
 * that player.js / weapons.js can consume. No game logic lives here:
 * no movement math, no shooting, no state mutation beyond the
 * input snapshot itself.
 *
 * Contract:
 *   const input = createInput(canvas);
 *   // every frame:
 *   input.update(dt);            // edge-trigger bookkeeping
 *   const look = input.consumeLook(); // { dx, dy } in pixels, then zeroed
 *   input.firing, input.keys, input.reloadPressed, ...
 *
 * Pointer lock: clicking the canvas requests lock. Mouse deltas only
 * accumulate while locked, so alt-tabbing or opening the buy menu
 * (which exits lock) cannot spin the camera.
 */

// Keys we care about. Using e.code (physical key) so WASD works on
// any keyboard layout; KeyW etc. are layout-independent positions.
const TRACKED_CODES = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'KeyC',
  'Space',
  'KeyR',
  'Digit1', 'Digit2', 'Digit3',
  'KeyG', 'KeyB', 'KeyE', 'KeyQ',
];

export function createInput(canvas, options = {}) {
  // In ?shot= staging no pointer lock is ever requested, so firing
  // must not depend on it there. Normal play passes nothing and
  // behaves exactly as before: firing still requires lock.
  const fireWithoutLock = !!options.fireWithoutLock;
  const keys = new Set();
  let lookDX = 0;
  let lookDY = 0;
  let mouseDown = false; // left button held (firing)
  let mouseDownRight = false;
  let reloadQueued = false; // set on keydown, cleared by update()
  let interactHeld = false; // KeyE held (plant / defuse / buy)
  let locked = false;

  // --- Pointer lock -------------------------------------------------
  function requestLock() {
    if (!locked && canvas.requestPointerLock) {
      // requestPointerLock may throw if called too soon after an
      // exit (browser cooldown); swallow it — the next click retries.
      try {
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_e) { /* retry on next click */ }
    }
  }

  function onCanvasClick() {
    requestLock();
  }

  function onLockChange() {
    locked = document.pointerLockElement === canvas;
    if (!locked) {
      // Clear held keys on unlock so a key released while the
      // browser menu was open cannot stick "down" forever.
      keys.clear();
      mouseDown = false;
      mouseDownRight = false;
      lookDX = 0;
      lookDY = 0;
    }
  }

  // --- Keyboard -----------------------------------------------------
  function onKeyDown(e) {
    if (!TRACKED_CODES.includes(e.code)) return;
    // Space scrolls the page and Ctrl+W closes the tab; block the
    // defaults for the keys we own while the game has focus.
    if (e.code === 'Space' || e.code === 'ControlLeft') e.preventDefault();
    if (e.repeat) return; // ignore OS key-repeat for edge triggers
    keys.add(e.code);
    if (e.code === 'KeyR') reloadQueued = true;
    if (e.code === 'KeyE') interactHeld = true;
  }

  function onKeyUp(e) {
    keys.delete(e.code);
    if (e.code === 'KeyE') interactHeld = false;
  }

  function onBlur() {
    // Window lost focus (alt-tab): drop everything so the player
    // does not keep walking / firing on return.
    keys.clear();
    mouseDown = false;
    mouseDownRight = false;
    interactHeld = false;
    lookDX = 0;
    lookDY = 0;
  }

  // --- Mouse --------------------------------------------------------
  function onMouseMove(e) {
    if (!locked) return;
    lookDX += e.movementX || 0;
    lookDY += e.movementY || 0;
  }

  function onMouseDown(e) {
    // The lock gate must match the firing gate: in shot mode
    // (fireWithoutLock) the button press has to register at all, or
    // `firing` could never go true without pointer lock. Normal play
    // is unchanged — without lock and without the flag, still ignored.
    if (!locked && !fireWithoutLock) return;
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) mouseDownRight = true;
  }

  function onMouseUp(e) {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) mouseDownRight = false;
  }

  function onContextMenu(e) {
    // Right-click is aim-down-sights; never show the browser menu.
    e.preventDefault();
  }

  canvas.addEventListener('click', onCanvasClick);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', onContextMenu);

  // --- Per-frame snapshot -------------------------------------------
  // Axis helpers read the live key set so callers never touch it.
  function moveAxis() {
    let x = 0; // strafe: +right
    let z = 0; // forward: +forward
    if (keys.has('KeyW')) z += 1;
    if (keys.has('KeyS')) z -= 1;
    if (keys.has('KeyD')) x += 1;
    if (keys.has('KeyA')) x -= 1;
    // Normalise diagonals so W+D is not ~41% faster than W alone.
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  return {
    keys,
    get locked() { return locked; },
    get firing() { return mouseDown && (locked || fireWithoutLock); },
    get aiming() { return mouseDownRight && locked; },
    get walking() { return keys.has('ShiftLeft') || keys.has('ShiftRight'); },
    get crouchHeld() {
      return keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    },
    get jumpHeld() { return keys.has('Space'); },
    get interactHeld() { return interactHeld; },
    get reloadPressed() { return reloadQueued; },
    get move() { return moveAxis(); },

    /** Preferred reload edge: returns true once per R press and
     *  clears it immediately, so it cannot be lost if update()
     *  runs before the weapons module reads it. */
    consumeReload() {
      const was = reloadQueued;
      reloadQueued = false;
      return was;
    },

    /** Re-request pointer lock (e.g. after closing the buy menu). */
    requestLock,

    /** Drain accumulated mouse movement since the last call. */
    consumeLook() {
      const out = { dx: lookDX, dy: lookDY };
      lookDX = 0;
      lookDY = 0;
      return out;
    },

    /** Call once per frame: clears one-shot edge triggers. */
    update() {
      reloadQueued = false;
    },

    /** Weapon-slot keys pressed this frame are edge-checked by the
     *  caller via keys.has('Digit1') etc.; this helper just reads
     *  which slot (1-3) is currently held, or 0. */
    weaponSlot() {
      if (keys.has('Digit1')) return 1;
      if (keys.has('Digit2')) return 2;
      if (keys.has('Digit3')) return 3;
      return 0;
    },

    grenadePressed() { return keys.has('KeyG'); },
    buyPressed() { return keys.has('KeyB'); },

    /** Remove all listeners (menu teardown / hot reload). */
    dispose() {
      canvas.removeEventListener('click', onCanvasClick);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}

// Re-exported so other modules can share the same vector type
// without importing three themselves for trivial math.
export { THREE };
