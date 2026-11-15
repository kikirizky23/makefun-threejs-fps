// EMBERWORKS — static foundry map (original, ~64 x 44 units).
// Built only from BoxGeometry / PlaneGeometry + MeshStandardMaterial.
// No external assets, no network, no textures loaded from files — the
// site decals are drawn on a canvas in code.
//
// Layout (x: west -32 .. east +32, z: north -22 .. south +22):
//   Vanguard spawns west, Sentinel spawns east.
//   Site A sits north-east, site B south-east, mid lane runs down z = 0.
//   A cross wall at x = 0 divides the map; it has three gaps (A door,
//   mid door, B door) so each lane has exactly one choke to fight over.
//   Crates and furnace blocks give cover along every lane.
//
// Colliders are 2D AABBs { minX, maxX, minZ, maxZ, top }. Every solid
// that reaches the floor gets one, so movement code only needs this list.
// Overhead gantries get NO collider (players walk under them); their
// support legs do, because the legs reach the floor.

import * as THREE from 'three';
import { PALETTE } from './palette.js';

const BOUNDS = { minX: -32, maxX: 32, minZ: -22, maxZ: 22 };

// Eye height used by the line-of-sight test. Crates shorter than this
// give cover from the waist down but do NOT block sight over the top.
const EYE_HEIGHT = 1.6;

function makeMat(color, roughness = 0.9, metalness = 0.15) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// Canvas decal: big letter + ring on a transparent background, used flat
// on the floor to mark a bombsite. Drawn in code, so no asset files.
function siteDecalTexture(letter, accentCss) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = accentCss;
  g.lineWidth = 10;
  g.beginPath();
  g.arc(128, 128, 104, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 4;
  g.beginPath();
  g.arc(128, 128, 84, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = accentCss;
  g.font = 'bold 150px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 128, 134);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Hazard stripes drawn on a canvas, tiled along a thin box face.
function hazardTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#d8a018';
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#1c1c1c';
  for (let x = -32; x < 160; x += 32) {
    g.beginPath();
    g.moveTo(x, 32);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 32);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildWorld(scene) {
  const colliders = [];
  const group = new THREE.Group();
  group.name = 'emberworks';
  scene.add(group);

  // ---- atmosphere -------------------------------------------------
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.fog, 28, 78);

  // ---- materials (shared, so the map stays cheap) -----------------
  const floorMat = makeMat(PALETTE.floor, 0.95, 0.05);
  const floorWarmMat = makeMat(PALETTE.floorWarm, 0.95, 0.05);
  const wallMat = makeMat(PALETTE.concreteDark, 0.95, 0.05);
  const wallTopMat = makeMat(PALETTE.steelDark, 0.8, 0.25);
  const steelMat = makeMat(PALETTE.steel, 0.6, 0.35);
  const steelDarkMat = makeMat(PALETTE.steelDark, 0.7, 0.3);
  const crateMat = makeMat(PALETTE.crate, 0.9, 0.05);
  const crateDarkMat = makeMat(PALETTE.crateDark, 0.9, 0.05);
  const pipeMat = makeMat(PALETTE.pipe, 0.5, 0.4);
  const tealMat = makeMat(PALETTE.tealDark, 0.7, 0.25);
  const emberMat = new THREE.MeshStandardMaterial({
    color: PALETTE.emberDim, emissive: PALETTE.ember, emissiveIntensity: 1.6,
    roughness: 0.6, metalness: 0.1,
  });
  const hazardMat = new THREE.MeshStandardMaterial({
    map: hazardTexture(), roughness: 0.85, metalness: 0.1,
  });

  // ---- helpers ----------------------------------------------------
  function box(w, h, d, mat, x, y, z, opts = {}) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (opts.ry) m.rotation.y = opts.ry;
    m.castShadow = opts.shadow !== false;
    m.receiveShadow = true;
    group.add(m);
    return m;
  }

  // Solid block that also blocks movement. y is the centre height.
  // The mesh is stored on the collider too, so the weapon raycaster
  // (which needs real THREE.Object3D meshes, not plain AABB data)
  // can test walls for blocking. Movement / LOS code keeps reading
  // only the AABB fields and ignores this extra field.
  function solid(w, h, d, mat, x, y, z, opts = {}) {
    const mesh = box(w, h, d, mat, x, y, z, opts);
    colliders.push({
      minX: x - w / 2, maxX: x + w / 2,
      minZ: z - d / 2, maxZ: z + d / 2,
      top: y + h / 2,
      mesh,
    });
  }

  // Crate (optionally a stack: a second smaller crate on top). The
  // collider covers the whole stack footprint at the full height.
  function crate(x, z, w = 2, h = 2, d = 2, stack = false) {
    const mat = (x + z) % 4 === 0 ? crateDarkMat : crateMat;
    solid(w, h, d, mat, x, h / 2, z);
    // Lid rim so crates read as boxes, not flat slabs.
    box(w + 0.08, 0.12, d + 0.08, steelDarkMat, x, h + 0.02, z);
    if (stack) {
      const sw = w * 0.7;
      const sh = h * 0.7;
      box(sw, sh, sw, crateDarkMat, x, h + sh / 2, z, { ry: 0.35 });
      // Widen the collider top to the stacked height.
      colliders[colliders.length - 1].top = h + sh;
    }
  }

  // ---- floor ------------------------------------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(64, 44), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // Warm worn strips down the middle of each lane — cheap visual
  // wayfinding: attackers follow the warm floor toward the sites.
  for (const z of [-15, 0, 15]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(64, 3.2), floorWarmMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.02, z);
    strip.receiveShadow = true;
    group.add(strip);
  }

  // ---- perimeter walls --------------------------------------------
  const WALL_H = 5;
  const T = 1; // wall thickness
  // North / south (long sides).
  solid(64 + 2 * T, WALL_H, T, wallMat, 0, WALL_H / 2, -22 - T / 2);
  solid(64 + 2 * T, WALL_H, T, wallMat, 0, WALL_H / 2, 22 + T / 2);
  // West / east (short sides).
  solid(T, WALL_H, 44 + 2 * T, wallMat, -32 - T / 2, WALL_H / 2, 0);
  solid(T, WALL_H, 44 + 2 * T, wallMat, 32 + T / 2, WALL_H / 2, 0);
  // Steel coping along the top of the long walls.
  box(66, 0.3, 1.2, wallTopMat, 0, WALL_H + 0.15, -22.5);
  box(66, 0.3, 1.2, wallTopMat, 0, WALL_H + 0.15, 22.5);

  // ---- mid cross wall (x = 0) with three doorways -----------------
  // Wall segments between the gaps: gaps are 4 wide, centred on
  // z = -14 (A door), z = 0 (mid door) and z = +14 (B door).
  const gapHalf = 2;
  const doorCentres = [-14, 0, 14];
  let cursor = -22;
  for (const dz of doorCentres) {
    const segStart = cursor;
    const segEnd = dz - gapHalf;
    if (segEnd > segStart) {
      const len = segEnd - segStart;
      solid(T, WALL_H, len, wallMat, 0, WALL_H / 2, segStart + len / 2);
    }
    // Lintel above each doorway + hazard strip on the floor.
    box(1.4, 1.2, 4.4, steelDarkMat, 0, WALL_H - 0.6, dz);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 4.4), hazardMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.03, dz);
    strip.receiveShadow = true;
    group.add(strip);
    cursor = dz + gapHalf;
  }
  if (cursor < 22) {
    const len = 22 - cursor;
    solid(T, WALL_H, len, wallMat, 0, WALL_H / 2, cursor + len / 2);
  }

  // ---- EMBERWORKS landmark (decorative only — no colliders, no layout change)
  // Big site letters on the mid cross-wall faces + a glowing molten-pour
  // channel down mid-lane + an EMBERWORKS sign on the mid-door lintel,
  // so the map reads as its own foundry at a glance.
  for (const [letter, z, accent] of [['A', -10, PALETTE.emberCss], ['B', 10, PALETTE.tealCss]]) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({ map: siteDecalTexture(letter, accent), transparent: true, depthWrite: false }),
    );
    decal.position.set(-0.53, 2.6, z); // just off the west face of the cross wall
    decal.rotation.y = -Math.PI / 2; // face west, toward the Vanguard push
    group.add(decal);
  }
  // Molten pour: emissive strip down mid-lane (z = 0), flat on the floor.
  const pour = new THREE.Mesh(new THREE.PlaneGeometry(56, 0.6), emberMat);
  pour.rotation.x = -Math.PI / 2;
  pour.position.set(0, 0.05, 0);
  pour.receiveShadow = true;
  group.add(pour);
  // Wall sign above the mid doorway, mounted on the lintel face.
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 512;
  signCanvas.height = 96;
  const sg = signCanvas.getContext('2d');
  sg.fillStyle = '#ffb347';
  sg.font = 'bold 64px system-ui, sans-serif';
  sg.textAlign = 'center';
  sg.textBaseline = 'middle';
  sg.fillText('EMBERWORKS', 256, 50);
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 0.75),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }),
  );
  sign.position.set(-0.72, 4.4, 0);
  sign.rotation.y = -Math.PI / 2;
  group.add(sign);

  // ---- furnaces (north + south walls, mid-map) --------------------
  // Big ember blocks with a glowing mouth; also the point lights live
  // here, so the warm light has a visible source.
  const furnaceLights = [];
  for (const zSide of [-1, 1]) {
    const fz = zSide * 20.5;
    solid(8, 4.5, 2.5, steelDarkMat, -8, 2.25, fz);
    box(6, 2.2, 0.4, emberMat, -8, 1.6, fz - zSide * 1.3, { shadow: false });
    box(8.6, 0.5, 3, steelMat, -8, 4.75, fz);
    // Chimney rising above the roofline.
    box(1.6, 4, 1.6, steelMat, -10.5, 6.5, fz);
    const pl = new THREE.PointLight(PALETTE.furnace, 60, 22, 1.8);
    pl.position.set(-8, 2.2, fz - zSide * 3.5);
    group.add(pl);
    furnaceLights.push(pl);
  }

  // ---- crates: cover along every lane ------------------------------
  // A lane (north, z ~ -15): staggered crates force peeking, not sprinting.
  crate(-24, -15, 2, 2, 2);
  crate(-18, -17.5, 2, 1.2, 2);
  crate(-12, -13.5, 2.4, 2.4, 2.4, true); // stacked — tall cover
  crate(-6, -17, 2, 2, 2);
  crate(6, -13, 2, 1.2, 2);
  crate(12, -17.5, 2, 2, 2);
  crate(18, -14, 2.4, 2.4, 2.4, true);
  // Mid lane (z ~ 0): low crates only, so mid stays a sightline lane.
  crate(-20, 2.5, 2, 1.2, 2);
  crate(-14, -2.5, 2, 1.2, 2);
  crate(-8, 3, 2, 1.2, 2);
  crate(8, -3, 2, 1.2, 2);
  crate(14, 2.5, 2, 1.2, 2);
  crate(20, -2.5, 2, 1.2, 2);
  // B lane (south, z ~ +15): mirror of A with different stack spots.
  crate(-24, 15, 2, 2, 2);
  crate(-18, 12.5, 2, 1.2, 2);
  crate(-12, 16.5, 2.4, 2.4, 2.4, true);
  crate(-6, 13, 2, 2, 2);
  crate(6, 17, 2, 1.2, 2);
  crate(12, 12.5, 2, 2, 2);
  crate(18, 16, 2.4, 2.4, 2.4, true);
  // Site cover — defenders get a tall box on each site to play around.
  crate(24, -18.5, 2, 2, 2);
  crate(27, -12, 2, 1.2, 2);
  crate(24, 18.5, 2, 2, 2);
  crate(27, 12, 2, 1.2, 2);
  // Spawn cover so nobody is picked the instant the round starts.
  crate(-27, -6, 2, 2, 2);
  crate(-27, 6, 2, 2, 2);
  crate(27, -6, 2, 2, 2);
  crate(27, 6, 2, 2, 2);

  // ---- pipes along the walls (long thin boxes) ---------------------
  // North wall pipe run + south wall pipe run, with vertical drops.
  box(60, 0.5, 0.5, pipeMat, 0, 4.2, -21.4);
  box(60, 0.35, 0.35, tealMat, 0, 3.6, -21.4);
  box(60, 0.5, 0.5, pipeMat, 0, 4.2, 21.4);
  box(60, 0.35, 0.35, tealMat, 0, 3.6, 21.4);
  for (const px of [-28, -4, 20]) {
    box(0.5, 4.2, 0.5, pipeMat, px, 2.1, -21.4);
    box(0.5, 4.2, 0.5, pipeMat, px, 2.1, 21.4);
  }

  // ---- overhead gantries (no colliders — walk underneath) ----------
  // Two steel walkways crossing the lanes at y = 6, legs at the edges.
  for (const gx of [-16, 16]) {
    box(1.2, 0.6, 44, steelMat, gx, 6.2, 0);
    box(1.2, 0.3, 44, steelDarkMat, gx, 5.8, 0);
    for (const gz of [-20, 20]) {
      solid(0.8, 6, 0.8, steelDarkMat, gx - 0.9, 3, gz);
      solid(0.8, 6, 0.8, steelDarkMat, gx + 0.9, 3, gz);
    }
  }

  // ---- bombsites ---------------------------------------------------
  const sites = {
    A: { x: 24, z: -15, r: 4.5 },
    B: { x: 24, z: 15, r: 4.5 },
  };
  for (const [letter, site] of Object.entries(sites)) {
    const accent = letter === 'A' ? PALETTE.emberCss : PALETTE.tealCss;
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(site.r * 2, site.r * 2),
      new THREE.MeshBasicMaterial({
        map: siteDecalTexture(letter, accent),
        transparent: true, depthWrite: false,
      }),
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(site.x, 0.04, site.z);
    group.add(decal);
    // Low ember/teal strip lights ringing each site so it reads at dusk.
    const ring = new THREE.PointLight(
      letter === 'A' ? PALETTE.ember : PALETTE.teal, 18, 14, 1.8,
    );
    ring.position.set(site.x, 2.5, site.z);
    group.add(ring);
  }

  // ---- spawn pads (painted floor squares, no colliders) ------------
  function spawnPad(x, z, colorCss) {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ color: colorCss, transparent: true, opacity: 0.25 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(x, 0.03, z);
    group.add(pad);
  }
  spawnPad(-28, 0, PALETTE.vanguard);
  spawnPad(28, 0, PALETTE.sentinel);

  // ---- lighting ----------------------------------------------------
  // F6 readability: hemisphere 0.55 + near-black ground bounce left the
  // lower frame unreadable. Hemi 1.1 with the ground colour lifted
  // (palette hemiGround 0x1c1410 is too dark to use as-is) and a
  // slightly stronger sun; orange/teal accents untouched.
  const hemi = new THREE.HemisphereLight(
    PALETTE.hemiSky,
    new THREE.Color(PALETTE.hemiGround).multiplyScalar(2.5),
    1.1,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(PALETTE.sun, 1.35);
  sun.position.set(-30, 26, -18); // low dusk sun from the west
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); // modest map — big enough, cheap
  sun.shadow.camera.left = -36;
  sun.shadow.camera.right = 36;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // ---- data for gameplay -------------------------------------------
  const spawns = {
    // Vanguard (attackers) face east (+x), fanned across the west end.
    vanguard: [
      { x: -29, z: -8, yaw: -Math.PI / 2 },
      { x: -29, z: -3, yaw: -Math.PI / 2 },
      { x: -29, z: 0, yaw: -Math.PI / 2 },
      { x: -29, z: 3, yaw: -Math.PI / 2 },
      { x: -29, z: 8, yaw: -Math.PI / 2 },
    ],
    // Sentinel (defenders) face west (-x), split between the sites.
    sentinel: [
      { x: 28, z: -16, yaw: Math.PI / 2 },
      { x: 28, z: -11, yaw: Math.PI / 2 },
      { x: 28, z: 0, yaw: Math.PI / 2 },
      { x: 28, z: 11, yaw: Math.PI / 2 },
      { x: 28, z: 16, yaw: Math.PI / 2 },
    ],
  };

  const waypoints = {
    // West -> east along each lane, through its mid-wall doorway.
    a: [
      { x: -28, z: -15 }, { x: -20, z: -15 }, { x: -12, z: -15 },
      { x: -4, z: -14 }, { x: 0, z: -14 }, { x: 6, z: -15 },
      { x: 14, z: -15 }, { x: 20, z: -15 }, { x: 24, z: -15 },
    ],
    mid: [
      { x: -28, z: 0 }, { x: -20, z: 0 }, { x: -12, z: 0 },
      { x: -4, z: 0 }, { x: 0, z: 0 }, { x: 6, z: 0 },
      { x: 14, z: 0 }, { x: 20, z: 0 }, { x: 26, z: 0 },
    ],
    b: [
      { x: -28, z: 15 }, { x: -20, z: 15 }, { x: -12, z: 15 },
      { x: -4, z: 14 }, { x: 0, z: 14 }, { x: 6, z: 15 },
      { x: 14, z: 15 }, { x: 20, z: 15 }, { x: 24, z: 15 },
    ],
  };

  return {
    colliders,
    spawns,
    sites,
    waypoints,
    bounds: { ...BOUNDS },
    group,
    lights: { hemi, sun, furnaces: furnaceLights },
  };
}

// 2D segment-vs-AABB test (slab method). Returns true when the segment
// from (ax, az) to (bx, bz) hits the box. A collider only blocks sight
// when its top is above eye height — low crates give cover, not a
// sight block. Touching an edge counts as blocked (conservative).
function segmentHitsAABB(ax, az, bx, bz, c) {
  if (c.top <= EYE_HEIGHT) return false;
  const dx = bx - ax;
  const dz = bz - az;
  let tmin = 0;
  let tmax = 1;
  // X slab.
  if (Math.abs(dx) < 1e-9) {
    if (ax < c.minX || ax > c.maxX) return false;
  } else {
    let t1 = (c.minX - ax) / dx;
    let t2 = (c.maxX - ax) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  // Z slab.
  if (Math.abs(dz) < 1e-9) {
    if (az < c.minZ || az > c.maxZ) return false;
  } else {
    let t1 = (c.minZ - az) / dz;
    let t2 = (c.maxZ - az) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

// Line of sight between two ground points. True when no tall collider
// sits between them. Bots use this before shooting; players could use
// it for the same check.
export function hasLineOfSight(world, ax, az, bx, bz) {
  for (const c of world.colliders) {
    if (segmentHitsAABB(ax, az, bx, bz, c)) return false;
  }
  return true;
}

// Which bombsite (if any) contains a ground point — used by the bomb
// plant/defuse logic. Returns 'A', 'B', or null. The site radius is a
// flat circle on the floor, so this is a plain 2D distance check.
export function siteAtPoint(world, x, z) {
  for (const [letter, site] of Object.entries(world.sites)) {
    const dx = x - site.x;
    const dz = z - site.z;
    if (dx * dx + dz * dz <= site.r * site.r) return letter;
  }
  return null;
}

// True when a ground point is inside the playable area (inside the
// perimeter walls). Movement code clamps to this before testing the
// individual colliders.
export function insideBounds(world, x, z) {
  const b = world.bounds;
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

// Resolve a ground point against the map colliders, in place.
// FROZEN SIGNATURE — bots.js uses this for bot movement.
// Mirrors player.js collideAxis exactly: each collider is a 2D AABB
// { minX, maxX, minZ, maxZ, top } expanded by `radius`, and the point
// is pushed out to the nearest face on one axis at a time (X pass,
// then Z pass) so diagonal movement slides along walls instead of
// sticking to corners. No Y check: bots stay on the floor (feet y=0),
// which is below every collider top, so every collider blocks — the
// same condition player.js applies as `feetY < box.top`. Bounds are
// NOT clamped here; call insideBounds / clamp separately if needed.
export function collideXZ(world, pos, radius) {
  const colliders = (world && world.colliders) || [];
  const r = radius == null ? 0.35 : radius;
  // X pass.
  for (const c of colliders) {
    const minX = c.minX - r;
    const maxX = c.maxX + r;
    const minZ = c.minZ - r;
    const maxZ = c.maxZ + r;
    if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ) continue;
    pos.x = Math.abs(pos.x - minX) < Math.abs(pos.x - maxX) ? minX : maxX;
  }
  // Z pass (re-reads pos.x: a point pushed out on X may already be clear).
  for (const c of colliders) {
    const minX = c.minX - r;
    const maxX = c.maxX + r;
    const minZ = c.minZ - r;
    const maxZ = c.maxZ + r;
    if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ) continue;
    pos.z = Math.abs(pos.z - minZ) < Math.abs(pos.z - maxZ) ? minZ : maxZ;
  }
}
