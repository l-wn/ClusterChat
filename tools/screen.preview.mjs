// Draws cli/screen.js's dashboard in every state, with made-up numbers, so
// its look can be checked without a GPU or a cluster.
//
//   node tools/screen.preview.mjs              every state, 100 columns
//   node tools/screen.preview.mjs --width 60   at another width
//   NO_COLOR=1 node tools/screen.preview.mjs   as a monochrome terminal shows it
//   node tools/screen.preview.mjs --light      the light-up, animated

import { statusLine, panel, machineSection, connectSection, requestsHeader, footer, LIGHT_MS, visible } from '../cli/screen.js';

const arg = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i < 0 ? d : process.argv[i + 1]; };
const width = Number(arg('width', 80));
const GB = 2 ** 30, L = 36, N = L + 2;
const now = Date.now();
const gpu = { name: 'RTX 3060', mem: { total: 12 * GB, used: 0.4 * GB }, suggest: 9 * GB };
const posBytes = Array.from({ length: N }, () => 0.2 * GB);
const full = { depths: Array.from({ length: N }, () => 1), covered: N, total: N, r: 1 };
const backed = { ...full, depths: full.depths.map(() => 2), r: 2 };
const holey = { depths: Array.from({ length: N }, (_, p) => (p >= 26 ? 0 : 1)), covered: 26, total: N, r: 0 };
const loading = Array.from({ length: N }, (_, p) => (p >= 26 ? 1 : 0));
const tools = [{ label: 'Claude Code', cmd: 'npx clusterchat@latest claude' },
               { label: 'opencode', cmd: 'npx clusterchat@latest setup opencode --write' }];
const base = { model: 'Qwen3.5-4B', url: 'http://127.0.0.1:4747', status: { kind: 'ready' }, room: 'private cluster 1561bb',
    tag: '1561bb', connected: 3, gpus: 2, cover: full, posBytes, joined: true, canLend: true, host: 'my-laptop', gpu, L,
    tools, requests: { replies: 0, out: 0 }, width, now, modelBytes: 6.8 * GB,
    everyone: [{ me: true, lending: true }, { lending: true }, { lending: false }],
    peers: [{ id: 3, me: true, lo: 8, hi: 24 }, { id: 51, name: 'vast-3090', lo: 0, hi: N }] };
const lending = { ...base, phase: 'lending', stats: { bytes: 6.3 * GB, limit: 9 * GB, held: [0, N], ran: 3412, rate: 41, since: now - 9 * 60000 },
    event: { at: now - 60000, text: 'reached the 9 GB limit · → to lend more' } };
const busy = { ...lending, cover: backed, folded: true, requests: { replies: 12, out: 4100, rate: 31 } };

const states = {
    'first start: asking': { ...base, phase: 'asking', status: { kind: 'waiting' }, cover: holey, gpus: 1,
        peers: [{ id: 51, name: 'vast-3090', lo: 0, hi: 26 }], everyone: [{ me: true }, { lending: true }],
        asking: { gb: 10, share: 100, last: '9 GB', terms: 'clusterchat.io/terms' } },
    'starting: downloading': { ...base, phase: 'starting', status: { kind: 'waiting' }, cover: holey, loading,
        stats: { bytes: 1.2 * GB, limit: 9 * GB, held: [26, 30] }, progress: { text: 'block 27: 41/109 MiB', fraction: 0.34 },
        peers: [{ id: 3, me: true, lo: 26, hi: 38, have: 30 }, { id: 51, name: 'vast-3090', lo: 0, hi: 26 }] },
    'lending, no agent yet': lending,
    'lending, agents busy, backed up': busy,
    'agents only (no GPU), public demo': { ...base, phase: 'none', gpu: null, room: 'public demo', gpuError: 'no GPU that WebGPU can use',
        peers: [{ id: 51, name: 'vast-3090', lo: 0, hi: N }, { id: 52, lo: 0, hi: 20 }] },
    'not lending': { ...base, phase: 'off' },
    'failed': { ...base, phase: 'failed', note: 'WebGPU device lost: the GPU was reset' },
    'pressing s with no backup': { ...lending, confirm: '▲ stopping takes the model offline for 2 others · press s again' },
    'lend only (--no-bridge)': { ...lending, url: null },
};

const logo = (s) => ['', `   ██ ██ ██   ClusterChat v0.2.0-beta.4`, `   ██ ██ ██   your own AI, on your own computers`, `   ██ ██ ██   ${statusLine(s)}`, ''];
const log = ['23:51:04  claude-code  8.1k in (7.9k cached) → 340 out  2.1 s', '23:50:58  claude-code  0.9k in → 112 out  0.8 s'];
function screen(s) {
    const lines = [...logo(s)];
    for (const part of [panel(s), connectSection(s)]) {
        if (part.length) lines.push(...part.map((l) => typeof l === 'string' ? `   ${l}` : { ...l, text: `   ${l.text}` }), '');
    }
    lines.push(...requestsHeader(s).map((l) => `   ${l}`));
    if (s.requests?.replies) lines.push(...log.map((l) => `   ${' '.repeat(11)}${l}`));
    const keys = s.phase === 'asking' ? [['enter', 'lend & accept terms'], ['←/→', 'amount'], ['n', 'not now'], ['q', 'leave']]
        : /lending|starting/.test(s.phase) ? [['←/→', 'amount'], ['s', 'stop lending'], ['c', 'copy the Claude Code command'], ['q', 'leave']]
        : [['l', 'lend'], ['c', 'copy the Claude Code command'], ['q', 'leave']];
    lines.push('', `   ${footer(keys, s.confirm)}`);
    return lines;
}

if (process.argv.includes('--light')) {
    const t0 = Date.now();
    let drawn = 0;
    const tick = setInterval(() => {
        const lines = machineSection({ ...lending, litAt: t0, now: Date.now() }).map((l) => `   ${l}`);
        process.stdout.write((drawn ? `\x1b[${drawn}F\x1b[J` : '') + lines.map((l) => `${l}\n`).join(''));
        drawn = lines.length;
        if (Date.now() - t0 > LIGHT_MS + 400) clearInterval(tick);
    }, 40);
} else {
    let over = 0;
    for (const [name, s] of Object.entries(states)) {
        console.log(`\n\x1b[2m━━ ${name} ━━\x1b[0m`);
        for (const l of screen(s)) {
            const text = typeof l === 'string' ? l : l.text;
            if (typeof l === 'string' && visible(text) >= width) over++;
            console.log(text);
        }
    }
    if (over) console.log(`\n${over} line(s) reach the last column (commands that wrap are not counted)`);
}
