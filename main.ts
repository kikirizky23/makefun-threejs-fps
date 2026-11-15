// main.ts — build entry for the EMBERWORKS make.fun submission.
// Node 22 stdlib only. Copies game/ and screenshots/ from beside this file
// into the output dir, then writes /output/dossier.json via the vendor helper.
// Run: node main.ts (or: MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts)
import { cp, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

await mkdir(out, { recursive: true });
await cp(join(here, 'game'), join(out, 'game'), { recursive: true });
await cp(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// buildDossier is SYNC and RETURNS the canonical dossier bytes — the
// caller must write them. Discarding the return value left /output
// without dossier.json, so capture it and write it out here.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000, // match the scorer's per-path limit exactly
}));

console.log(`Built EMBERWORKS into ${out}`);
