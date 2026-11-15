import * as THREE from 'three';

// ---------------------------------------------------------------------------
// weapon.js — EMBERWORKS weapon system
//
// One job: hitscan shooting, reload, recoil/spread, muzzle/tracer/impact
// visuals, and grenades (flash + smoke). It does NOT own movement, bot AI,
// the HUD, or the buy menu — it only reads/writes the fields those systems
// agreed on in state.js and pushes {type:'shot'|'hit'|'kill'|'grenade'|
// 'flash'|'reload'|'empty'} entries into state.events[].
//
// Hot-path rule: no per-frame allocations in fire()/update(). Every
// Vector3 / Raycaster / Ray used below is module-level or pool-owned and
// reused. Pools for tracers, flashes and sparks are preallocated once in
// createWeaponSystem().
// ---------------------------------------------------------------------------

export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'VK-7 Longshot',
    damage: 34,
    headMult: 2.2,
    magSize: 30,
    reserveMax: 90,
    rpm: 600,
    auto: true,
    price: 2700,
    reloadTime: 2.2, // seconds
    spreadBase: 0.006, // radians, standing still, first shot
    spreadMove: 0.030, // extra radians at full moveSpeed
    bloomPerShot: 0.004,
    bloomMax: 0.045,
    bloomDecay: 0.09, // bloom units lost per second
    recoilPitch: 0.011, // radians kicked up per shot (player only)
    recoilYaw: 0.006, // random sideways kick range (player only)
    botSpreadMult: 1.6, // bots get inaccuracy instead of recoil
    tracerColor: 0xffc266,
    range: 120,
  },
  smg: {
    id: 'smg',
    name: 'PDW-5 Hornet',
    damage: 22,
    headMult: 2.0,
    magSize: 32,
    reserveMax: 96,
    rpm: 800,
    auto: true,
    price: 1500,
    reloadTime: 1.8,
    spreadBase: 0.010,
    spreadMove: 0.026,
    bloomPerShot: 0.003,
    bloomMax: 0.050,
    bloomDecay: 0.11,
    recoilPitch: 0.007,
    recoilYaw: 0.008,
    botSpreadMult: 1.5,
    tracerColor: 0xffe08a,
    range: 90,
  },
  pistol: {
    id: 'pistol',
    name: 'P9 Sidearm',
    damage: 26,
    headMult: 2.0,
    magSize: 12,
    reserveMax: 48,
    rpm: 0, // semi-auto: caller gates on trigger edge, not RPM
    auto: false,
    price: 500,
    reloadTime: 1.4,
    spreadBase: 0.008,
    spreadMove: 0.022,
    bloomPerShot: 0.006,
    bloomMax: 0.035,
    bloomDecay: 0.14,
    recoilPitch: 0.009,
    recoilYaw: 0.005,
    botSpreadMult: 1.4,
    tracerColor: 0xfff2c0,
    range: 70,
  },
};

export const GRENADE_DEFS = {
  flash: { id: 'flash', name: 'Flashbang', radius: 25, fuse: 1.1, price: 200 },
  smoke: { id: 'smoke', name: 'Smoke Grenade', radius: 4, fuse: 1.2, duration: 18, price: 300 },
};

// Bot weapon adjustments (F12): ONE place owns the bot-vs-player weapon
// delta. Bots shoot the base def (BOT_WEAPON.base) with these adjustments
// applied in fire(). Another pass tunes the VALUES; this file owns the
// mechanism only.
export const BOT_WEAPON = {
  base: 'rifle',
  damage: 25,
  headMult: 2.0,
  rofMult: 0.8, // bot fire-rate multiplier on the base def's rpm
  spreadAdd: 0.05, // extra radians on every bot shot (F3)
};

// Resolve a shooter's weapon def. `shooter.weapon` is a string id
// ('rifle' | 'smg' | 'pistol'); anything else (legacy bot object def)
// falls back to the bot base def. Never returns undefined.
export function defFor(shooter) {
  const id = typeof shooter?.weapon === 'string' ? shooter.weapon : BOT_WEAPON.base;
  return WEAPONS[id] || WEAPONS[BOT_WEAPON.base];
}

// Bot aim error as radians. bots.js publishes aimError as an {x, z}
// offset object, not a number — take its magnitude; a plain number
// (already radians) passes through unchanged.
function aimErrorRad(shooter) {
  const e = shooter?.aimError;
  if (typeof e === 'number') return e;
  if (e && typeof e.x === 'number' && typeof e.z === 'number') return Math.hypot(e.x, e.z);
  return 0;
}

// Damage falloff: full damage to 30 m, then linear down to 55% at 60 m.
const FALLOFF_START = 30;
const FALLOFF_END = 60;
const FALLOFF_MIN = 0.55;

// Pool sizes — small on purpose; oldest entry is recycled when exhausted.
const TRACER_POOL = 24;
const FLASH_POOL = 8;
const SPARK_POOL = 16;
const SMOKE_PUFFS = 9;

// --- Reused temporaries (never allocate in fire()/update()) ----------------
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _toFlash = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _end = new THREE.Vector3();
const _tmpColor = new THREE.Color();
const _raycaster = new THREE.Raycaster();
const _losRay = new THREE.Raycaster();
const _smokePos = new THREE.Vector3();

// Reused per-shot raycast scratch (F13): fire() is synchronous, so one
// shared list + owner map is safe — cleared at the top of each shot.
const _hitMeshes = [];
const _hitOwners = new Map();
const _testObjects = [];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Damage multiplier for a hit at `dist` metres.
function falloffMult(dist) {
  if (dist <= FALLOFF_START) return 1;
  if (dist >= FALLOFF_END) return FALLOFF_MIN;
  const t = (dist - FALLOFF_START) / (FALLOFF_END - FALLOFF_START);
  return 1 - t * (1 - FALLOFF_MIN);
}

// Forward vector from yaw/pitch (yaw around Y, pitch around X).
function forwardFromYawPitch(yaw, pitch, out) {
  out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  return out;
}

// Collider meshes the raycaster must test for blocking. The world may
// expose them as `colliders` (preferred) or as `obstacleMeshes`.
//
// NOTE: world.colliders are plain AABB data objects {minX, maxX, minZ,
// maxZ, top} — NOT THREE meshes — and Raycaster.intersectObjects() throws
// TypeError on them. Each collider also carries its base box mesh in
// `.mesh` (world.js solid()), so resolve every entry to a real
// THREE.Object3D here; fire() and hasLineOfSight() share this one list.
function colliderMeshes(world) {
  if (!world) return null;
  const list = world.colliders || world.obstacleMeshes || world.solids || null;
  if (!list) return null;
  const meshes = [];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.mesh) { meshes.push(entry.mesh); continue; }
    // Already a real THREE.Object3D (has .layers and .raycast).
    if (entry.layers && typeof entry.raycast === 'function') meshes.push(entry);
  }
  return meshes.length > 0 ? meshes : null;
}

export function createWeaponSystem(scene, world) {
  const colliders = colliderMeshes(world);

  // Per-shooter transient state, keyed by the shooter object itself so
  // player and bots each get their own bloom / cooldown / reload timers
  // without us mutating the shared state shape.
  const perShooter = new WeakMap();

  // ONE place bounds state.events retention (F13): weapon.js events are
  // capped at 200, oldest dropped first. (state.js/hud.js cap the
  // killfeed text lines separately at 20.)
  const MAX_EVENTS = 200;
  function pushEvent(state, entry) {
    state.events.push(entry);
    while (state.events.length > MAX_EVENTS) state.events.shift();
  }

  function shooterState(shooter) {
    let s = perShooter.get(shooter);
    if (!s) {
      s = { bloom: 0, cooldown: 0, reloading: false, reloadLeft: 0, reloadKind: null, emptyAt: -10 };
      perShooter.set(shooter, s);
    }
    return s;
  }

  // --- Visual pools ---------------------------------------------------------
  const tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    const mat = new THREE.LineBasicMaterial({ color: 0xffc266, transparent: true, opacity: 0 });
    const line = new THREE.Line(tracerGeo.clone(), mat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerIdx = 0;

  const flashes = [];
  const flashGeo = new THREE.PlaneGeometry(0.55, 0.55);
  for (let i = 0; i < FLASH_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(flashGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    flashes.push({ mesh, life: 0 });
  }
  let flashIdx = 0;

  // Impact sparks: one small Points cloud per slot, 6 points each.
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
    const mat = new THREE.PointsMaterial({ color: 0xffd27a, size: 0.09, transparent: true, opacity: 0, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    points.visible = false;
    points.frustumCulled = false;
    scene.add(points);
    sparks.push({ points, life: 0, vel: new Float32Array(18) });
  }
  let sparkIdx = 0;

  const smokes = []; // { group, pos: Vector3, radius, left }
  const grenades = []; // in-flight grenades { kind, pos, vel, fuse, thrower }

  function showTracer(from, to, colorHex) {
    const slot = tracers[tracerIdx];
    tracerIdx = (tracerIdx + 1) % TRACER_POOL;
    const pos = slot.line.geometry.attributes.position;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    slot.line.material.color.setHex(colorHex);
    slot.line.material.opacity = 0.9;
    slot.line.visible = true;
    slot.life = 0.07; // seconds on screen
  }

  function showFlash(at, lookYaw) {
    const slot = flashes[flashIdx];
    flashIdx = (flashIdx + 1) % FLASH_POOL;
    slot.mesh.position.copy(at);
    slot.mesh.rotation.set(0, lookYaw, 0);
    slot.mesh.material.opacity = 0.95;
    slot.mesh.visible = true;
    slot.life = 0.06;
  }

  function showSparks(at, normal) {
    const slot = sparks[sparkIdx];
    sparkIdx = (sparkIdx + 1) % SPARK_POOL;
    const pos = slot.points.geometry.attributes.position;
    for (let p = 0; p < 6; p++) {
      pos.setXYZ(p, at.x, at.y, at.z);
      // Random-ish burst directions, biased along the surface normal.
      slot.vel[p * 3] = (Math.random() - 0.5) * 3 + (normal ? normal.x * 2 : 0);
      slot.vel[p * 3 + 1] = Math.random() * 2.5 + 0.5;
      slot.vel[p * 3 + 2] = (Math.random() - 0.5) * 3 + (normal ? normal.z * 2 : 0);
    }
    pos.needsUpdate = true;
    slot.points.material.opacity = 1;
    slot.points.visible = true;
    slot.life = 0.35;
  }

  // Muzzle position: a little forward and down from the shooter's eye so
  // the flash/tracer do not start inside the camera.
  function muzzlePos(shooter, out) {
    const eyeY = (shooter.pos.y || 0) + (shooter.crouched ? 1.15 : 1.5);
    forwardFromYawPitch(shooter.yaw || 0, shooter.pitch || 0, _fwd);
    out.set(shooter.pos.x, eyeY, shooter.pos.z);
    out.addScaledVector(_fwd, 0.55);
    out.y -= 0.12;
    return out;
  }

  // --- Shooting -------------------------------------------------------------
  // fire(state, shooter, targetList, dt)
  // Returns 'shot' | 'empty' | 'reloading' | 'cooldown' | 'dead' | null.
  // `targetList` is the array of damageable entities (bots, or [player]).
  // Each target must expose .pos, .hp, .alive, .mesh (body) and .headMesh.
  function fire(state, shooter, targetList, dt) {
    if (!shooter || shooter.alive === false || shooter.hp <= 0) return 'dead';
    // One def for every shooter (F12): defFor() maps a string weapon id
    // to its WEAPONS def (fallback rifle); bots get BOT_WEAPON layered
    // on the base def (damage, headMult, slower rate via rofMult).
    // The old WEAPONS[object] fallback (bot object defs) is gone.
    const isPlayer = shooter === state.player;
    let def = defFor(shooter);
    if (!isPlayer) {
      def = { ...def, damage: BOT_WEAPON.damage, headMult: BOT_WEAPON.headMult };
    }
    const s = shooterState(shooter);
    if (s.reloading) return 'reloading';

    // Fire-rate gate. Semi-auto (pistol, rpm 0) has no cooldown here —
    // the caller must only call fire() on a fresh trigger pull.
    if (def.rpm > 0) {
      if (s.cooldown > 0) return 'cooldown';
      // Bots fire slower: rpm scaled by BOT_WEAPON.rofMult (F12).
      s.cooldown = 60 / (def.rpm * (isPlayer ? 1 : BOT_WEAPON.rofMult));
    }

    // Ammo comes in two shapes: the player carries { mag, reserve },
    // bots carry a plain NUMBER (remaining mag). CONTRACT (F12): fire()
    // owns the decrement for BOTH shapes, only once the shot is
    // confirmed (after this check, below). bots.js must NOT
    // pre-decrement — its `bot.ammo -= 1` is removed by the bots.js
    // writer — or bots lose 2 rounds per shot. The typeof check comes
    // first on purpose: a bot at ammo 0 is falsy, and a plain
    // truthiness check would wrongly replace that 0 with an object.
    if (typeof shooter.ammo === 'number') {
      if (shooter.ammo <= 0) {
        // Dry fire: audible click, throttled so holding trigger is not spam.
        const now = state.time || 0;
        if (now - s.emptyAt > 0.35) {
          s.emptyAt = now;
          pushEvent(state, { type: 'empty', shooter: shooter.id || 'player', weapon: def.id });
        }
        return 'empty';
      }
    } else {
      if (!shooter.ammo) shooter.ammo = { mag: def.magSize, reserve: def.reserveMax };
      if (shooter.ammo.mag <= 0) {
        // Dry fire: audible click, throttled so holding trigger is not spam.
        const now = state.time || 0;
        if (now - s.emptyAt > 0.35) {
          s.emptyAt = now;
          pushEvent(state, { type: 'empty', shooter: shooter.id || 'player', weapon: def.id });
        }
        return 'empty';
      }
    }
    // Shot confirmed: spend exactly one round, both ammo shapes.
    if (typeof shooter.ammo === 'number') shooter.ammo -= 1;
    else shooter.ammo.mag -= 1;

    // --- Spread: base + movement penalty + bloom ----------------------------
    // F10: player.js publishes moveSpeed NORMALISED 0..1 (player.js:234,
    // speed / WALK_SPEED), so dividing by 5.5 again underweighted it
    // 5.5x. Bots publish no moveSpeed at all (read 0). A shooter that
    // publishes raw m/s (> 1) or an explicit moveSpeedNorm is handled
    // by the same rule.
    const speedFrac = shooter.moveSpeedNorm != null
      ? clamp(shooter.moveSpeedNorm, 0, 1)
      : ((shooter.moveSpeed || 0) > 1
        ? clamp((shooter.moveSpeed || 0) / 5.5, 0, 1)
        : clamp(shooter.moveSpeed || 0, 0, 1));
    let spread = def.spreadBase + def.spreadMove * speedFrac;
    if (shooter.crouched) spread -= def.spreadMove * speedFrac * 0.5;
    spread += s.bloom;
    // Bots never get recoil kick; they pay for it as extra inaccuracy
    // (F3): the bot spread multiplier, then the flat BOT_WEAPON.spreadAdd
    // plus the bot's aim error — the nominal 0.06 aim error bots.js sets
    // was previously never read by weapon.js.
    if (!isPlayer) {
      spread *= def.botSpreadMult;
      spread += BOT_WEAPON.spreadAdd + aimErrorRad(shooter);
    }
    s.bloom = Math.min(def.bloomMax, s.bloom + def.bloomPerShot);

    // --- Recoil: pitch/yaw kick, player only --------------------------------
    if (isPlayer) {
      shooter.pitch = clamp((shooter.pitch || 0) + def.recoilPitch * (0.85 + Math.random() * 0.3), -1.45, 1.45);
      shooter.yaw += (Math.random() - 0.5) * def.recoilYaw;
    }

    // --- Ray direction with spread ------------------------------------------
    // Start from the true aim direction, then perturb it by a random
    // offset inside a cone of `spread` radians. The offset is built from
    // the camera right/up axes so it is frame-independent.
    forwardFromYawPitch(shooter.yaw || 0, shooter.pitch || 0, _fwd);
    _right.set(Math.cos(shooter.yaw || 0), 0, -Math.sin(shooter.yaw || 0)).normalize();
    _up.crossVectors(_right, _fwd).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread; // uniform over the disc
    _dir.copy(_fwd)
      .addScaledVector(_right, Math.cos(a) * r)
      .addScaledVector(_up, Math.sin(a) * r)
      .normalize();

    muzzlePos(shooter, _muzzle);
    _origin.copy(_muzzle);

    // --- Raycast: bodies/heads first, walls block ----------------------------
    // Build one flat hit list per shot from the live target meshes, in
    // the reused module-level scratch (F13) — no per-shot array or Map.
    // The raycast itself reuses the module-level _raycaster.
    _hitMeshes.length = 0;
    _hitOwners.clear();
    for (const t of targetList || []) {
      if (!t || t.alive === false || t.hp <= 0) continue;
      if (t.headMesh) { _hitMeshes.push(t.headMesh); _hitOwners.set(t.headMesh, { target: t, head: true }); }
      if (t.bodyMesh) { _hitMeshes.push(t.bodyMesh); _hitOwners.set(t.bodyMesh, { target: t, head: false }); }
      else if (t.mesh) { _hitMeshes.push(t.mesh); _hitOwners.set(t.mesh, { target: t, head: false }); }
    }
    _testObjects.length = 0;
    for (const m of _hitMeshes) _testObjects.push(m);
    if (colliders) for (const c of colliders) _testObjects.push(c);
    const testObjects = _testObjects;

    _raycaster.set(_origin, _dir);
    _raycaster.far = def.range;
    const hits = _raycaster.intersectObjects(testObjects, false);

    let endPoint = _end.copy(_origin).addScaledVector(_dir, def.range);
    let hitTarget = null;
    let hitHead = false;
    let hitDist = def.range;

    if (hits.length > 0) {
      const first = hits[0];
      endPoint = _hitPoint.copy(first.point);
      hitDist = first.distance;
      const owner = _hitOwners.get(first.object);
      if (owner) {
        hitTarget = owner.target;
        hitHead = owner.head;
      } else {
        // Hit a wall / collider: spark at the impact point, no damage.
        const n = first.face ? first.face.normal : null;
        showSparks(_hitPoint, n);
      }
    }

    // Visuals always fire, hit or miss, so the shot reads in the world.
    showTracer(_muzzle, endPoint, def.tracerColor);
    showFlash(_muzzle, shooter.yaw || 0);

    // Shot event carries the shooter's position + tick (F5): bots.js
    // hearShot expects x, z, tick to react to gunfire — without them it
    // read undefined and never heard a shot.
    pushEvent(state, {
      type: 'shot', shooter: shooter.id || 'player', weapon: def.id,
      hit: !!hitTarget, headshot: hitHead, distance: hitDist,
      x: shooter.pos.x, z: shooter.pos.z, tick: state.tick,
    });

    if (!hitTarget) return 'shot';

    // --- Damage: headshot multiplier, then distance falloff ------------------
    let dmg = def.damage * (hitHead ? def.headMult : 1) * falloffMult(hitDist);
    dmg = Math.max(1, Math.round(dmg));
    hitTarget.hp -= dmg;

    pushEvent(state, {
      type: 'hit', shooter: shooter.id || 'player', target: hitTarget.id,
      weapon: def.id, damage: dmg, headshot: hitHead, distance: hitDist,
      hpLeft: Math.max(0, hitTarget.hp),
    });

    if (hitTarget.hp <= 0) {
      // F8: damage only — NEVER set alive=false for a bot here. bots.js
      // owns death finalisation (its per-frame death sweep calls
      // killBot); setting alive here skipped it. The player has no such
      // sweep anywhere in the codebase, so player death stays immediate.
      hitTarget.hp = 0;
      if (hitTarget === state.player) hitTarget.alive = false;
      pushEvent(state, {
        type: 'kill', shooter: shooter.id || 'player', target: hitTarget.id,
        weapon: def.id, headshot: hitHead,
      });
    }
    return 'shot';
  }

  // --- Reload ---------------------------------------------------------------
  // reload(state, shooter, kind?) — `kind` defaults to the shooter's
  // current weapon. Starts a timed reload; update() completes it. Returns
  // true if a reload started, false if already full / empty reserve /
  // already reloading.
  function reload(state, shooter, kind) {
    if (!shooter || shooter.alive === false) return false;
    const id = kind || shooter.weapon || 'rifle';
    const def = WEAPONS[id];
    if (!def) return false;
    const s = shooterState(shooter);
    if (s.reloading) return false;
    if (!shooter.ammo) shooter.ammo = { mag: def.magSize, reserve: def.reserveMax };
    if (shooter.ammo.mag >= def.magSize) return false;
    if (shooter.ammo.reserve <= 0) {
      pushEvent(state, { type: 'empty', shooter: shooter.id || 'player', weapon: id, reason: 'no-reserve' });
      return false;
    }
    s.reloading = true;
    s.reloadLeft = def.reloadTime;
    s.reloadKind = id;
    pushEvent(state, { type: 'reload', shooter: shooter.id || 'player', weapon: id, duration: def.reloadTime });
    return true;
  }

  function finishReload(state, shooter) {
    const s = shooterState(shooter);
    const def = WEAPONS[s.reloadKind || shooter.weapon] || WEAPONS.rifle;
    const need = def.magSize - shooter.ammo.mag;
    const take = Math.min(need, shooter.ammo.reserve);
    shooter.ammo.mag += take;
    shooter.ammo.reserve -= take;
    s.reloading = false;
    s.reloadKind = null;
    pushEvent(state, { type: 'reloaded', shooter: shooter.id || 'player', weapon: def.id, mag: shooter.ammo.mag, reserve: shooter.ammo.reserve });
  }

  // Switch weapon: cancels any in-progress reload for the old weapon.
  // F4: switching is NOT buying — a shooter can only equip the weapon
  // it already owns (shooter.weapon, the current one). Anything else is
  // refused; buy it first via buyWeapon().
  function setWeapon(shooter, kind) {
    if (!WEAPONS[kind]) return false;
    if (shooter.weapon !== kind) return false;
    const s = shooterState(shooter);
    s.reloading = false;
    s.reloadKind = null;
    s.bloom = 0;
    return true;
  }

  // Buy a weapon (F4): money check, deduct, equip with FRESH full ammo.
  // Returns true on purchase, false if unaffordable / unknown id /
  // already owned. The economy lives here, not in the HUD: hud.js
  // buyItem must call this instead of deducting + assigning inline.
  function buyWeapon(state, shooter, id) {
    const def = WEAPONS[id];
    if (!def || !shooter) return false;
    if (shooter.weapon === id) return false;
    if ((state.money || 0) < def.price) return false;
    state.money -= def.price;
    const s = shooterState(shooter);
    s.reloading = false;
    s.reloadKind = null;
    s.bloom = 0;
    shooter.weapon = id;
    shooter.ammo = { mag: def.magSize, reserve: def.reserveMax };
    pushEvent(state, { type: 'buy', shooter: shooter.id || 'player', weapon: id, price: def.price });
    return true;
  }

  // --- Grenades ---------------------------------------------------------------
  // throwGrenade(state, thrower, kind) — lobs a grenade forward; it flies
  // on a simple gravity arc in update() and detonates on its fuse. Flash
  // and smoke resolve at detonation, not at throw time.
  function throwGrenade(state, thrower, kind) {
    if (!thrower || thrower.alive === false) return false;
    const def = GRENADE_DEFS[kind];
    if (!def) return false;
    forwardFromYawPitch(thrower.yaw || 0, thrower.pitch || 0, _fwd);
    const eyeY = (thrower.pos.y || 0) + 1.5;
    // F13: grenade pos/vel are plain {x,y,z} objects, not Vector3s —
    // the arc integrator below works on components.
    grenades.push({
      kind,
      thrower,
      pos: { x: thrower.pos.x, y: eyeY, z: thrower.pos.z },
      vel: {
        x: _fwd.x * 11 + (Math.random() - 0.5) * 0.4,
        y: 4.5 + (thrower.pitch || 0) * 4,
        z: _fwd.z * 11 + (Math.random() - 0.5) * 0.4,
      },
      fuse: def.fuse,
    });
    pushEvent(state, { type: 'grenade', kind, thrower: thrower.id || 'player' });
    return true;
  }

  // Line-of-sight from `from` to `to`, blocked by world colliders.
  // Smoke spheres also block sight — that is what makes smoke useful.
  // `sightState` is optional: callers that already hold the state (bot AI)
  // should pass it, so the smoke check works even before the first
  // update() call has set stateRef.
  function hasLineOfSight(from, to, sightState) {
    _toTarget.subVectors(to, from);
    const dist = _toTarget.length();
    if (dist < 0.001) return true;
    _toTarget.divideScalar(dist);
    _losRay.set(from, _toTarget);
    _losRay.far = dist;
    if (colliders && _losRay.intersectObjects(colliders, false).length > 0) return false;
    // Smoke blocking: segment passes within a smoke sphere's radius.
    const smokesState = sightState || stateRef;
    if (smokesState && smokesState.smokes) {
      for (const sm of smokesState.smokes) {
        _smokePos.set(sm.pos.x, sm.pos.y, sm.pos.z);
        if (segmentHitsSphere(from, to, _smokePos, sm.radius || 4)) return false;
      }
    }
    return true;
  }

  // Does the segment a->b pass within `radius` of `center`?
  function segmentHitsSphere(a, b, center, radius) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = center.x - a.x, acy = center.y - a.y, acz = center.z - a.z;
    const lenSq = abx * abx + aby * aby + abz * abz;
    if (lenSq < 1e-6) return acx * acx + acy * acy + acz * acz <= radius * radius;
    const t = clamp((acx * abx + acy * aby + acz * abz) / lenSq, 0, 1);
    const dx = a.x + abx * t - center.x;
    const dy = a.y + aby * t - center.y;
    const dz = a.z + abz * t - center.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  // Flash detonation: everyone within 25 m with LOS to the blast who is
  // facing it gets blinded. "Facing it" = their view direction has a
  // positive component toward the flash (dot > 0.15); looking away or
  // having your back to it saves you. main.js renders the overlay from
  // the event; bots read it in their sight check via state.events.
  function detonateFlash(state, at) {
    const victims = [];
    const candidates = [];
    if (state.player && state.player.alive !== false) candidates.push(state.player);
    for (const b of state.bots || []) if (b.alive !== false) candidates.push(b);

    _origin.copy(at);
    for (const c of candidates) {
      _toFlash.set(at.x - c.pos.x, (at.y || 0) - ((c.pos.y || 0) + 1.5), at.z - c.pos.z);
      const dist = _toFlash.length();
      if (dist > GRENADE_DEFS.flash.radius) continue;
      // LOS from the victim's eyes to the flash point (pass state so the
      // smoke check cannot be skipped if update() has not run yet).
      _hitPoint.set(c.pos.x, (c.pos.y || 0) + 1.5, c.pos.z);
      if (!hasLineOfSight(_hitPoint, _origin, state)) continue;
      // Facing check: victim looks toward the flash.
      forwardFromYawPitch(c.yaw || 0, c.pitch || 0, _viewDir);
      _toFlash.divideScalar(dist || 1);
      if (_viewDir.dot(_toFlash) < 0.15) continue;
      // Closer = longer blind. 25 m edge is a brief dazzle.
      const duration = 0.6 + 2.4 * (1 - dist / GRENADE_DEFS.flash.radius);
      victims.push({ id: c.id || 'player', duration });
      c.blindedUntil = (state.time || 0) + duration;
    }
    pushEvent(state, { type: 'flash', at: { x: at.x, y: at.y, z: at.z }, victims });
    // A bright pop at the detonation point, visible to everyone.
    showFlash(at, 0);
  }

  function detonateSmoke(state, at) {
    if (!state.smokes) state.smokes = [];
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.55, depthWrite: false });
    const geo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < SMOKE_PUFFS; i++) {
      const puff = new THREE.Mesh(geo, mat);
      const ang = (i / SMOKE_PUFFS) * Math.PI * 2;
      puff.position.set(Math.cos(ang) * 1.8, 0.4 + (i % 3) * 0.9, Math.sin(ang) * 1.8);
      puff.scale.setScalar(1.4 + (i % 3) * 0.5);
      group.add(puff);
    }
    group.position.set(at.x, at.y + 0.6, at.z);
    scene.add(group);
    const record = { pos: { x: at.x, y: at.y + 0.6, z: at.z }, radius: GRENADE_DEFS.smoke.radius, left: GRENADE_DEFS.smoke.duration, group };
    state.smokes.push(record);
    smokes.push(record);
    pushEvent(state, { type: 'smoke', at: { x: at.x, y: at.y, z: at.z }, radius: record.radius, duration: record.left });
  }

  // The latest state seen by update(), so hasLineOfSight() can consult
  // state.smokes for smoke blocking. Set on every update() call.
  let stateRef = null;

  // --- Per-frame update -------------------------------------------------------
  // dt in seconds. Handles cooldowns, bloom decay, reload timers, tracer/
  // flash/spark lifetimes, grenade arcs, and smoke expiry.
  function update(state, dt) {
    stateRef = state;
    if (dt <= 0) return;

    // Cooldown + bloom decay for every shooter we have seen. WeakMap has
    // no iteration, so decay lazily: bloom is also decayed in fire() via
    // time — here we decay the shooters the caller passes each frame.
    // (Player + bots are passed by main.js through tickShooters below.)
    tickShooters(state, dt);

    // Visual lifetimes.
    for (const t of tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) { t.line.visible = false; t.line.material.opacity = 0; }
        else t.line.material.opacity = Math.max(0, t.life / 0.07) * 0.9;
      }
    }
    for (const f of flashes) {
      if (f.life > 0) {
        f.life -= dt;
        if (f.life <= 0) { f.mesh.visible = false; f.mesh.material.opacity = 0; }
        else f.mesh.material.opacity = Math.max(0, f.life / 0.06) * 0.95;
      }
    }
    for (const sp of sparks) {
      if (sp.life > 0) {
        sp.life -= dt;
        const pos = sp.points.geometry.attributes.position;
        for (let p = 0; p < 6; p++) {
          pos.setXYZ(p,
            pos.getX(p) + sp.vel[p * 3] * dt,
            Math.max(0.02, pos.getY(p) + sp.vel[p * 3 + 1] * dt),
            pos.getZ(p) + sp.vel[p * 3 + 2] * dt);
          sp.vel[p * 3 + 1] -= 9.8 * dt; // sparks fall
        }
        pos.needsUpdate = true;
        if (sp.life <= 0) { sp.points.visible = false; sp.points.material.opacity = 0; }
        else sp.points.material.opacity = Math.max(0, sp.life / 0.35);
      }
    }

    // Grenade arcs: gravity, ground bounce (damped), fuse countdown.
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.fuse -= dt;
      g.vel.y -= 14 * dt;
      g.pos.x += g.vel.x * dt;
      g.pos.y += g.vel.y * dt;
      g.pos.z += g.vel.z * dt;
      if (g.pos.y < 0.15) {
        g.pos.y = 0.15;
        g.vel.y = Math.abs(g.vel.y) * 0.35; // bounce, losing energy
        g.vel.x *= 0.6;
        g.vel.z *= 0.6;
      }
      if (g.fuse <= 0) {
        grenades.splice(i, 1);
        if (g.kind === 'flash') detonateFlash(state, g.pos);
        else detonateSmoke(state, g.pos);
      }
    }

    // Smoke expiry: fade the group, then remove mesh + state record.
    for (let i = smokes.length - 1; i >= 0; i--) {
      const sm = smokes[i];
      sm.left -= dt;
      if (sm.left <= 0) {
        scene.remove(sm.group);
        smokes.splice(i, 1);
        const idx = (state.smokes || []).indexOf(sm);
        if (idx >= 0) state.smokes.splice(idx, 1);
      } else if (sm.left < 2) {
        // Last 2 s: fade out.
        for (const child of sm.group.children) child.material.opacity = 0.55 * (sm.left / 2);
      }
    }
  }

  // Decay bloom/cooldowns and finish reloads for the player + all bots.
  // Called from update(); kept separate so main.js can also call it if it
  // ever steps shooters without a full update().
  function tickShooters(state, dt) {
    const shooters = [];
    if (state.player) shooters.push(state.player);
    for (const b of state.bots || []) shooters.push(b);
    for (const sh of shooters) {
      const s = perShooter.get(sh);
      if (!s) continue;
      if (s.cooldown > 0) s.cooldown -= dt;
      if (s.bloom > 0) {
        const def = defFor(sh);
        s.bloom = Math.max(0, s.bloom - def.bloomDecay * dt);
      }
      if (s.reloading) {
        s.reloadLeft -= dt;
        if (s.reloadLeft <= 0) finishReload(state, sh);
      }
    }
  }

  function isReloading(shooter) {
    const s = perShooter.get(shooter);
    return !!(s && s.reloading);
  }

  function dispose() {
    for (const t of tracers) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); }
    for (const f of flashes) { scene.remove(f.mesh); f.mesh.material.dispose(); }
    for (const sp of sparks) { scene.remove(sp.points); sp.points.geometry.dispose(); sp.points.material.dispose(); }
    for (const sm of smokes) scene.remove(sm.group);
    flashGeo.dispose();
    tracerGeo.dispose();
  }

  return {
    weapons: WEAPONS,
    grenades: GRENADE_DEFS,
    fire,
    reload,
    throwGrenade,
    update,
    tickShooters,
    setWeapon,
    buyWeapon,
    isReloading,
    hasLineOfSight,
    dispose,
  };
}
