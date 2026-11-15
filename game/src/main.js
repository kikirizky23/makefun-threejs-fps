// main.js — EMBERWORKS boot + game loop.
// Fixed-step simulation (TICK = 1/60 accumulator) so logic runs at a stable
// rate independent of frame rate; rendering happens every rAF.
// ?shot= staging (deterministic screenshots): ?shot=start|play|buy|plant
// with ?seed= for the RNG. In shot mode no pointer lock is needed.
import * as THREE from 'three';
import { createState } from './state.js';
import { buildWorld } from './world.js';
import { createPlayer, updatePlayer } from './player.js';
import { createInput } from './input.js';
import { createWeaponSystem } from './weapon.js';
import { createBots, updateBots } from './bots.js';
import { updateRounds } from './rounds.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';

const TICK = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shotMode = params.get('shot'); // null in normal play
const seed = Number(params.get('seed') || 1);

const state = createState(seed);
const audio = createAudio();
// HUD is created after the world below: createHud(world) builds the
// minimap static layer from world bounds/colliders/sites.

// --- Renderer / scene / camera -------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1218);
scene.fog = new THREE.Fog(0x0d1218, 30, 90);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = buildWorld(scene);
// Merge the shared player with createPlayer()'s internals: _vel and
// _eyeHeight live on the object createPlayer returns, and updatePlayer
// needs them. Object.assign keeps state.js fields (spread, hp, ...) that
// createPlayer does not set. pos becomes a Vector3 — every consumer only
// reads .x/.y/.z, and rounds.js reassigns plain objects later.
Object.assign(state.player, createPlayer(world.spawns.vanguard[0]));
state.player.id = 'player'; // re-assert after the merge: createPlayer sets no id
state.player.team = 'vanguard';
const hud = createHud(world); // weapon system wired in below via hud.setWeapons()

// --- Player hitbox (BUG FIX 1a): bots need real meshes to shoot at -------
// weapon.js fire() raycasts target.bodyMesh/headMesh and writes damage onto
// the target object itself. The player previously had neither, so bot shots
// could never hit or damage state.player. These meshes use a fully
// transparent material (opacity 0 + colorWrite false + depthWrite false):
// they render nothing and never appear in screenshots, but the raycaster
// still intersects them, so they work as a hitbox. They can never block
// the player's own fire: the player's target list is bots only (see the
// filtered fire() call in update() below). The group is also never added
// to world.colliders, so it blocks neither movement nor line-of-sight.
const playerHitbox = new THREE.Group();
{
  const ghostMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 1.05, 12), ghostMat);
  body.name = 'player-body';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), ghostMat);
  head.name = 'player-head';
  playerHitbox.add(body, head);
  scene.add(playerHitbox);
  state.player.bodyMesh = body;
  state.player.headMesh = head;
  state.player.hitboxGroup = playerHitbox;
}
// Keep the hitbox glued to the player's feet position every tick; the mesh
// offsets below are heights above the feet. Crouched heights track the
// crouched eye height (1.05 in player.js) so the hitbox shrinks with the
// player instead of floating at standing height.
function syncPlayerHitbox() {
  const p = state.player;
  if (!p.bodyMesh || !p.headMesh) return;
  playerHitbox.position.set(p.pos.x, p.pos.y, p.pos.z);
  p.bodyMesh.position.y = p.crouched ? 0.55 : 0.9;
  p.headMesh.position.y = p.crouched ? 1.0 : 1.5;
  playerHitbox.visible = p.alive;
}

// --- Viewmodel: simple original rifle (boxes + cylinders), camera-attached.
const viewmodel = new THREE.Group();
{
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6, metalness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.62), dark);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 10), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.44);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.1), dark);
  mag.position.set(0, -0.13, -0.05);
  mag.rotation.x = 0.15;
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.08), accent);
  sight.position.set(0, 0.085, -0.1);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.08), dark);
  grip.position.set(0, -0.11, 0.18);
  grip.rotation.x = 0.3;
  viewmodel.add(body, barrel, mag, sight, grip);
  viewmodel.position.set(0.28, -0.26, -0.5);
  camera.add(viewmodel);
}
let recoil = 0; // 0..1, kicks the viewmodel back, decays each frame
let reloadDip = 0; // 0..1, dips the viewmodel while reloading
// Trigger edge state for the combat wiring below. input.js exposes
// firing/grenadePressed/weaponSlot as level reads, so main.js tracks
// the previous tick to detect rising edges (pistol, grenade, slot).
let prevFiring = false;
let prevGrenade = false;
let prevSlot = 0;

// --- Modules ---------------------------------------------------------------
// In ?shot= staging no pointer lock is requested, so the player must be
// able to fire without it there. shotMode is null in normal play, so
// normal play still requires pointer lock to fire, exactly as before.
const input = createInput(renderer.domElement, { fireWithoutLock: !!shotMode });
const weapons = createWeaponSystem(scene, world);
hud.setWeapons(weapons); // HUD is created above, before the weapon system
const bots = createBots(state, world, scene);

// Expose the live state for debugging / the screenshot harness.
window.__emberworks = { state, scene, camera };

// --- Shot staging ----------------------------------------------------------
function stageShot(mode) {
  // Deterministic camera + bot placement per mode; HUD stays live.
  hud.hideOverlay();
  if (mode === 'start') {
    state.phase = 'menu';
    hud.setOverlay('EMBERWORKS', 'Tactical 5v5 — plant the bomb or eliminate the enemy team.', true);
    camera.position.set(0, 1.7, 18);
    camera.rotation.set(0, 0, 0); // Vanguard spawn, looking down mid
  } else if (mode === 'play') {
    state.phase = 'live';
    state.roundTime = 100;
    // Stage closer down mid-lane — NOT state.js's (0, 1.7, 18), which
    // sits inside the mid cross-wall's z [16, 22] segment, and NOT the
    // far vanguard[2] = (-29, 0): at 31+ m the staged enemies are tiny.
    // (-14, 0) is clear mid-lane floor (nearest collider is the low
    // crate(-14, -2.5), whose z edge stops at -1.5 — 1.5 m away), so the
    // enemies at (-4, 0) sit 10 m out: large in frame, readable.
    // Yaw stays -PI/2 from the spawn: facing east (+X) down mid.
    const spawn = world.spawns.vanguard[2];
    state.player.pos = { x: -14, y: 1.7, z: 0 };
    state.player.yaw = spawn.yaw;
    state.player.pitch = 0;
    placeEnemiesInView(1); // 'play': ONE enemy only — two focus-firing
    // bots melt the stationary staged player before the shot lands.
    camera.position.set(state.player.pos.x, 1.7, state.player.pos.z);
    camera.rotation.set(0, state.player.yaw, 0);
  } else if (mode === 'buy') {
    state.phase = 'buy';
    state.money = 4000;
    state.roundTime = 20;
    // Same staged pose as 'play': (-14, 0), facing east down mid
    // (see above — never the (0, 1.7, 18) wall interior, never the
    // far (-29, 0) spawn). Yaw stays -PI/2 from the spawn.
    const spawn = world.spawns.vanguard[2];
    state.player.pos = { x: -14, y: 1.7, z: 0 };
    state.player.yaw = spawn.yaw;
    state.player.pitch = 0;
    // Prime the HUD first: openBuyMenu() early-returns while stateRef
    // is null, and stateRef is only set inside hud.update() — stageShot
    // runs at boot, before the first frame's hud.update(state, dt), so
    // without this the menu never opens in ?shot=buy. Phase/money are
    // already set above, so one update(state, 0) is enough.
    hud.update(state, 0);
    hud.openBuyMenu();
    camera.position.set(state.player.pos.x, 1.7, state.player.pos.z);
    camera.rotation.set(0, state.player.yaw, 0);
  } else if (mode === 'plant') {
    state.phase = 'live';
    state.bomb.state = 'planted';
    state.bomb.site = 'A';
    state.bomb.timer = 35;
    state.roundTime = 35;
    placeEnemiesInView(2); // 'plant': both enemies, exactly as before
    // Planter + defender visible near site A.
    const planter = state.bots.find((b) => b.team === 'vanguard' && b.alive);
    if (planter) { planter.pos.x = -6; planter.pos.z = -14; }
    camera.position.set(-2, 1.7, -8);
    camera.rotation.set(0, Math.PI * 0.15, 0); // looking toward site A
    // The loop drives the camera from the player while live, so aim the
    // player itself at site A instead of only moving the camera.
    // Plain-object pos is fine here: every consumer only reads .x/.y/.z
    // (updatePlayer re-reads them per tick; _vel/_eyeHeight survive on
    // the player object itself, not on pos).
    state.player.pos = { x: -2, y: 1.7, z: -8 };
    state.player.yaw = Math.PI * 0.15;
    state.player.pitch = 0;
  }
}

// Put enemy bots in the mid-lane, in front of the player's view:
// (-4, 0) is 10 m ahead on the near side of the mid-wall doorway
// (gap z [-2, 2] at x = 0); (2, -1) is just east of the gap, on the
// sightline from the mid-lane Vanguard spawn — NOT behind the wall.
// `count` stages that many enemies from the front of the spot list:
// 'play' stages 1 (dead-centre at (-4, 0)), 'plant' stages both.
function placeEnemiesInView(count = 2) {
  const spots = [{ x: -4, z: 0 }, { x: 2, z: -1 }];
  const enemies = state.bots.filter((b) => b.team === 'sentinel' && b.alive).slice(0, count);
  enemies.forEach((b, i) => {
    b.pos.x = spots[i].x;
    b.pos.y = 0;
    b.pos.z = spots[i].z;
    // Face west (-X), toward the player: bots.js angleTo() wants
    // yaw = atan2(-dx, -dz), which for a target due west is +PI/2.
    // (The old Math.PI faced +Z — sideways to the player.)
    b.yaw = Math.PI / 2;
  });
}

// --- Menu / pointer lock ---------------------------------------------------
// Phase (and buy-menu state) saved when pausing, restored on resume.
let pausedFrom = null;
let pausedBuyOpen = false;

// Resume from pause: restore the saved phase (buy/live) instead of
// restarting the buy phase. Menu-only entry stays in startGame().
function resumeGame() {
  audio.unlock();
  state.phase = pausedFrom || 'live';
  if (state.phase === 'buy' && pausedBuyOpen) hud.openBuyMenu();
  pausedFrom = null;
  pausedBuyOpen = false;
  hud.hideOverlay();
  renderer.domElement.requestPointerLock();
}

function startGame() {
  audio.unlock();
  state.phase = 'buy';
  state.roundTime = 20;
  hud.hideOverlay();
  hud.openBuyMenu();
  renderer.domElement.requestPointerLock();
}

hud.el.playBtn?.addEventListener('click', () => {
  if (state.phase === 'paused') resumeGame();
  else startGame(); // menu overlay: fresh game, buy phase + 20 s
});

document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  // Pointer-lock loss pauses to the overlay — but never in shot mode,
  // where no lock is requested at all.
  if (!locked && !shotMode && (state.phase === 'live' || state.phase === 'buy')) {
    pausedFrom = state.phase;
    pausedBuyOpen = hud.isBuyOpen();
    state.phase = 'paused';
    hud.closeBuyMenu();
    hud.setOverlay('PAUSED', 'Click Play to resume. Pointer lock was lost.', true);
  }
});

// B toggles the buy menu during the buy phase; Esc closes it.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyB' && state.phase === 'buy') {
    if (hud.isBuyOpen()) hud.closeBuyMenu();
    else hud.openBuyMenu();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Fixed-step loop -------------------------------------------------------
// Accumulator: sim advances in exact 1/60 steps; leftover time carries over.
// Rendering is decoupled — one render per rAF regardless of tick count.
let last = performance.now();
let acc = 0;

function update(dt) {
  state.tick++;
  state.time += dt;
  if (state.phase === 'live' || state.phase === 'buy') {
    updatePlayer(state, input, world, dt);

    // --- Player combat (live phase only, player alive) ------------------
    // Edge cases: pistol is semi-auto (fire on the trigger's rising edge
    // only — weapon.js has no RPM gate for it, the caller must gate);
    // auto weapons fire while held (weapon.js gates on RPM/cooldown).
    // Grenade + weapon slot are level reads in input.js, so edge-detect
    // them here: holding G would otherwise throw every tick, and holding
    // 1/2/3 would re-run setWeapon() every tick, cancelling reloads.
    if (state.phase === 'live' && state.player.alive) {
      const p = state.player;
      if (input.firing) {
        if (p.weapon !== 'pistol' || !prevFiring) {
          // BUG FIX 2 (friendly fire): only enemy Sentinels are valid
          // targets — weapon.js hits the nearest mesh in the list
          // regardless of team, so passing all 9 bots let the player
          // shoot friendly Vanguard bots.
          weapons.fire(state, p, state.bots.filter((b) => b.team === 'sentinel' && b.alive), dt);
        }
      }
      if (input.consumeReload()) {
        if (weapons.reload(state, p)) reloadDip = 1; // dip the viewmodel
      }
      const slot = input.weaponSlot();
      if (slot >= 1 && slot <= 3 && slot !== prevSlot) {
        weapons.setWeapon(p, ['rifle', 'smg', 'pistol'][slot - 1]);
      }
      prevSlot = slot;
      if (input.grenadePressed() && !prevGrenade) {
        // Flash first, smoke as fallback; never throw what we don't own.
        const kind = (p.grenades?.flash || 0) > 0 ? 'flash'
          : (p.grenades?.smoke || 0) > 0 ? 'smoke' : null;
        if (kind && weapons.throwGrenade(state, p, kind)) p.grenades[kind] -= 1;
      }
      prevGrenade = input.grenadePressed();
      prevFiring = input.firing;
    } else {
      // A trigger held across a phase change / death is not a fresh pull.
      prevFiring = input.firing;
      prevGrenade = input.grenadePressed();
      prevSlot = input.weaponSlot();
    }

    weapons.update(state, dt);
    updateBots(state, world, dt, weapons);
  }
  // Rounds tick OUTSIDE the live/buy guard: endRound() sets phase
  // 'roundEnd', whose 5 s countdown must advance or resetRound() /
  // matchEnd are unreachable. The switch no-ops in menu/paused/
  // matchEnd, so this is safe in every other phase.
  updateRounds(state, dt, world);
  syncPlayerHitbox(); // every tick, all phases: hitbox follows teleports/respawns too
  // input.update() runs LAST: it clears the one-shot reload edge, and
  // the combat wiring above must consume it first — calling it at the
  // top of the tick would wipe an R press before reload is ever read.
  input.update();
  // Camera follows the player every tick while playing; in menu / shot
  // staging the camera stays where stageShot put it.
  if (state.phase === 'live' || state.phase === 'buy' || state.phase === 'paused') {
    // Camera rides at eye height above the feet (1.62 standing,
    // 1.05 crouched — player.eyeHeight lerps between them), so the
    // view matches the shot origin. Hitbox stays feet-based.
    camera.position.set(state.player.pos.x, state.player.pos.y + state.player.eyeHeight, state.player.pos.z);
    camera.rotation.y = state.player.yaw;
    camera.rotation.x = state.player.pitch;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  let frameDt = (now - last) / 1000;
  last = now;
  if (frameDt > 0.25) frameDt = 0.25; // clamp tab-switch spikes
  acc += frameDt;
  let steps = 0;
  while (acc >= TICK && steps < 5) {
    update(TICK);
    acc -= TICK;
    steps++;
  }
  if (steps === 5) acc = 0; // drop backlog rather than spiral

  // Viewmodel feel: recoil kick + reload dip, decayed per rendered frame.
  recoil = Math.max(0, recoil - frameDt * 6);
  reloadDip = Math.max(0, reloadDip - frameDt * 2.5);
  const shooting = input.firing; // player.spread is never written (weapon bloom is internal), so it can never trigger recoil
  if (shooting && state.phase === 'live') recoil = Math.min(1, recoil + frameDt * 8);
  viewmodel.position.z = -0.5 + recoil * 0.09 + reloadDip * 0.12;
  viewmodel.rotation.x = recoil * 0.12 + reloadDip * 0.5;

  hud.update(state, frameDt);
  renderer.render(scene, camera);
}

// --- Boot ------------------------------------------------------------------
if (shotMode) {
  stageShot(shotMode);
} else {
  hud.setOverlay('EMBERWORKS', 'Tactical 5v5 — plant the bomb or eliminate the enemy team.', true);
}
requestAnimationFrame(frame);
