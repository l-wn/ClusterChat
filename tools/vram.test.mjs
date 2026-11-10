// Tests cli/vram.js: reading nvidia-smi's output, picking the GPU that
// matches the WebGPU adapter, and the amount suggested for lending.
//
//   node tools/vram.test.mjs

import { parseNvidiaSmi, pickGpu, suggestBytes } from '../cli/vram.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${g}, want ${w}`); }
};
const GB = 2 ** 30, MiB = 2 ** 20;

const two = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 1900\nNVIDIA GeForce GTX 1070 Ti, 8192, 465\n');
eq('reads every line', two.map((g) => g.name), ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce GTX 1070 Ti']);
eq('MiB to bytes', [two[0].total, two[0].used], [24564 * MiB, 1900 * MiB]);
eq('skips junk', parseNvidiaSmi('NVIDIA-SMI has failed\n'), []);
eq('[N/A] memory is skipped', parseNvidiaSmi('Some GPU, [N/A], [N/A]'), []);

eq('matches the adapter label', pickGpu(two, 'NVIDIA GeForce GTX 1070 Ti · nvidia · pascal')?.name, 'NVIDIA GeForce GTX 1070 Ti');
eq('else the most free', pickGpu(two, 'something else')?.name, 'NVIDIA GeForce RTX 4090');
eq('no GPUs', pickGpu([], 'x'), null);

eq('24 GB card, 1.9 in use: 19 GB', suggestBytes({ total: 24 * GB, used: 1.9 * GB }) / GB, 19);
eq('8 GB card, 0.5 in use: 5 GB', suggestBytes({ total: 8 * GB, used: 0.5 * GB }) / GB, 5);
eq('80 GB card: a tenth kept back', suggestBytes({ total: 80 * GB, used: 0 }) / GB, 72);
eq('nearly full: 0', suggestBytes({ total: 8 * GB, used: 7 * GB }), 0);
eq('unknown: null', suggestBytes(null), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
