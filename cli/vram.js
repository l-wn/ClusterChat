// How much GPU memory this machine has free, and how much to suggest lending.
//
// WebGPU does not report memory, so this asks the driver: nvidia-smi for
// NVIDIA (Linux and Windows), sysfs for AMD on Linux, and the system memory
// for Apple Silicon, where the GPU shares it. Anything else reports nothing,
// and lending then grows until the GPU is full (the engine stops itself).

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';

const GB = 2 ** 30;

// { name, total, used, shared } in bytes, one per GPU found. Never throws.
export async function readGpus() {
    const found = [...await nvidia(), ...await amd()];
    if (!found.length && process.platform === 'darwin' && process.arch === 'arm64') found.push(apple());
    return found;
}

// `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits`
// prints one "name, MiB, MiB" line per GPU.
export function parseNvidiaSmi(text) {
    return text.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((p) => p.length === 3)
        .map(([name, total, used]) => ({ name, total: Number(total) * 2 ** 20, used: Number(used) * 2 ** 20, shared: false }))
        .filter((g) => g.name && g.total > 0 && Number.isFinite(g.used));
}

function nvidia() {
    return new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'],
            { timeout: 5000 }, (err, stdout) => resolve(err ? [] : parseNvidiaSmi(stdout)));
    });
}

async function amd() {
    if (process.platform !== 'linux') return [];
    const cards = await readdir('/sys/class/drm').catch(() => []);
    const out = [];
    for (const card of cards.filter((c) => /^card\d+$/.test(c))) {
        const dir = `/sys/class/drm/${card}/device`;
        const [total, used] = await Promise.all(['total', 'used'].map((k) =>
            readFile(`${dir}/mem_info_vram_${k}`, 'utf8').then(Number, () => NaN)));
        if (total > 0 && Number.isFinite(used)) out.push({ name: `AMD GPU (${card})`, total, used, shared: false });
    }
    return out;
}

// Metal lets the GPU use about three quarters of system memory by default.
function apple() {
    const total = os.totalmem() * 0.75;
    return { name: 'Apple GPU', total, used: Math.min(total, os.totalmem() - os.freemem()), shared: true };
}

// The GPU that matches the WebGPU adapter's label, else the one with the most
// free memory.
export function pickGpu(gpus, label = '') {
    const words = (s) => s.toLowerCase().replace(/nvidia|geforce|amd|radeon|\(.*?\)/g, ' ').split(/\W+/).filter(Boolean);
    const want = new Set(words(label));
    const match = gpus.find((g) => { const w = words(g.name); return w.length && w.every((x) => want.has(x)); });
    return match ?? [...gpus].sort((a, b) => (b.total - b.used) - (a.total - a.used))[0] ?? null;
}

// What to suggest lending: the free memory less headroom for the desktop and
// other programs (2 GB, or a tenth of the card if that is more), in whole GB.
// 0 when there is not enough to be worth it.
export function suggestBytes(gpu) {
    if (!gpu) return null;
    const headroom = Math.max(2 * GB, gpu.total * 0.1);
    return Math.max(0, Math.floor((gpu.total - gpu.used - headroom) / GB)) * GB;
}

export const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
// A held size: in MB below a tenth of a GB, so a small model does not read 0.0 GB.
export const size = (bytes) => bytes >= GB / 10 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
