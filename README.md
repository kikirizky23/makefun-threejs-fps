# EMBERWORKS

A tactical 5v5 FPS built with Three.js. Two teams — Vanguard (attackers)
and Sentinel (defenders) — fight over two bomb sites, A and B, on a
three-lane industrial map.

## How a round works

- Each round starts with a **buy phase** (15s, press B to open the shop).
  Spend your money on weapons and grenades; unspent money carries over.
  You start a match with $800; a round win pays $3,250, a loss $1,900.
  Kills pay nothing.
- Vanguard carries the bomb. The carrier plants automatically by
  standing inside site A or B for 3s — there is no plant key. Once
  planted, the 35s fuse runs; Sentinel defuses by standing in the
  planted site for 5s. Leaving the site pauses progress, which then
  decays — no partial-plant banking.
- A round lasts 100s. Sentinel wins by eliminating Vanguard, defusing
  a planted bomb, or running the timer out with no plant. Vanguard
  wins by detonating the bomb or eliminating Sentinel.
- First team to 5 round wins takes the match; 8 rounds max. Weapons
  (and your money) carry across rounds; health and ammo refill.

## Controls

- WASD — move, Shift — slow walk (2.6 m/s vs 4.2 m/s walk; no sprint),
  Space — jump, C — crouch
- Mouse — aim, Left click — fire, R — reload
- 1 / 2 / 3 — switch between OWNED weapons only (rifle / smg / pistol);
  buy a weapon to unlock it — switching itself is free; buying a weapon in the
  shop equips it and refills its ammo. Q does nothing.
- B — buy menu (buy phase only), G — throw grenade (flash if owned,
  else smoke). Planting and defusing are automatic — stand in the site;
  E has no function.
- Esc — pause (pointer lock released)

## How to run

```sh
node serve.ts            # serves game/ at http://localhost:8080/
# or: node serve.ts --port 8080
```

Open http://localhost:8080/ in a browser, click Play, and lock the pointer.

## Screenshot staging

Append `?shot=start|play|buy|plant&seed=1` to stage fixed scenes
for screenshots (no pointer lock needed in shot mode). `?seed=` sets
the seed for the PRNG stored on state (currently unused by gameplay);
shot spread uses `Math.random()`, so shots are not bit-identical
across runs.

## Tech

- Three.js, fixed-step simulation (60 Hz); seeded PRNG on state
  (reserved — spread and bot layout do not consume it yet)
- Synthesized WebAudio sound effects — no audio files
- No build step: ES modules served as-is from `game/`
