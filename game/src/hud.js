// hud.js — DOM HUD for EMBERWORKS. Grabs elements by ID, updates them
// every frame from state, and owns the buy menu (click-to-buy, buy phase only).
import { WEAPONS } from './weapon.js';

const GRENADES = [
  { id: 'flash', name: 'Flashbang', price: 200, desc: 'Blinds enemies in view' },
  { id: 'smoke', name: 'Smoke Grenade', price: 300, desc: 'Blocks sight for 12s' },
  // No 'he' grenade: weapon.js only supports flash + smoke (GRENADE_DEFS).
];

const $ = (id) => document.getElementById(id);

function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function createHud(world) {
  const el = {
    hud: $('hud'),
    minimap: $('minimap'),
    utility: $('utility'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    health: $('health'),
    healthBar: $('health-bar'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    timer: $('timer'),
    scoreVanguard: $('score-vanguard'),
    scoreSentinel: $('score-sentinel'),
    money: $('money'),
    killfeed: $('killfeed'),
    buyMenu: $('buy-menu'),
    roundBanner: $('round-banner'),
    bombStatus: $('bomb-status'),
    flashOverlay: $('flash-overlay'),
    damageVignette: $('damage-vignette'),
    overlay: $('overlay'),
    playBtn: $('play'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
  };

  let stateRef = null;
  let weaponsRef = null; // weapon system, wired by main.js via setWeapons()
  let lastPhase = null;
  let lastKillCount = 0;
  let buyOpen = false;
  let hitmarkerUntil = 0;
  // Radio lines already announced, keyed `type:tick` (rounds.js emits
  // each typed event once; without this the scan in update() would
  // re-announce it every frame while it stays in state.events).
  const radioSeen = new Set();
  // F13: reused buffer for the killfeed scan — the per-frame
  // filter/slice/reverse/map chain allocated 4 throwaway arrays.
  const feedLines = [];

  // --- Minimap ------------------------------------------------------------
  // Static layer cached once (walls/sites/spawns); update() only blits
  // it and draws the live dots, so the per-frame cost is a few arcs.
  const MM_W = 180;
  const MM_H = 150;
  const mmCanvas = $('minimap');
  const mmCtx = mmCanvas ? mmCanvas.getContext('2d') : null;
  let mmStatic = null;
  function mmProject(x, z) {
    const b = (world && world.bounds) || { minX: -32, maxX: 32, minZ: -22, maxZ: 22 };
    return [
      ((x - b.minX) / (b.maxX - b.minX)) * MM_W,
      ((z - b.minZ) / (b.maxZ - b.minZ)) * MM_H,
    ];
  }
  if (mmCtx && world) {
    mmStatic = document.createElement('canvas');
    mmStatic.width = MM_W;
    mmStatic.height = MM_H;
    const g = mmStatic.getContext('2d');
    g.fillStyle = 'rgba(13, 11, 9, 0.9)';
    g.fillRect(0, 0, MM_W, MM_H);
    // Walls / crates: world.colliders are 2D AABBs.
    g.fillStyle = '#4a5058';
    for (const c of world.colliders || []) {
      const [x0, y0] = mmProject(c.minX, c.minZ);
      const [x1, y1] = mmProject(c.maxX, c.maxZ);
      g.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
    // Bomb sites: ring + letter.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 11px system-ui, sans-serif';
    for (const [letter, site] of Object.entries(world.sites || {})) {
      const [cx, cy] = mmProject(site.x, site.z);
      const r = Math.max(4, (site.r || 4.5) * (MM_W / 64));
      g.strokeStyle = letter === 'A' ? '#ff6a1a' : '#3ec6c6';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = g.strokeStyle;
      g.fillText(letter, cx, cy);
    }
    // Spawns: small squares (vanguard amber west, sentinel teal east).
    for (const [team, list] of Object.entries(world.spawns || {})) {
      g.fillStyle = team === 'vanguard' ? '#ffaa00' : '#00ccbb';
      for (const s of list) {
        const [sx, sy] = mmProject(s.x, s.z);
        g.fillRect(sx - 2, sy - 2, 4, 4);
      }
    }
  }

  function showHitmarker() {
    if (!el.hitmarker) return;
    el.hitmarker.style.opacity = '1';
    hitmarkerUntil = performance.now() + 180;
  }

  function renderBuyMenu() {
    if (!el.buyMenu || !stateRef) return;
    const money = stateRef.money;
    const rows = [];
    for (const w of Object.values(WEAPONS)) {
      const owned = stateRef.player.weapon === w.id;
      const afford = money >= w.price;
      rows.push(
        `<button class="buy-item${afford ? '' : ' cant-afford'}${owned ? ' owned' : ''}" ` +
        `data-kind="weapon" data-id="${w.id}" ${afford && !owned ? '' : 'disabled'}>` +
        `<span class="buy-name">${w.name}</span>` +
        `<span class="buy-desc">${w.desc || ''}</span>` +
        `<span class="buy-price">$${w.price}${owned ? ' — OWNED' : ''}</span></button>`,
      );
    }
    for (const g of GRENADES) {
      const afford = money >= g.price;
      rows.push(
        `<button class="buy-item${afford ? '' : ' cant-afford'}" ` +
        `data-kind="grenade" data-id="${g.id}" ${afford ? '' : 'disabled'}>` +
        `<span class="buy-name">${g.name}</span>` +
        `<span class="buy-desc">${g.desc}</span>` +
        `<span class="buy-price">$${g.price}</span></button>`,
      );
    }
    el.buyMenu.innerHTML =
      `<div class="buy-title">BUY PHASE — $${money}</div>` +
      `<div class="buy-grid">${rows.join('')}</div>` +
      `<div class="buy-hint">Click to buy. Press B or click Close to start the round.</div>` +
      `<button class="buy-close">Close [B]</button>`;
    el.buyMenu.querySelector('.buy-close').addEventListener('click', () => closeBuyMenu());
    el.buyMenu.querySelectorAll('.buy-item').forEach((btn) => {
      btn.addEventListener('click', () => buyItem(btn.dataset.kind, btn.dataset.id));
    });
  }

  // Buy flow: only in 'buy' phase. Weapons go through buyWeapon()
  // (money, ownership + fresh ammo live in weapon.js, not here).
  function buyItem(kind, id) {
    if (!stateRef || stateRef.phase !== 'buy') return;
    if (kind === 'weapon') {
      const w = WEAPONS[id];
      if (!w || !weaponsRef || !weaponsRef.buyWeapon(stateRef, stateRef.player, id)) return;
      addFeed(stateRef, `Bought ${w.name} — $${w.price}`, 'buy');
    } else {
      const g = GRENADES.find((x) => x.id === id);
      if (!g || stateRef.money < g.price) return;
      stateRef.money -= g.price;
      stateRef.player.grenades = stateRef.player.grenades || {};
      stateRef.player.grenades[g.id] = (stateRef.player.grenades[g.id] || 0) + 1;
      addFeed(stateRef, `Bought ${g.name} — $${g.price}`, 'buy');
    }
    renderBuyMenu(); // refresh prices / affordable highlight
  }

  function addFeed(state, text, kind) {
    state.events.push({ t: state.time, text, kind });
    if (state.events.length > 20) state.events.shift();
  }

  function openBuyMenu() {
    if (!el.buyMenu || !stateRef) return;
    buyOpen = true;
    renderBuyMenu();
    el.buyMenu.classList.add('open');
    el.buyMenu.style.display = 'block';
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function closeBuyMenu() {
    buyOpen = false;
    if (!el.buyMenu) return;
    el.buyMenu.classList.remove('open');
    el.buyMenu.style.display = 'none';
  }

  function update(state, dt) {
    stateRef = state;
    const p = state.player;

    // HUD visibility — single source of truth: #hud is display:none
    // until it gains .on (index.html). Show it whenever the game is
    // actually being played (live / buy / paused / roundEnd) and hide
    // it on the menu, so ?shot=start keeps a clean menu backdrop while
    // ?shot=play / buy / plant get the full HUD — and the buy menu
    // (a child of #hud) can render in the buy phase.
    if (el.hud) {
      el.hud.classList.toggle('on',
        state.phase === 'live' || state.phase === 'buy' ||
        state.phase === 'paused' || state.phase === 'roundEnd');
    }

    // Radio chatter: rounds.js announces roundStart / bombPlanted as
    // typed events (no text); translate each once into a killfeed line
    // via the existing addFeed() mechanism (kind 'radio').
    // F13: index loop over a snapshot length instead of state.events.slice()
    // — no per-frame array alloc. Safe while addFeed() pushes/shifts inside
    // the loop: pushed lines carry no `tick` so they are skipped here, and
    // an event skipped by a shift is simply re-scanned next frame
    // (radioSeen is only added when the line is actually announced).
    for (let i = 0, n = state.events.length; i < n; i++) {
      const e = state.events[i];
      if (!e || typeof e.tick !== 'number') continue;
      const key = `${e.type}:${e.tick}`;
      if (radioSeen.has(key)) continue;
      if (e.type === 'roundStart') {
        radioSeen.add(key);
        addFeed(state, `Vanguard: pushing ${state.bomb.site || 'A'}`, 'radio');
      } else if (e.type === 'bombPlanted') {
        radioSeen.add(key);
        addFeed(state, `Bomb planted at Site ${e.site || state.bomb.plantedSite || state.bomb.site || 'A'}`, 'radio');
      }
    }

    // Health: number + bar width; bar turns red when low.
    if (el.health) el.health.textContent = String(Math.max(0, Math.ceil(p.hp)));
    if (el.healthBar) {
      el.healthBar.style.width = `${Math.max(0, Math.min(100, p.hp))}%`;
      el.healthBar.classList.toggle('low', p.hp <= 30);
    }

    // Ammo: mag big, reserve small; mag goes red when empty.
    if (el.ammoMag) {
      el.ammoMag.textContent = String(p.ammo.mag);
      el.ammoMag.classList.toggle('empty', p.ammo.mag === 0);
    }
    if (el.ammoReserve) el.ammoReserve.textContent = `/ ${p.ammo.reserve}`;

    // Utility: grenades owned (flash / smoke), next to the ammo readout.
    if (el.utility) {
      const g = p.grenades || {};
      el.utility.textContent = `FLASH ×${g.flash || 0}   SMOKE ×${g.smoke || 0}`;
    }

    // Timer, score, money.
    if (el.timer) el.timer.textContent = fmtTime(state.roundTime);
    if (el.scoreVanguard) el.scoreVanguard.textContent = String(state.score.vanguard);
    if (el.scoreSentinel) el.scoreSentinel.textContent = String(state.score.sentinel);
    if (el.money) el.money.textContent = `$${state.money}`;

    // Bomb status line.
    if (el.bombStatus) {
      const b = state.bomb;
      let text = 'BOMB: carried';
      if (b.state === 'planted') text = `BOMB PLANTED — ${b.site || ''} — ${fmtTime(b.timer)}`;
      else if (b.state === 'defused') text = 'BOMB DEFUSED';
      else if (b.state === 'exploded') text = 'BOMB DETONATED';
      else if (b.state === 'dropped') text = 'BOMB DROPPED';
      el.bombStatus.textContent = text;
      el.bombStatus.classList.toggle('planted', b.state === 'planted');
    }

    // Killfeed: last 5 feed lines, newest first; entries older than 6s fade out.
    // (events are capped at 20 in state.js, so slice(-5) is cheap here.)
    // state.events is shared: typed game events {type, shooter, target, ...}
    // carry NO text, only addFeed() lines do — filter to text entries first
    // or the feed fills with "undefined" boxes during live combat.
    if (el.killfeed) {
      // F13: scan backwards into the reused feedLines buffer (newest
      // first, max 5) instead of filter().slice(-5).reverse().map().
      feedLines.length = 0;
      for (let i = state.events.length - 1; i >= 0 && feedLines.length < 5; i--) {
        const e = state.events[i];
        if (e && typeof e.text === 'string') feedLines.push(e);
      }
      let html = '';
      for (const e of feedLines) {
        const age = state.time - e.t;
        const op = age > 6 ? 0.25 : 1;
        html += `<div class="feed-item ${e.kind}" style="opacity:${op}">${e.text}</div>`;
      }
      el.killfeed.innerHTML = html;
    }

    // Round banner on phase change only (avoids re-rendering every frame).
    if (el.roundBanner && state.phase !== lastPhase) {
      lastPhase = state.phase;
      const map = {
        buy: `ROUND ${state.round} — BUY PHASE`,
        live: `ROUND ${state.round}`,
        roundEnd: state.score.vanguard > state.score.sentinel ? 'VANGUARD WINS THE ROUND' : 'SENTINEL WINS THE ROUND',
        matchEnd: 'MATCH OVER',
        menu: '',
      };
      el.roundBanner.textContent = map[state.phase] || '';
      el.roundBanner.style.opacity = map[state.phase] ? '1' : '0';
    }

    // Damage vignette: strong right after damage, fades over ~0.8s.
    if (el.damageVignette) {
      const age = state.time - p.lastDamageAt;
      el.damageVignette.style.opacity = age < 0.8 ? String(0.9 * (1 - age / 0.8)) : '0';
    }

    // Flash overlay: derived from the player's blindedUntil (weapon.js
    // sets blindedUntil = state.time + duration on flash victims; max
    // duration is 3s, so remaining / 3 is already 0..1). Nothing ever
    // wrote p.flashStrength, so the old read here was always 0.
    if (el.flashOverlay) {
      const remaining = (p.blindedUntil || 0) - (state.time || 0);
      const opacity = remaining > 0 ? Math.min(1, remaining / 3) : 0;
      el.flashOverlay.style.opacity = String(opacity);
    }

    // Crosshair gap grows with spread (weapon bloom + movement).
    if (el.crosshair) {
      const gap = 4 + (p.spread || 0) * 60;
      el.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
      el.crosshair.classList.toggle('dead', !p.alive);
    }

    // Minimap: blit the cached static layer, then live dots — player
    // amber, alive bots in team colours, planted site pulsing red.
    if (mmCtx && mmStatic) {
      mmCtx.clearRect(0, 0, MM_W, MM_H);
      mmCtx.drawImage(mmStatic, 0, 0);
      for (const [letter, site] of Object.entries((world && world.sites) || {})) {
        const planted = state.bomb.state === 'planted'
          && (state.bomb.plantedSite || state.bomb.site) === letter;
        if (!planted) continue;
        const [cx, cy] = mmProject(site.x, site.z);
        mmCtx.strokeStyle = `rgba(255, 59, 48, ${0.6 + 0.4 * Math.sin(state.time * 6)})`;
        mmCtx.lineWidth = 2;
        mmCtx.beginPath();
        mmCtx.arc(cx, cy, 8, 0, Math.PI * 2);
        mmCtx.stroke();
      }
      const dot = (x, z, color, r) => {
        const [dx, dy] = mmProject(x, z);
        mmCtx.fillStyle = color;
        mmCtx.beginPath();
        mmCtx.arc(dx, dy, r, 0, Math.PI * 2);
        mmCtx.fill();
      };
      for (const b of state.bots || []) {
        if (b.alive) dot(b.pos.x, b.pos.z, b.team === 'vanguard' ? '#ffaa00' : '#00ccbb', 3);
      }
      if (p.alive) dot(p.pos.x, p.pos.z, '#ffb347', 4);
    }

    // Hitmarker auto-hide.
    if (el.hitmarker && hitmarkerUntil && performance.now() > hitmarkerUntil) {
      el.hitmarker.style.opacity = '0';
      hitmarkerUntil = 0;
    }

    // Keep buy menu prices fresh while it is open.
    if (buyOpen && state.phase === 'buy') {
      const title = el.buyMenu && el.buyMenu.querySelector('.buy-title');
      if (title) title.textContent = `BUY PHASE — $${state.money}`;
    } else if (buyOpen && state.phase !== 'buy') {
      closeBuyMenu();
    }
  }

  return {
    el,
    update,
    openBuyMenu,
    closeBuyMenu,
    showHitmarker,
    isBuyOpen: () => buyOpen,
    setWeapons(w) { weaponsRef = w; },
    // Menu overlay helpers for main.js (Play button / pause).
    setOverlay(title, copy, showPlay) {
      if (el.overlayTitle) el.overlayTitle.textContent = title;
      if (el.overlayCopy) el.overlayCopy.textContent = copy;
      if (el.playBtn) el.playBtn.style.display = showPlay ? '' : 'none';
      if (el.overlay) el.overlay.style.display = '';
    },
    hideOverlay() {
      if (el.overlay) el.overlay.style.display = 'none';
    },
  };
}

export function updateHud(hud, state, dt) {
  hud.update(state, dt);
}
