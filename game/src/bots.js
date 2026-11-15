// bots.js — bot visuals + AI for EMBERWORKS (5v5: Vanguard vs Sentinel).
// One job: create the 9 bots, move them, let them see/hear/shoot each other.
// The round/bomb timers live in rounds.js; this module only moves the
// carrier to its site and sentinels to a planted site, and rounds.js
// advances plantProgress / defuseProgress from their positions.

import * as THREE from 'three';
import { BOT_WEAPON, defFor } from './weapon.js';
import { collideXZ } from './world.js';

// ---- tuning ---------------------------------------------------------------
const SIGHT_RANGE = 40;          // max spotting distance (m)
const FOV_HALF = 35;             // half of the ~70 deg vision cone (deg)
const REACTION_DELAY = 0.35;     // s between spotting and first shot
const HEAR_RANGE = 25;           // gunshots heard within this radius
const BOT_SPEED = 4.2;           // m/s while routing
const BOT_SPEED_COMBAT = 2.6;    // m/s while strafing in a fight
const BOT_RADIUS = 0.4;          // bot collision radius (m) for collideXZ
const RETREAT_HP = 30;           // below this, fall back toward spawn
const TEAM_COLOR = { vanguard: 0xffaa00, sentinel: 0x00ccbb };
const TEAM_NAME = { vanguard: 'Vanguard', sentinel: 'Sentinel' };

// F3 tuning — bots.js owns the bot weapon VALUES; weapon.js owns only the
// mechanism (fire() reads BOT_WEAPON per shot). Applied to the imported
// object here, NOT duplicated in a second def table. damage 16 / head 1.5x:
// 7 body hits kill 100 hp. rofMult 0.55 on the 600 rpm rifle = 5.5/s.
// spreadAdd 0.01 + aimError: strafing spread ~0.054 rad, ~36% hits at 15 m.
// Expected TTK vs exposed stationary 100-hp player: 1 bot ~3.4 s, 5-bot
// focus ~1.5 s once bloom builds; first volley ~31 dmg, not 125.
const BOT_TUNING = { damage: 16, headMult: 1.5, rofMult: 0.55, spreadAdd: 0.01 };
Object.assign(BOT_WEAPON, BOT_TUNING);

// Seconds between bot shots, kept identical to fire()'s internal gate
// (60 / (rpm * rofMult)) so the two never disagree.
function botFireInterval(bot) {
  const def = defFor(bot);
  return 60 / (def.rpm * BOT_WEAPON.rofMult);
}

// ---- helpers --------------------------------------------------------------
// Angle (deg) between the bot's facing yaw and the direction to a point.
// yaw = 0 faces -Z, increasing yaw turns left (standard three.js yaw).
function angleTo(yaw, fx, fz, tx, tz) {
  const dx = tx - fx;
  const dz = tz - fz;
  const want = Math.atan2(-dx, -dz); // yaw that would face the target
  let diff = (want - yaw) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) * 180 / Math.PI;
}

function dist2D(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

// Does the segment a->b pass through any smoke sphere? Smoke records
// are { pos:{x,y,z}, radius, left, group } (weapon.js detonateSmoke);
// a blocked sight line means no spotting.
function blockedBySmoke(state, ax, az, bx, bz) {
  for (const s of state.smokes || []) {
    // F5: real records are {pos, radius} (weapon.js detonateSmoke); the
    // old s.x/s.z/s.r read was NaN, so smoke never blocked sight.
    const sx = s.pos ? s.pos.x : s.x;
    const sz = s.pos ? s.pos.z : s.z;
    const r = s.radius || s.r || 3;
    // Closest point on segment ab to the smoke centre (2D, y ignored).
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz || 1;
    let t = ((sx - ax) * abx + (sz - az) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cz = az + abz * t;
    if (dist2D(cx, cz, sx, sz) < r) return true;
  }
  return false;
}

// Full sight test: range + vision cone + wall LOS + smoke.
// hasLineOfSight(world, ax, az, bx, bz) is exported by the world module.
function canSee(world, state, bot, ex, ez) {
  // F5: a flashed bot cannot spot anyone. blindedUntil is in state.time
  // seconds (weapon.js detonateFlash); all sight paths go through here.
  if (bot.blindedUntil != null && (state.time || 0) < bot.blindedUntil) return false;
  if (dist2D(bot.pos.x, bot.pos.z, ex, ez) > SIGHT_RANGE) return false;
  if (angleTo(bot.yaw, bot.pos.x, bot.pos.z, ex, ez) > FOV_HALF) return false;
  if (world.hasLineOfSight && !world.hasLineOfSight(world, bot.pos.x, bot.pos.z, ex, ez)) return false;
  if (blockedBySmoke(state, bot.pos.x, bot.pos.z, ex, ez)) return false;
  return true;
}

// ---- visuals --------------------------------------------------------------
// Simple capsule soldier from primitives: cylinder body, sphere head, and a
// team-coloured visor stripe so teams read at a glance. The meshes are kept
// on the bot object so the hit-test code can raycast bodyMesh / headMesh.
function buildBotMesh(team) {
  const color = TEAM_COLOR[team];
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.7, metalness: 0.3 });
  const teamMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2, emissive: color, emissiveIntensity: 0.35 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 1.05, 12), bodyMat);
  body.position.y = 0.85;
  body.name = 'body';
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), bodyMat);
  head.position.y = 1.62;
  head.name = 'head';
  group.add(head);

  // Visor stripe across the head, facing +Z of the group (forward).
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.06), teamMat);
  visor.position.set(0, 1.64, 0.2);
  visor.name = 'visor';
  group.add(visor);

  // Shoulder pads in team colour — second read cue at distance.
  const padGeo = new THREE.BoxGeometry(0.16, 0.1, 0.3);
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(padGeo, teamMat);
    pad.position.set(side * 0.38, 1.32, 0);
    group.add(pad);
  }

  // Gun barrel so facing direction is visible even from behind.
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.08, 0.85),
    new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.5, metalness: 0.6 })
  );
  gun.position.set(0.28, 1.05, 0.45);
  gun.name = 'gun';
  group.add(gun);

  return { group, bodyMesh: body, headMesh: head, visorMesh: visor };
}

// ---- creation -------------------------------------------------------------
export function createBots(state, world, scene) {
  const bots = [];
  const vSpawns = world.spawns.vanguard;
  const sSpawns = world.spawns.sentinel;

  // 4 friendly Vanguard bots (player is the 5th Vanguard). Lane spread:
  // two push A, one mid, one B; the first A bot carries the bomb.
  const vanguardLanes = ['a', 'a', 'mid', 'b'];
  for (let i = 0; i < 4; i++) {
    const spawn = vSpawns[i % vSpawns.length];
    const bot = makeBot({
      id: `v-bot-${i + 1}`,
      team: 'vanguard',
      name: `Vanguard-${i + 1}`,
      spawn,
      lane: vanguardLanes[i],
      isCarrier: i === 0,
      weapon: BOT_WEAPON.base,
    });
    bots.push(bot);
  }

  // 5 enemy Sentinel bots: two hold A, two hold B, one roams mid.
  const sentinelLanes = ['a', 'a', 'b', 'b', 'mid'];
  for (let i = 0; i < 5; i++) {
    const spawn = sSpawns[i % sSpawns.length];
    const bot = makeBot({
      id: `s-bot-${i + 1}`,
      team: 'sentinel',
      name: `Sentinel-${i + 1}`,
      spawn,
      lane: sentinelLanes[i],
      isCarrier: false,
      weapon: BOT_WEAPON.base,
    });
    // F7: sentinels traverse their lane in REVERSE — they spawn at the
    // east end, so they start at the LAST waypoint and decrement toward
    // 0 (vanguard start at 0 and increment forward).
    const wps = (world.waypoints && (world.waypoints[bot.lane] || world.waypoints.mid)) || [];
    bot.waypointIndex = Math.max(0, wps.length - 1);
    bots.push(bot);
  }

  for (const bot of bots) {
    const { group, bodyMesh, headMesh, visorMesh } = buildBotMesh(bot.team);
    bot.group = group;
    bot.bodyMesh = bodyMesh;
    bot.headMesh = headMesh;
    bot.visorMesh = visorMesh;
    group.position.set(bot.pos.x, 0, bot.pos.z);
    group.rotation.y = bot.yaw;
    scene.add(group);
  }

  state.bots = bots;
  // Bomb starts with the designated Vanguard carrier bot.
  state.bomb.carrier = bots.find((b) => b.isCarrier)?.id ?? null;
  return bots;
}

function makeBot({ id, team, name, spawn, lane, isCarrier, weapon }) {
  return {
    id,
    team,
    name,
    pos: { x: spawn.x, y: 0, z: spawn.z },
    spawn: { x: spawn.x, z: spawn.z },
    yaw: team === 'vanguard' ? 0 : Math.PI, // Vanguard push forward, Sentinel face them
    pitch: 0,
    hp: 100,
    alive: true,
    crouched: false,
    weapon, // string id (e.g. 'rifle'); resolved via defFor/BOT_WEAPON
    ammo: defFor({ weapon }).magSize,
    moveSpeed: 0,      // m/s; fire() reads this as the movement-spread term
    moveSpeedNorm: 0,  // normalised 0..1; fire() prefers this when set
    aimError: null,    // {x, z} radians, reused per shot (F13)
    blindedUntil: 0,   // state.time seconds; canSee() blocks while blinded
    lane,
    isCarrier,
    // AI state: 'route' | 'hold' | 'engage' | 'plant' | 'defuse' | 'retreat'
    aiState: 'route',
    waypointIndex: 0,
    wpDir: team === 'sentinel' ? -1 : 1, // F7: sentinels walk lanes in reverse
    target: null,          // enemy currently engaged (bot object or 'player')
    targetPos: null,       // last known position of the target {x, z}
    investigatePos: null,  // heard gunshot to check out
    reactionTimer: 0,      // counts down after spotting before first shot
    shootCooldown: 0,      // 1 / rof between shots
    strafeDir: 1,
    strafeTimer: 0,
    holdTimer: 0,
    lastAttacker: null,    // id of whoever last damaged this bot ('player' or bot id)
    group: null,
    bodyMesh: null,
    headMesh: null,
    visorMesh: null,
  };
}

// ---- per-frame update -----------------------------------------------------
export function updateBots(state, world, dt, weaponSystem) {
  if (state.phase !== 'live') {
    // Between rounds bots stand at spawn; keep meshes in sync only.
    for (const bot of state.bots || []) syncMesh(bot);
    return;
  }

  // Death sweep first: a bot whose hp hit 0 (shot by anyone, including the
  // player — that damage lands outside this module) dies here exactly once.
  for (const bot of state.bots || []) {
    if (bot.alive && bot.hp <= 0) killBot(state, bot);
  }

  for (const bot of state.bots || []) {
    // F8: a bot killed mid-tick by another bot's fire (earlier in this
    // same loop) must not act later in the tick. The sweep above only
    // catches deaths from before this tick.
    if (bot.hp <= 0) {
      if (bot.alive) killBot(state, bot);
      continue;
    }
    if (!bot.alive) continue;
    bot.shootCooldown = Math.max(0, bot.shootCooldown - dt);

    // Low hp: break off and fall back toward spawn to survive the round.
    if (bot.hp <= RETREAT_HP && bot.aiState !== 'retreat' && bot.aiState !== 'engage') {
      bot.aiState = 'retreat';
      bot.target = null;
    }

    // Bomb duties override routing. The carrier walks to its assigned site
    // and waits there; rounds.js advances plantProgress from its position.
    if (bot.team === 'vanguard' && bot.isCarrier && state.bomb.state === 'carried') {
      bot.aiState = 'plant';
    } else if (bot.team === 'sentinel' && state.bomb.state === 'planted') {
      bot.aiState = 'defuse';
    } else if (bot.aiState === 'plant' || bot.aiState === 'defuse') {
      bot.aiState = 'route'; // bomb state changed; go back to normal routing
    }

    // Hearing: a recent 'shot' event within HEAR_RANGE pulls the bot toward
    // that position to investigate, unless it is already fighting or bombing.
    if (!bot.target && (bot.aiState === 'route' || bot.aiState === 'hold')) {
      const heard = hearShot(state, bot);
      if (heard) {
        bot.investigatePos = heard;
        bot.aiState = 'route';
      }
    }

    // Sight: scan for the nearest visible enemy (enemy bots + the player).
    const enemy = nearestVisibleEnemy(state, world, bot);
    if (enemy) {
      bot.target = enemy;
      // F13: reuse the targetPos buffer instead of allocating per tick.
      if (!bot.targetPos) bot.targetPos = { x: 0, z: 0 };
      bot.targetPos.x = enemy.pos.x;
      bot.targetPos.z = enemy.pos.z;
      if (bot.aiState !== 'engage') {
        bot.aiState = 'engage';
        bot.reactionTimer = REACTION_DELAY; // human-like pause before firing
        bot.strafeDir = Math.random() < 0.5 ? -1 : 1;
        bot.strafeTimer = 0.6 + Math.random() * 0.8;
      }
    } else if (bot.aiState === 'engage') {
      // Lost sight: hold the last known position briefly, then move on.
      bot.target = null;
      bot.aiState = bot.investigatePos ? 'route' : 'hold';
      bot.holdTimer = 1.2;
    }

    switch (bot.aiState) {
      case 'engage': updateEngage(state, world, bot, dt, weaponSystem); break;
      case 'plant': updatePlant(state, world, bot, dt); break;
      case 'defuse': updateDefuse(state, world, bot, dt); break;
      case 'retreat': updateRetreat(state, world, bot, dt); break;
      case 'hold': updateHold(bot, dt); break;
      case 'route':
      default: updateRoute(state, world, bot, dt); break;
    }

    syncMesh(bot);
  }
}

// ---- senses ---------------------------------------------------------------
function hearShot(state, bot) {
  // state.events holds recent { type:'shot', x, z, tick } entries; only fresh
  // ones (last ~2 s of ticks, tick = 60/s) count as a heard gunshot.
  const events = state.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'shot') continue;
    if (state.tick - (e.tick || 0) > 120) continue;
    if (dist2D(bot.pos.x, bot.pos.z, e.x, e.z) <= HEAR_RANGE) return { x: e.x, z: e.z };
  }
  return null;
}

function nearestVisibleEnemy(state, world, bot) {
  let best = null;
  let bestDist = Infinity;
  const consider = (enemy) => {
    if (!enemy || enemy.alive === false) return;
    if (enemy.team === bot.team) return;
    const d = dist2D(bot.pos.x, bot.pos.z, enemy.pos.x, enemy.pos.z);
    if (d >= bestDist) return;
    if (!canSee(world, state, bot, enemy.pos.x, enemy.pos.z)) return;
    best = enemy;
    bestDist = d;
  };
  for (const other of state.bots || []) if (other !== bot) consider(other);
  // The player is a valid target for Sentinel bots (and for Vanguard bots
  // only in the sense of an enemy — the player IS Vanguard, so skip when
  // the bot is also Vanguard).
  // BUG FIX 1b: pass state.player itself, by reference — NOT a spread copy.
  // The old copy had no bodyMesh/headMesh, so weapon.js fire() raycast
  // nothing, and any hp loss landed on the copy, never on state.player.
  // state.player now carries id 'player' + team 'vanguard' (state.js), so
  // the same-team check in consider() and the id check in updateEngage
  // both work on the real object.
  if (state.player && state.player.alive && bot.team === 'sentinel') {
    consider(state.player);
  }
  return best;
}

// ---- movement -------------------------------------------------------------
function moveToward(bot, world, tx, tz, dt, speed) {
  const dx = tx - bot.pos.x;
  const dz = tz - bot.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.15) return true; // arrived
  const step = Math.min(d, speed * dt);
  bot.pos.x += (dx / d) * step;
  bot.pos.z += (dz / d) * step;
  // F7: every bot position change resolves against the map AABB
  // colliders (world.js collideXZ, frozen signature). Also publish the
  // speed fire() reads as the movement-spread term, both raw (m/s) and
  // normalised 0..1 (fire() prefers moveSpeedNorm when set).
  bot.moveSpeed = speed;
  bot.moveSpeedNorm = speed / 5.5;
  collideXZ(world, bot.pos, BOT_RADIUS);
  faceToward(bot, tx, tz, dt);
  return false;
}

// Turn yaw toward a point, capped so bots don't snap instantly.
function faceToward(bot, tx, tz, dt) {
  const want = Math.atan2(-(tx - bot.pos.x), -(tz - bot.pos.z));
  let diff = (want - bot.yaw) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = 6 * dt; // ~340 deg/s turn rate
  bot.yaw += Math.max(-maxTurn, Math.min(maxTurn, diff));
}

// Lane waypoints for this bot: world.waypoints[lane] is an ordered list of
// {x, z} from spawn toward the site. Vanguard push forward along them;
// Sentinel walk out to a hold point near their end and wait.
function laneWaypoints(world, bot) {
  const lanes = world.waypoints || {};
  return lanes[bot.lane] || lanes.mid || [];
}

function updateRoute(state, world, bot, dt) {
  // Investigating a heard shot overrides the lane for one trip.
  if (bot.investigatePos) {
    if (moveToward(bot, world, bot.investigatePos.x, bot.investigatePos.z, dt, BOT_SPEED)) {
      bot.investigatePos = null;
      bot.aiState = 'hold';
      bot.holdTimer = 2;
    }
    return;
  }
  const wps = laneWaypoints(world, bot);
  if (wps.length === 0) {
    bot.aiState = 'hold';
    return;
  }
  // F7: sentinels traverse in REVERSE (spawn east, start at last waypoint,
  // decrement to 0). Guard: rounds.js resets waypointIndex to 0 each round;
  // a sentinel still at spawn with index 0 has not started, so re-init to
  // last. One that legitimately reached 0 is at the west end, far from spawn.
  if (bot.team === 'sentinel' && bot.waypointIndex === 0
    && dist2D(bot.pos.x, bot.pos.z, bot.spawn.x, bot.spawn.z) < 1) {
    bot.waypointIndex = wps.length - 1;
  }
  const dir = bot.wpDir || (bot.team === 'sentinel' ? -1 : 1);
  const endIndex = bot.team === 'sentinel' ? 0 : wps.length - 1;
  const idx = Math.max(0, Math.min(bot.waypointIndex, wps.length - 1));
  const wp = wps[idx];
  if (moveToward(bot, world, wp.x, wp.z, dt, BOT_SPEED)) {
    if (idx === endIndex) {
      bot.aiState = 'hold';
      bot.holdTimer = 3 + Math.random() * 3;
    } else {
      bot.waypointIndex = idx + dir;
    }
  }
}

function updateHold(bot, dt) {
  bot.holdTimer -= dt;
  // Slow scan: sweep the view left-right while holding the angle.
  bot.yaw += Math.sin(bot.holdTimer * 1.5) * 0.4 * dt;
  if (bot.holdTimer <= 0) {
    bot.aiState = 'route';
    // F7: resume the route in the team's direction (sentinels walk the
    // lane in reverse). updateRoute clamps the index into range.
    bot.waypointIndex += bot.team === 'sentinel' ? -1 : 1;
  }
}

function updateRetreat(state, world, bot, dt) {
  if (moveToward(bot, world, bot.spawn.x, bot.spawn.z, dt, BOT_SPEED)) {
    bot.aiState = 'hold';
    bot.holdTimer = 2;
  }
}

// Carrier: walk the assigned site's lane to the site, then stand in it.
// rounds.js watches the carrier's position and grows plantProgress.
function updatePlant(state, world, bot, dt) {
  const site = state.bomb.site || (bot.lane === 'b' ? 'B' : 'A');
  const sitePos = world.sites[site];
  if (!sitePos) return;
  // F7: the carrier walks its lane waypoints toward the site instead of
  // a straight line through walls, then steps into the site itself.
  const wps = laneWaypoints(world, bot);
  const idx = Math.max(0, Math.min(bot.waypointIndex, wps.length));
  if (idx < wps.length) {
    const wp = wps[idx];
    if (moveToward(bot, world, wp.x, wp.z, dt, BOT_SPEED)) bot.waypointIndex = idx + 1;
    return;
  }
  const arrived = moveToward(bot, world, sitePos.x, sitePos.z, dt, BOT_SPEED);
  if (arrived) {
    bot.crouched = true; // planting stance; also a smaller target
    faceToward(bot, sitePos.x + Math.sin(state.tick * 0.05) * 2, sitePos.z, dt);
  }
}

// Sentinel: run to the planted site so rounds.js can grow defuseProgress.
function updateDefuse(state, world, bot, dt) {
  const sitePos = world.sites[state.bomb.site];
  if (!sitePos) return;
  // F7: defusers run back along their lane waypoints toward the planted
  // site (eastward = increasing index) instead of a straight line
  // through walls, then step into the site itself.
  const wps = laneWaypoints(world, bot);
  const idx = Math.max(0, Math.min(bot.waypointIndex, wps.length - 1));
  if (wps.length > 0 && idx < wps.length - 1) {
    const wp = wps[idx];
    if (moveToward(bot, world, wp.x, wp.z, dt, BOT_SPEED * 1.1)) bot.waypointIndex = idx + 1;
    return;
  }
  moveToward(bot, world, sitePos.x, sitePos.z, dt, BOT_SPEED * 1.1); // urgency
}

// ---- combat ---------------------------------------------------------------
function updateEngage(state, world, bot, dt, weaponSystem) {
  const target = bot.target;
  if (!target || target.alive === false) {
    bot.aiState = 'hold';
    bot.holdTimer = 1;
    return;
  }
  // Strafing speed is what fire() reads as the movement-spread term
  // (normalised 0..1; 2.6 m/s -> 0.47).
  bot.moveSpeed = BOT_SPEED_COMBAT;
  bot.moveSpeedNorm = BOT_SPEED_COMBAT / 5.5;
  // Keep the target's last known position fresh while it is visible.
  if (canSee(world, state, bot, target.pos.x, target.pos.z)) {
    // F13: reuse the targetPos buffer instead of allocating per tick.
    if (!bot.targetPos) bot.targetPos = { x: 0, z: 0 };
    bot.targetPos.x = target.pos.x;
    bot.targetPos.z = target.pos.z;
  }
  const tp = bot.targetPos;
  faceToward(bot, tp.x, tp.z, dt);

  // Strafe perpendicular to the target: harder to hit, classic FPS bot.
  bot.strafeTimer -= dt;
  if (bot.strafeTimer <= 0) {
    bot.strafeDir *= -1;
    bot.strafeTimer = 0.5 + Math.random() * 0.9;
  }
  const dx = tp.x - bot.pos.x;
  const dz = tp.z - bot.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  // Perpendicular vector (-dz, dx) / d, scaled by strafe direction.
  bot.pos.x += (-dz / d) * bot.strafeDir * BOT_SPEED_COMBAT * dt;
  bot.pos.z += (dx / d) * bot.strafeDir * BOT_SPEED_COMBAT * dt;
  // Don't strafe into point blank: back off if closer than 6 m.
  if (d < 6) {
    bot.pos.x -= (dx / d) * BOT_SPEED_COMBAT * dt;
    bot.pos.z -= (dz / d) * BOT_SPEED_COMBAT * dt;
  }
  // F7: strafing moves the bot too — resolve against the map colliders.
  collideXZ(world, bot.pos, BOT_RADIUS);

  // Fire only after the reaction delay, and only while the target is
  // actually visible — no shooting through walls or smoke.
  bot.reactionTimer -= dt;
  if (bot.reactionTimer > 0) return;
  if (bot.shootCooldown > 0) return;
  if (!canSee(world, state, bot, target.pos.x, target.pos.z)) return;
  if (bot.ammo <= 0) {
    // F12: mag size comes from the central WEAPONS table via defFor
    // (bot.weapon is now just the string id, e.g. 'rifle').
    bot.ammo = defFor(bot).magSize; // instant reload for bots (keeps the fight flowing)
    bot.shootCooldown = 1.2;
    return;
  }
  // F12: fire() owns the ammo decrement (it spends one round on a
  // confirmed shot, number-ammo shape included) — bots.js must NOT
  // pre-decrement here; the old `bot.ammo -= 1` double-spent a round
  // whenever fire() returned 'cooldown'. Gate on the same interval
  // fire() uses so the two agree.
  bot.shootCooldown = botFireInterval(bot);
  // Inaccuracy: aim at the target with a small random spread so bots miss
  // sometimes; fire() adds aimError (as radians) to the bot spread, on
  // top of BOT_WEAPON.spreadAdd. F13: reuse the buffer, don't allocate.
  const spread = 0.03;
  if (!bot.aimError) bot.aimError = { x: 0, z: 0 };
  bot.aimError.x = (Math.random() - 0.5) * spread;
  bot.aimError.z = (Math.random() - 0.5) * spread;
  // Mark the shooter BEFORE firing: fire() can kill the target
  // synchronously, and the death sweep reads lastAttacker to credit the
  // kill — setting it after the shot would credit nothing. The target is
  // state.player itself (by reference, see nearestVisibleEnemy), so this
  // write lands on the real player object and fire()'s damage does too.
  if (target.id === 'player') state.player.lastAttacker = bot.id;
  else target.lastAttacker = bot.id;
  if (weaponSystem && typeof weaponSystem.fire === 'function') {
    weaponSystem.fire(state, bot, [target], dt);
  }
}

// ---- death / killfeed -----------------------------------------------------
function killBot(state, bot) {
  bot.alive = false;
  bot.hp = 0;
  bot.aiState = 'route';
  bot.target = null;
  if (bot.group) bot.group.visible = false;

  const killerId = bot.lastAttacker;
  const killerName = killerId === 'player'
    ? 'You'
    : (state.bots || []).find((b) => b.id === killerId)?.name || 'Unknown';
  const entry = {
    type: 'kill',
    killer: killerId,
    killerName,
    victim: bot.id,
    victimName: bot.name,
    tick: state.tick,
  };
  (state.kills = state.kills || []).push(entry);
  (state.events = state.events || []).push(entry);

  // Kill reward: +$300 to the killer. Player money lives on state.money;
  // bot money is tracked per-bot for the buy phase (unused by AI for now).
  if (killerId === 'player') {
    state.money = (state.money || 0) + 300;
  } else {
    const killer = (state.bots || []).find((b) => b.id === killerId);
    if (killer) killer.money = (killer.money || 0) + 300;
  }

  // If the carrier dies, the bomb drops where he fell: another Vanguard bot
  // (nearest alive one) picks it up; rounds.js keeps carrier in sync.
  if (bot.isCarrier && state.bomb.state === 'carried') {
    bot.isCarrier = false;
    const next = (state.bots || [])
      .filter((b) => b.alive && b.team === 'vanguard' && b.id !== bot.id)
      .sort((a, b) => dist2D(a.pos.x, a.pos.z, bot.pos.x, bot.pos.z) - dist2D(b.pos.x, b.pos.z, bot.pos.x, bot.pos.z))[0];
    if (next) {
      next.isCarrier = true;
      state.bomb.carrier = next.id;
      state.bomb.site = next.lane === 'b' ? 'B' : 'A';
    } else if (state.player && state.player.alive) {
      state.bomb.carrier = 'player'; // last Vanguard standing is the player
    }
  }
}

// Keep the three.js group glued to the bot's logical position/yaw.
function syncMesh(bot) {
  if (!bot.group) return;
  bot.group.position.set(bot.pos.x, 0, bot.pos.z);
  bot.group.rotation.y = bot.yaw;
  bot.group.visible = bot.alive;
}
