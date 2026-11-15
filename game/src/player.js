import * as THREE from 'three';

/**
 * player.js — first-person movement, collision, look, crouch, jump.
 *
 * One job: turn the input snapshot + world colliders into the next
 * state.player each frame. No shooting, no reloading, no bomb logic.
 *
 * Model (tuned for a tactical 5v5, not Quake):
 *   - Acceleration-based ground movement: velocity eases toward the
 *     wish velocity instead of snapping, so strafing and stopping
 *     have weight. accel ~40 m/s^2 on ground, ~12 in the air.
 *   - Friction only when no move input is held (exponential decay),
 *     so a held key keeps full speed and releasing stops quickly.
 *   - Gravity -18 m/s^2, jump velocity 5.5 m/s, ground plane y = 0.
 *   - AABB collision in XZ only (all colliders are upright boxes);
 *     the player is a point in XZ with a half-width radius, and Y
 *     is handled separately by the ground / collider-top check.
 *   - Eye height lerps 1.62 (standing) <-> 1.05 (crouched) so the
 *     camera does not pop when toggling crouch.
 *
 * State written: player.pos (feet position, THREE.Vector3-like
 * {x,y,z}), yaw, pitch, hp untouched, crouched, vy, onGround,
 * moveSpeed (0..1, normalised by current max speed — used by the
 * weapons module for spread penalties), eyeHeight (smoothed eye
 * height above the feet — read by main.js for the camera).
 */

// --- Tuning ---------------------------------------------------------
const EYE_STANDING = 1.62;
const EYE_CROUCHED = 1.05;
const PLAYER_RADIUS = 0.35; // half-width in XZ for AABB collision
const PLAYER_HEIGHT = 1.8;  // standing height, feet -> head
const WALK_SPEED = 4.2;     // m/s, standing, Shift not held
const CROUCH_SPEED = 2.1;   // m/s
const SHIFT_SPEED = 2.6;    // m/s, Shift = slow "walk" (quiet)
const ACCEL_GROUND = 40;
const ACCEL_AIR = 12;
const FRICTION = 10;        // 1/s exponential decay, no input only
const GRAVITY = -18;
const JUMP_VELOCITY = 5.5;
const SENSITIVITY = 0.0023; // radians per pixel
const PITCH_LIMIT = 1.5;    // radians, ~86 deg up/down
const CROUCH_LERP = 12;     // 1/s, eye-height smoothing

const _wish = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

export function createPlayer(spawn) {
  const p = (spawn && spawn.pos) || spawn || { x: 0, y: 0, z: 0 };
  const yaw = (spawn && spawn.yaw) || 0;
  return {
    pos: new THREE.Vector3(p.x, 0, p.z),
    yaw,
    pitch: 0,
    hp: 100,
    crouched: false,
    weapon: 'rifle',
    ammo: { mag: 30, reserve: 90 },
    alive: true,
    vy: 0,
    onGround: true,
    moveSpeed: 0,
    // Internal (not part of the shared-state contract, but kept on
    // the player object so updatePlayer stays stateless otherwise):
    _vel: new THREE.Vector3(), // horizontal velocity, XZ plane
    _eyeHeight: EYE_STANDING,
    eyeHeight: EYE_STANDING, // published for the camera (main.js); updatePlayer smooths it
  };
}

/**
 * Resolve the player's XZ position against one AABB collider.
 *
 * Tricky part — per-axis resolution with sliding:
 * We move X first, test overlap, and if inside the box we push the
 * player back out along X to the nearest face and zero the X
 * velocity component; then we do the same for Z. Resolving one axis
 * at a time (instead of pushing out along the shortest penetration
 * in 2D) is what makes the player *slide* along a wall when moving
 * diagonally into it: the blocked axis stops, the free axis keeps
 * moving. A single 2D push-out would instead stick the player to
 * the corner or pop them sideways.
 *
 * Overlap test uses the player radius so the capsule-ish body
 * (not just its centre point) clears the box. Y is ignored here:
 * a collider only blocks XZ when the player's feet are below its
 * top (i.e. the player is not standing on it — see the Y pass in
 * updatePlayer, which lets the player stand on low crates).
 */
function collideAxis(pos, vel, box, axis, radius) {
  const minX = box.minX - radius;
  const maxX = box.maxX + radius;
  const minZ = box.minZ - radius;
  const maxZ = box.maxZ + radius;
  if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ) return;
  // Inside the expanded box on this axis: push out to nearest face.
  if (axis === 'x') {
    const toMin = Math.abs(pos.x - minX);
    const toMax = Math.abs(pos.x - maxX);
    pos.x = toMin < toMax ? minX : maxX;
    vel.x = 0;
  } else {
    const toMin = Math.abs(pos.z - minZ);
    const toMax = Math.abs(pos.z - maxZ);
    pos.z = toMin < toMax ? minZ : maxZ;
    vel.z = 0;
  }
}

function clampToBounds(pos, bounds) {
  if (!bounds) return;
  pos.x = THREE.MathUtils.clamp(pos.x, bounds.minX, bounds.maxX);
  pos.z = THREE.MathUtils.clamp(pos.z, bounds.minZ, bounds.maxZ);
}

export function updatePlayer(state, input, world, dt) {
  const player = state.player;
  if (!player || !player.alive) return;
  if (state.phase !== 'live' && state.phase !== 'buy') return;

  dt = Math.min(dt, 0.05); // clamp huge frames (tab switch) so a
  // single step can never tunnel through a thin wall.

  // --- Look ---------------------------------------------------------
  const look = input.consumeLook();
  player.yaw -= look.dx * SENSITIVITY;
  player.pitch = THREE.MathUtils.clamp(
    player.pitch - look.dy * SENSITIVITY,
    -PITCH_LIMIT,
    PITCH_LIMIT
  );

  // --- Crouch -------------------------------------------------------
  const wantCrouch = input.crouchHeld;
  player.crouched = wantCrouch;
  const targetEye = wantCrouch ? EYE_CROUCHED : EYE_STANDING;
  // Smooth: exponential approach, frame-rate independent.
  player._eyeHeight += (targetEye - player._eyeHeight) * (1 - Math.exp(-CROUCH_LERP * dt));

  // --- Wish direction (yaw-relative, camera space) ------------------
  // Forward is -Z rotated by yaw; right is +X rotated by yaw.
  _forward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const move = input.move; // { x: strafe, z: forward }, normalised
  _wish.set(0, 0, 0).addScaledVector(_forward, move.z).addScaledVector(_right, move.x);

  // --- Target speed -------------------------------------------------
  let maxSpeed = WALK_SPEED;
  if (player.crouched) maxSpeed = CROUCH_SPEED;
  else if (input.walking) maxSpeed = SHIFT_SPEED;
  const wishSpeed = _wish.lengthSq() > 0 ? maxSpeed : 0;
  if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(wishSpeed);

  // --- Acceleration / friction --------------------------------------
  // Accel model: velocity moves toward the wish velocity at a capped
  // rate (m/s per second), not by a fixed lerp fraction. Ground
  // accel 40 m/s^2 is responsive; air accel 12 m/s^2 keeps most of
  // the jump momentum and only allows gentle steering — so holding
  // no key in the air does NOT instantly kill horizontal speed.
  // The cap is applied to the *difference* vector, so diagonal
  // wishes and stops both respect the same rate limit.
  const accel = player.onGround ? ACCEL_GROUND : ACCEL_AIR;
  const dx = _wish.x - player._vel.x;
  const dz = _wish.z - player._vel.z;
  const diffLen = Math.hypot(dx, dz);
  const maxDelta = accel * dt;
  if (diffLen > 0) {
    const scale = Math.min(1, maxDelta / diffLen);
    player._vel.x += dx * scale;
    player._vel.z += dz * scale;
  }
  if (wishSpeed === 0 && player.onGround) {
    // No input: exponential friction decay to a full stop.
    const f = Math.exp(-FRICTION * dt);
    player._vel.x *= f;
    player._vel.z *= f;
    if (player._vel.lengthSq() < 0.0001) player._vel.set(0, 0, 0);
  }

  // --- Vertical: gravity + jump -------------------------------------
  if (input.jumpHeld && player.onGround) {
    player.vy = JUMP_VELOCITY;
    player.onGround = false;
  }
  player.vy += GRAVITY * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= 0) {
    player.pos.y = 0;
    player.vy = 0;
    player.onGround = true;
  }

  // --- Integrate XZ, then collide per axis --------------------------
  const colliders = (world && world.colliders) || [];
  const feetY = player.pos.y;

  player.pos.x += player._vel.x * dt;
  for (const box of colliders) {
    // Only block if the player's feet are below the box top:
    // standing on a crate (feet above top) must not push us out.
    if (feetY < box.top) collideAxis(player.pos, player._vel, box, 'x', PLAYER_RADIUS);
  }

  player.pos.z += player._vel.z * dt;
  for (const box of colliders) {
    if (feetY < box.top) collideAxis(player.pos, player._vel, box, 'z', PLAYER_RADIUS);
  }

  // Standing on a low collider: if our feet are within a small
  // step of a box top and we are falling onto it, land on it
  // instead of clipping through. (Cheap "stand on crates" pass;
  // full step-up is out of scope for this module.)
  if (player.vy <= 0) {
    for (const box of colliders) {
      const inside =
        player.pos.x > box.minX - PLAYER_RADIUS && player.pos.x < box.maxX + PLAYER_RADIUS &&
        player.pos.z > box.minZ - PLAYER_RADIUS && player.pos.z < box.maxZ + PLAYER_RADIUS;
      // Re-read player.pos.y here (not the pre-move feetY): the
      // XZ integration above does not change Y, but the gravity
      // step did, and a stale value would land us a frame late.
      if (inside && player.pos.y <= box.top && player.pos.y > box.top - 0.6) {
        player.pos.y = box.top;
        player.vy = 0;
        player.onGround = true;
      }
    }
  }

  clampToBounds(player.pos, world && world.bounds);

  // --- Spread input for the weapons module --------------------------
  // 0 when still, 1 at full sprint; crouch/walk scale with speed.
  const speed = Math.hypot(player._vel.x, player._vel.z);
  player.moveSpeed = THREE.MathUtils.clamp(speed / WALK_SPEED, 0, 1);

  // Expose the current eye height for the camera in main.js:
  // camera.position.y = player.pos.y + player._eyeHeight.
  player.eyeHeight = player._eyeHeight;
  // PLAYER_HEIGHT (1.8) is the standing head clearance, reserved
  // for a future head-bump pass under low ceilings.
}
