#!/usr/bin/env node
// Offline lightmap / AO bake. Run `npm run bake` whenever BridgeGeometry.js
// changes. Output is consumed at runtime by BakedLighting.js.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBridgeStatic, collectStatic } from '../src/environment/BridgeGeometry.js';
import { bakeVertexLighting, encodeBase64 } from '../src/environment/AOBaker.js';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../public/baked/bridge-ao.json');

const samples = Number(process.argv[2] ?? 64);
const t0 = performance.now();
const group = buildBridgeStatic();
const meshes = collectStatic(group);
const vertexTotal = meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
console.log(`Baking ${meshes.length} static meshes / ${vertexTotal} vertices @ ${samples} samples...`);

const baked = bakeVertexLighting(meshes, {
  samples,
  onProgress: (i, n, name) => {
    if (i % 10 === 0 || i === n) process.stdout.write(`  ${i}/${n} ${name}\n`);
  },
});

const out = { version: 1, samples, generated: new Date().toISOString(), meshes: {} };
for (const [name, { count, rgb }] of Object.entries(baked)) out.meshes[name] = { count, rgb: encodeBase64(rgb) };

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out));
console.log(`Wrote ${outFile} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
