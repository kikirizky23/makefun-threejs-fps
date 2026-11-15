// state.js — the single game store for EMBERWORKS (5v5 tactical FPS).
// Every module reads/writes this object; nothing else holds game state.
import * as THREE from 'three';

export function createState(seed = 1) {
  return {
    tick: 0,
    time: 0,
    phase: 'menu', // 'menu' | 'buy' | 'live' | 'roundEnd' | 'matchEnd'
    round: 1,
    roundTime: 100, // seconds left in the live round (buy phase uses its own timer in rounds.js)
    score: { vanguard: 0, sentinel: 0 },
    money: 800,
    player: {
      id: 'player', // stable id: bot AI + killfeed compare against this
      team: 'vanguard', // the player is Vanguard; bots use it for same-team checks
      pos: { x: 0, y: 1.7, z: 18 },
      yaw: 0,
      pitch: 0,
      hp: 100,
      crouched: false,
      weapon: 'rifle',
      ammo: { mag: 30, reserve: 90 },
      alive: true,
      bodyMesh: null, // set by main.js: invisible hitbox meshes (see below)
      headMesh: null,
      hitboxGroup: null,
      vy: 0,
      onGround: true,
      moveSpeed: 0,
      spread: 0, // current crosshair spread (radians-ish, hud reads this)
      lastDamageAt: -99,
    },
    bots: [], // filled by bots.js: { id, team, pos, yaw, hp, alive, weapon, ... }
    bomb: {
      state: 'carried', // 'carried' | 'planted' | 'defused' | 'exploded' | 'dropped'
      site: null, // 'A' | 'B' | null
      timer: 0, // fuse countdown once planted
      carrier: null, // bot/player id carrying the bomb
      plantProgress: 0,
      defuseProgress: 0,
    },
    events: [], // { t, text, kind } — killfeed + banner source
    kills: [], // { t, killer, victim, weapon }
    smokes: [], // { pos: THREE.Vector3, until }
  };
}

// Small helpers the loop uses so modules don't duplicate the math.
export function addEvent(state, text, kind = 'info') {
  state.events.push({ t: state.time, text, kind });
  if (state.events.length > 20) state.events.shift();
}
