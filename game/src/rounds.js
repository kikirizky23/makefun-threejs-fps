// rounds.js — round / match phase machine + bomb plant/defuse for EMBERWORKS.
// One job: drive state.phase ('buy' -> 'live' -> 'roundEnd' -> 'matchEnd'),
// decide round winners, hand out round money, and run the bomb.
// Plant/defuse progress is advanced HERE from positions (bots.js only moves
// the carrier to the site and sentinels to a planted site), so progress can
// never double-count if both modules run in the same tick.

// Ammo comes from the WEAPONS table (weapon.js imports only 'three', so no
// import cycle). player.weapon is a string id; bot.weapon is a def object.
import { WEAPONS } from './weapon.js';

// ---- tuning ---------------------------------------------------------------
const BUY_TIME = 15;        // s of buy phase at the start of each round
const ROUND_TIME = 100;     // s of live play per round
const ROUND_END_TIME = 5;   // s the round banner shows before the next round
const PLANT_TIME = 3;       // s the carrier must hold at a site to plant
const DEFUSE_TIME = 5;      // s a Sentinel must hold at the site to defuse
const BOMB_TIMER = 35;      // s from plant to explosion
const WIN_ROUNDS = 5;       // first to this many round wins takes the match
const MAX_ROUNDS = 8;       // hard cap on rounds played
const WIN_MONEY = 3250;     // round-win bonus (player)
const LOSS_MONEY = 1900;    // round-loss bonus (player)

// ---- helpers --------------------------------------------------------------
function dist2D(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

// Is anyone from `team` standing inside the site circle?
function teamAtSite(state, world, siteKey, team) {
  const site = world.sites[siteKey];
  if (!site) return null;
  const r = site.r || 4;
  const check = (pos) => pos && dist2D(pos.x, pos.z, site.x, site.z) <= r;
  if (team === 'vanguard') {
    if (state.bomb.carrier === 'player' && state.player?.alive && check(state.player.pos)) return 'player';
    for (const b of state.bots || []) {
      if (b.alive && b.team === 'vanguard' && check(b.pos)) return b;
    }
  } else {
    // Sentinel branch: only Sentinel bots can defuse. The player is
    // Vanguard, so they must never count here — otherwise the player
    // standing in a planted site would defuse their own team's bomb.
    for (const b of state.bots || []) {
      if (b.alive && b.team === 'sentinel' && check(b.pos)) return b;
    }
  }
  return null;
}

// ---- main update ----------------------------------------------------------
export function updateRounds(state, dt, world) {
  switch (state.phase) {
    case 'buy': updateBuy(state, dt, world); break;
    case 'live': updateLive(state, dt, world); break;
    case 'roundEnd': updateRoundEnd(state, dt, world); break;
    case 'matchEnd':
    case 'menu':
    default: break; // nothing ticks in menu or after the match
  }
}

// ---- buy phase ------------------------------------------------------------
// 15 s: the buy menu is available (handled by the UI layer reading
// state.phase === 'buy'), bots stand at spawn. Then the round goes live.
function updateBuy(state, dt, world) {
  state.roundTime -= dt;
  if (state.roundTime <= 0) {
    state.phase = 'live';
    state.roundTime = ROUND_TIME;
    state.events.push({ type: 'roundStart', round: state.round, tick: state.tick });
  }
}

// ---- live phase -----------------------------------------------------------
function updateLive(state, dt, world) {
  state.roundTime -= dt;

  // Bomb state machine runs inside the live phase.
  updateBomb(state, dt, world);

  // Elimination check: a team with nobody alive loses the round.
  // (The bomb exploding/defusing ends the round inside updateBomb.)
  if (state.phase !== 'live') return; // bomb already ended the round
  const vanguardAlive = (state.player?.alive ? 1 : 0)
    + (state.bots || []).filter((b) => b.alive && b.team === 'vanguard').length;
  const sentinelAlive = (state.bots || []).filter((b) => b.alive && b.team === 'sentinel').length;
  if (vanguardAlive === 0) return endRound(state, 'sentinel', 'elimination');
  if (sentinelAlive === 0) return endRound(state, 'vanguard', 'elimination');

  // Timeout with no plant: defenders (Sentinel) take the round.
  if (state.roundTime <= 0) {
    if (state.bomb.state === 'planted') return; // planted bomb keeps the round alive past 0:00
    return endRound(state, 'sentinel', 'timeout');
  }
}

// ---- bomb -----------------------------------------------------------------
function updateBomb(state, dt, world) {
  const bomb = state.bomb;

  if (bomb.state === 'carried') {
    // The carrier plants by standing in a site (carrier bot's lane, or the
    // player's current site if the player holds the bomb). Progress holds
    // in the site and decays when they leave — no partial-plant banking.
    // bomb.site is the target site while carried; at plant completion it
    // is re-assigned to the planted site, so never null once planted —
    // defuse readers rely on that.
    const siteKey = bomb.site || 'A';
    const planter = teamAtSite(state, world, siteKey, 'vanguard');
    if (planter && planterIsCarrier(state, planter)) {
      bomb.plantProgress = (bomb.plantProgress || 0) + dt;
      if (bomb.plantProgress >= PLANT_TIME) {
        bomb.state = 'planted';
        bomb.timer = BOMB_TIMER;
        bomb.plantProgress = PLANT_TIME;
        bomb.plantedSite = siteKey;
        // F9: keep bomb.site in sync with the planted site. Readers
        // (bots.js updateDefuse, hud.js bomb line / minimap) look up
        // world.sites[state.bomb.site]; a null site there made the
        // defuse path return early on the first planted round.
        bomb.site = siteKey;
        state.events.push({ type: 'bombPlanted', site: siteKey, tick: state.tick });
      }
    } else {
      bomb.plantProgress = Math.max(0, (bomb.plantProgress || 0) - dt * 2);
    }
    return;
  }

  if (bomb.state === 'planted') {
    bomb.timer -= dt;
    // A Sentinel in the site defuses; progress decays if they leave.
    const defuser = teamAtSite(state, world, bomb.plantedSite || bomb.site, 'sentinel');
    if (defuser) {
      bomb.defuseProgress = (bomb.defuseProgress || 0) + dt;
      if (bomb.defuseProgress >= DEFUSE_TIME) {
        bomb.state = 'defused';
        bomb.defuseProgress = DEFUSE_TIME;
        state.events.push({ type: 'bombDefused', tick: state.tick });
        return endRound(state, 'sentinel', 'defuse');
      }
    } else {
      bomb.defuseProgress = Math.max(0, (bomb.defuseProgress || 0) - dt * 2);
    }
    // Timer hit zero: the bomb goes off, Vanguard takes the round.
    if (bomb.timer <= 0) {
      bomb.state = 'exploded';
      state.events.push({ type: 'bombExploded', site: bomb.plantedSite || bomb.site, tick: state.tick });
      return endRound(state, 'vanguard', 'explosion');
    }
  }
  // 'defused' / 'exploded' / 'none' are terminal; the round is already over.
}

// Only the carrier's presence grows plantProgress — a random Vanguard bot
// wandering through the site must not plant the bomb.
function planterIsCarrier(state, planter) {
  if (planter === 'player') return state.bomb.carrier === 'player';
  return planter.id === state.bomb.carrier;
}

// ---- round end ------------------------------------------------------------
function endRound(state, winner, reason) {
  state.score[winner] = (state.score[winner] || 0) + 1;
  const playerWon = winner === 'vanguard'; // the player is Vanguard
  state.money = (state.money || 0) + (playerWon ? WIN_MONEY : LOSS_MONEY);
  state.events.push({
    type: 'roundEnd',
    round: state.round,
    winner,
    reason,
    score: { ...state.score },
    tick: state.tick,
  });
  state.phase = 'roundEnd';
  state.roundTime = ROUND_END_TIME;
  state.lastRoundWinner = winner;
  state.lastRoundReason = reason;

  // Match decided? First to 5, or the 8-round cap reached.
  const matchOver =
    state.score.vanguard >= WIN_ROUNDS ||
    state.score.sentinel >= WIN_ROUNDS ||
    state.round >= MAX_ROUNDS;
  if (matchOver) state.matchOver = true; // acted on when the banner lifts
}

function updateRoundEnd(state, dt, world) {
  state.roundTime -= dt;
  if (state.roundTime > 0) return;
  if (state.matchOver) {
    state.phase = 'matchEnd';
    state.events.push({ type: 'matchEnd', score: { ...state.score }, tick: state.tick });
    return;
  }
  state.round += 1;
  resetRound(state, world);
}

// ---- reset ----------------------------------------------------------------
// Respawn everyone at team spawns, restore hp/ammo, reset the bomb, keep
// weapons (and the player's money) across rounds.
function resetRound(state, world) {
  const vSpawns = world.spawns.vanguard;
  const sSpawns = world.spawns.sentinel;

  if (state.player) {
    const spawn = vSpawns[0];
    state.player.pos = { x: spawn.x, y: 0, z: spawn.z };
    state.player.hp = 100;
    state.player.alive = true;
    state.player.crouched = false;
    // player.weapon is a string id ('rifle' | 'smg' | 'pistol'), not a def
    // object — reading .mag off it yields undefined. Look the mag/reserve
    // up in the WEAPONS table (unknown id falls back to the rifle def).
    if (state.player.weapon) {
      const def = WEAPONS[state.player.weapon] || WEAPONS.rifle;
      state.player.ammo = { mag: def.magSize, reserve: def.reserveMax };
    }
  }

  let vi = 0;
  let si = 0;
  for (const bot of state.bots || []) {
    const spawns = bot.team === 'vanguard' ? vSpawns : sSpawns;
    const idx = bot.team === 'vanguard' ? vi++ : si++;
    const spawn = spawns[idx % spawns.length];
    bot.pos = { x: spawn.x, y: 0, z: spawn.z };
    bot.spawn = { x: spawn.x, z: spawn.z };
    bot.hp = 100;
    bot.alive = true;
    bot.crouched = false;
    bot.aiState = 'route';
    bot.waypointIndex = 0;
    bot.target = null;
    bot.targetPos = null;
    bot.investigatePos = null;
    bot.reactionTimer = 0;
    bot.shootCooldown = 0;
    bot.lastAttacker = null;
    // bot.ammo is a plain magazine count, reset from the weapon def each
    // round; fire() spends one round per confirmed shot. Do NOT make it
    // an object. bot.weapon may be a def object or a string id.
    const bDef = typeof bot.weapon === 'string' ? WEAPONS[bot.weapon] : bot.weapon;
    bot.ammo = bDef ? (bDef.magSize ?? bDef.mag ?? WEAPONS.rifle.magSize) : WEAPONS.rifle.magSize;
    bot.yaw = bot.team === 'vanguard' ? 0 : Math.PI;
    if (bot.group) bot.group.visible = true;
  }

  // Bomb back to the carrier bot (first Vanguard bot) at the carrier's lane
  // site; a fresh plant/defuse progress for the new round.
  const carrier = (state.bots || []).find((b) => b.team === 'vanguard');
  if (carrier) {
    for (const b of state.bots || []) b.isCarrier = false;
    carrier.isCarrier = true;
  }
  state.bomb = {
    state: 'carried',
    site: carrier ? (carrier.lane === 'b' ? 'B' : 'A') : 'A',
    timer: 0,
    carrier: carrier ? carrier.id : 'player',
    plantProgress: 0,
    defuseProgress: 0,
    plantedSite: null,
  };

  state.kills = [];
  state.smokes = [];
  state.phase = 'buy';
  state.roundTime = BUY_TIME;
  state.events.push({ type: 'roundReset', round: state.round, tick: state.tick });
}
