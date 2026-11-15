// EMBERWORKS — dusk foundry palette.
// One source of truth for colours: world.js, HUD (via CSS vars) and any
// later module read from here so the whole game stays on one palette.
// Numeric values are for three.js; the Css twins are for DOM/CSS use.

export const PALETTE = {
  // Sky / atmosphere
  sky: 0x1a1210, skyCss: '#1a1210',       // dark dusk sky, warm-tinted black
  fog: 0x241812, fogCss: '#241812',       // warm haze over the foundry floor
  // Accent — molten ember orange, used sparingly (sites, lights, HUD)
  ember: 0xff6a1a, emberCss: '#ff6a1a',
  emberHot: 0xffb347, emberHotCss: '#ffb347', // furnace glow highlight
  emberDim: 0x8a3a10, emberDimCss: '#8a3a10', // cooled ember / rust
  // Shadow / cool contrast — teal steel in shade
  teal: 0x2e6f6a, tealCss: '#2e6f6a',
  tealDark: 0x16383a, tealDarkCss: '#16383a',
  // Structure — dark steel and concrete
  steel: 0x3a4148, steelCss: '#3a4148',
  steelDark: 0x23282e, steelDarkCss: '#23282e',
  steelLight: 0x5a636d, steelLightCss: '#5a636d',
  concrete: 0x6b655c, concreteCss: '#6b655c',
  concreteDark: 0x4a453e, concreteDarkCss: '#4a453e',
  // Floor — warm worn metal plates
  floor: 0x2e2620, floorCss: '#2e2620',
  floorWarm: 0x4d3a28, floorWarmCss: '#4d3a28',
  // Props — crates, pipes, hazard paint
  crate: 0x7a5a33, crateCss: '#7a5a33',
  crateDark: 0x54401f, crateDarkCss: '#54401f',
  pipe: 0x8a7a5a, pipeCss: '#8a7a5a',
  hazard: 0xd8a018, hazardCss: '#d8a018', // hazard-stripe yellow
  // Lighting
  hemiSky: 0x8a6a5a, hemiGround: 0x1c1410, // dusk bounce / floor bounce
  sun: 0xff9a4d, furnace: 0xff7a22,        // low dusk sun / furnace points
  // HUD / text
  text: '#e8ded2', textDim: '#9a8d7c',
  vanguard: '#ff8c2e', sentinel: '#3ec6c6', // attacker ember / defender teal
  danger: '#ff3b30', ok: '#7ee081',
};

// Helper for modules that need a CSS colour from a numeric entry:
// css(PALETTE.ember) -> '#ff6a1a'. Keeps the two forms from drifting.
export function css(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

// Team colour lookup by side name ('vanguard' | 'sentinel'), so game
// logic never hard-codes a team colour in two places.
export function teamCss(side) {
  return side === 'sentinel' ? PALETTE.sentinel : PALETTE.vanguard;
}
