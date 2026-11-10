// What the dashboard shows, section by section, in the order a person asks:
// is it running (the logo's third line), what is the cluster doing, what is
// this machine doing, how do I connect, what is happening now.
//
//   ██ ██ ██   ● ready · Qwen3.5-4B · http://127.0.0.1:4747
//
//   cluster    private · id 1561bb · 3 connected · 2 GPUs lending · model loaded
//              ▲ no backup: if a GPU leaves, the model stops
//
//   my-laptop  ● lending · holds the whole model · since 23:42
//              memory  ████████████████████░░░░░░░░  6.3 / 9.0 GB
//              served  3,412 tokens to the cluster · 41 tok/s
//
// Every section shares one label column (LABEL wide), lowercase, plain text:
// whitespace does the grouping a box would. Nothing depends on colour alone:
// bars fill with █ and empty with ░, and states are words and marks.
//
// Pure: each function takes the state and returns lines, so
// tools/screen.preview.mjs can show every state without a cluster. A line
// is a string, or { text, wrap: true } for a command that may wrap rather
// than be cut, so it can be copied whole.

const GB = 2 ** 30;
const colour = !process.env.NO_COLOR;
const esc = (code) => (s) => colour ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const rgb = (r, g, b) => esc(`38;2;${r};${g};${b}`);
export const P = {
    signal: rgb(112, 34, 214),
    glow: rgb(164, 107, 255),       // lending: the light
    flash: esc('1;38;2;226;206;255'),
    dim: esc('2'), ink: esc('97'), bold: esc('1'),
    red: esc('31'), yellow: esc('33'), green: esc('32'),
};
export const LABEL = 11;            // "cluster    ", "requests   "
const SUB = 8;                      // "memory  "
export const LIGHT_MS = 900;

export const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const cut = (s, w) => s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`;
const hm = (t) => new Date(t).toTimeString().slice(0, 5);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const num = (n) => Math.round(n).toLocaleString('en-US');
// 4.1k from 4,100: the request line's counts.
export const k = (n) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
// GB from 1 GB up, else MB. Every figure is in units of 2^30, as the page's.
const amount = (b) => b >= 10 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(b / 2 ** 20))} MB`;

// `fill` (0–1) of `w` cells: █ filled, ░ empty, so it reads without colour.
export const bar = (w, fill, paint = P.ink) => {
    const n = Math.max(0, Math.min(w, Math.round(fill * w)));
    return paint('█'.repeat(n)) + P.dim('░'.repeat(w - n));
};

// Parts joined with " · ", carried onto a new line where the next would not
// fit in `w`, so a narrow terminal breaks a row between facts, not inside one.
export function flow(parts, w) {
    const out = [];
    let cur = '';
    for (const p of parts.filter(Boolean)) {
        const next = cur ? `${cur}${P.dim(' · ')}${p}` : p;
        if (cur && visible(next) > w) { out.push(cur); cur = p; } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
}

// The width of the model map, this machine's lane and the memory bar: one
// width, so the three line up column for column.
// The right-hand text after a bar is at most RIGHT wide ("6.3 GB used · 9 GB limit").
const RIGHT = 26;
export const barWidth = (width) => Math.max(10, Math.min(40, (width ?? 80) - 3 - LABEL - SUB - 3 - RIGHT));

// Cell `i` of `w` stands for position `p` of `N`.
const posAt = (i, w, N) => Math.min(N - 1, Math.floor((i + 0.5) * N / w));

// The model, one cell per stretch of it, as the chat page draws it:
// █ two or more copies, ▓ one, ░ being downloaded, · nobody (yellow: what
// the cluster needs). This machine's own cells are in its colour.
export function modelMap(w, { depths, loading = [], mine = null }) {
    const N = depths.length;
    if (!N) return P.dim('·'.repeat(w));
    let out = '';
    for (let i = 0; i < w; i++) {
        const p = posAt(i, w, N), d = depths[p];
        const here = mine && p >= mine[0] && p < mine[1];
        const ch = d >= 2 ? '█' : d === 1 ? '▓' : loading[p] ? '░' : '·';
        out += !d && !loading[p] ? P.yellow(ch) : here ? P.glow(ch) : P.ink(ch);
    }
    return out;
}

// One GPU's lane, under the model map: ━ under the pieces it holds, ╌ under
// those it has claimed and is still downloading, nothing elsewhere, so it
// reads against the map without colour.
export function lane(w, N, { lo, hi, have = hi }, paint = P.ink) {
    let out = '';
    for (let i = 0; i < w; i++) {
        const p = posAt(i, w, N);
        out += p >= lo && p < have ? paint('━') : p >= have && p < hi ? P.dim('╌') : ' ';
    }
    return out;
}

// A meter in the lanes' style, so the screen has two kinds of bar: the model
// map, and lines. ━ is the part used, ─ the rest, so it reads without colour.
export const meter = (w, fill, paint = P.ink) => {
    const n = Math.max(0, Math.min(w, Math.round(fill * w)));
    return paint('━'.repeat(n)) + P.dim('─'.repeat(w - n));
};

// The lanes, as the chat page lists them: you first, then by where each
// range starts. The right-hand column is the share of the model it holds,
// or how far its download has got.
const LANES_MAX = 6;
function lanes(s, w) {
    const N = s.cover?.depths?.length ?? 0;
    if (!N || !s.peers?.length) return [];
    const list = [...s.peers].sort((a, b) => (a.me ? -1 : b.me ? 1 : 0) || a.lo - b.lo || a.id - b.id);
    const lines = list.slice(0, LANES_MAX).map((p) => {
        const have = Math.min(p.have ?? p.hi, p.hi);
        const name = p.me ? 'you' : cut(p.name ?? `GPU ${p.id}`, SUB - 1);
        const right = have < p.hi ? P.dim(`↓ ${Math.round(((have - p.lo) / (p.hi - p.lo)) * 100)}%`)
            : P.dim(`${Math.round(((have - p.lo) / N) * 100)}%`);
        const paint = p.me ? P.glow : P.ink;
        return `${(p.me ? P.glow : P.dim)(name.padEnd(SUB))}${P.dim('▕')}${lane(w, N, { ...p, have }, paint)}${P.dim('▏')} ${right}`;
    });
    if (list.length > LANES_MAX) lines.push(sub('', P.dim(`+ ${list.length - LANES_MAX} more GPUs`)));
    return lines;
}

// A dot per person connected, so it says who lends: ● lending (yours in
// purple), ○ only chatting.
const DOTS_MAX = 40;
function people(s) {
    const all = s.everyone ?? [];
    if (!all.length) return [];
    const sorted = [...all].sort((a, b) => (b.me - a.me) || (b.lending - a.lending));
    const dots = sorted.slice(0, DOTS_MAX).map((p) => p.me ? P.glow(p.lending ? '●' : '○') : p.lending ? P.ink('●') : P.dim('○'));
    const more = all.length > DOTS_MAX ? P.dim(` +${all.length - DOTS_MAX}`) : '';
    return [sub('people', `${dots.join(' ')}${more}`)];
}

// `label` in the label column, `lines` beside it, the rest indented to it.
//
// `level` is how much the section matters right now, so weight does what a
// box would: 'now' (the label bold), 'normal', or 'quiet' (everything
// dimmed, except warnings and your colour, which keep theirs).
export function section(label, lines, level = 'normal') {
    const grey = (t) => colour ? `\x1b[90m${t}\x1b[0m` : t;
    const head = level === 'now' ? P.bold(label.padEnd(LABEL)) : level === 'quiet' ? grey(label.padEnd(LABEL)) : label.padEnd(LABEL);
    const quiet = (t) => !colour ? t : `\x1b[90m${t.replace(/\x1b\[(1|97)m/g, '\x1b[90m').replace(/\x1b\[0m/g, '\x1b[0m\x1b[90m')}\x1b[0m`;
    return lines.map((l, i) => {
        const lead = i ? ' '.repeat(LABEL) : head;
        const body = (t) => level === 'quiet' ? quiet(t) : t;
        return typeof l === 'string' ? lead + body(l) : { ...l, text: lead + body(l.text) };
    });
}

// The section labels are bold and their content plain. While the lend
// question is up, everything outside its box is grey, so the box is what
// is read.
export function focus(s) {
    const level = s?.phase === 'asking' ? 'quiet' : 'now';
    return { cluster: level, gpu: level, connect: level, requests: level };
}
const sub = (name, text) => `${P.dim(name.padEnd(SUB))}${text}`;

// [lo, have) of an L-block model in words.
export function heldText(lo, have, L) {
    const N = L + 2;
    if (!(have > lo)) return 'holds nothing yet';
    if (lo === 0 && have === N) return 'holds the whole model';
    const a = Math.max(lo, 1) - 1, b = Math.min(have, N - 1) - 2;
    const parts = [lo === 0 && 'the embedding', b >= a && `blocks ${a === b ? a : `${a}–${b}`} of ${L}`, have === N && 'the head'];
    return `holds ${parts.filter(Boolean).join(' + ')}`;
}

// --- Is it running ---

// The model's pieces: covered, being downloaded, and the bytes still needed
// (an estimate from the checkpoint's sizes, so shown with "~").
export function pieces(s) {
    const cover = s.cover ?? { depths: [], covered: 0, total: 0, r: 0 };
    let need = 0, claimed = 0;
    for (let x = 0; x < cover.depths.length; x++) {
        if (cover.depths[x]) continue;
        need += s.posBytes?.[x] ?? 0;
        if (s.loading?.[x]) claimed++;
    }
    const whole = cover.total > 0 && cover.covered === cover.total;
    return { cover, need, claimed, whole, pct: cover.total ? cover.covered / cover.total : 0 };
}

// One state, said once: waiting (someone has to lend), loading (someone
// is, and it is downloading), linking, ready.
export function statusLine(s) {
    const { claimed, pct } = pieces(s);
    const st = s.status ?? { kind: 'joining' };
    const head = {
        ready: P.green('● ready'),
        joining: P.dim('○ joining…'),
        linking: P.yellow('◐ linking to the GPUs…'),
        reconnecting: P.yellow('○ reconnecting…'),
        waiting: claimed ? P.yellow(`◐ loading · ${Math.round(pct * 100)}%`)
            : P.yellow('○ waiting for GPUs'),        // how much: the cluster row says
    }[st.kind];
    return [head, s.model && P.ink(s.model), s.url && P.bold(s.url)].filter(Boolean).join(P.dim(' · '));
}

// --- The question, when there is one ---

// The lend question, as the GPU part of the panel: why it matters first,
// then the amount, then what enter does (it is the agreement).
function askLines(s) {
    const a = s.asking;
    const needAll = s.modelBytes ?? null;
    const why = needAll && a.gb * GB >= needAll ? 'It can run the whole model by itself.'
        : a.share != null ? `It would hold about ${a.share}% of the model.` : '';
    const free = s.gpu?.mem ? `of ${amount(s.gpu.mem.total - s.gpu.mem.used)} free` : '';
    return [
        `${P.bold(`Lend your ${s.gpu.name}?`)} ${why}`,
        `${P.glow('◂')}  ${P.bold(`${a.gb} GB`)}  ${P.glow('▸')}   ${P.dim(free)}${needAll ? P.dim(`   the whole model is ~${amount(needAll)}`) : ''}`,
        `${P.bold('enter')} ${P.dim('lend & accept terms')}   ${P.bold('←/→')} ${P.dim('amount')}   ${P.bold('n')} ${P.dim('not now')}`,
        P.dim(`18+ only · ${a.terms ?? 'see the terms'}${a.last ? ` · last time: ${a.last}` : ''}`),
    ];
}

// The lend question in a box of its own, above the cluster: the one thing
// on the screen waiting on the person, and the cluster may be waiting on it.
export function promptBox(s) {
    const a = s.asking;
    if (!a) return [];
    const W = Math.max(50, Math.min(74, (s.width ?? 80) - 6));
    const inner = W - 4;
    const row = (t = '') => `${P.glow('│')} ${clip(t, inner)}${' '.repeat(Math.max(0, inner - visible(clip(t, inner))))} ${P.glow('│')}`;
    const [ask, amountLine, keys, terms] = askLines(s);
    return [
        P.glow(`┌${'─'.repeat(W - 2)}┐`),
        row(ask), row(), row(`     ${amountLine}`), row(), row(keys), row(terms),
        P.glow(`└${'─'.repeat(W - 2)}┘`),
    ];
}

// `s` cut to `w` visible columns, escapes kept.
function clip(str, w) {
    if (visible(str) <= w) return str;
    let out = '', shown = 0;
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '\x1b') { const j = str.indexOf('m', i); out += str.slice(i, j + 1); i = j; continue; }
        if (shown === w - 1) return `${out}\x1b[0m…`;
        out += str[i];
        shown++;
    }
    return out;
}

// The status part of the screen: the lend question in its box while it is
// up, then the cluster and your GPU, grouped by whitespace, not a border.
export function panel(s) {
    if (s.phase === 'asking') return [...promptBox(s), '', ...clusterSection(s)];
    return [...clusterSection(s), '', ...machineSection(s)];
}

// --- What is the cluster doing ---

export function clusterSection(s) {
    const { cover, need, claimed, whole, pct } = pieces(s);
    const where = s.room === 'public demo' ? 'public demo' : `private · id ${s.tag ?? '—'}`;
    const facts = [where, plural(s.connected ?? 0, 'person', 'people'),
        s.gpus ? `${plural(s.gpus, 'GPU')} lending` : 'no GPUs lending yet'];
    const lines = [];
    const room = (s.width ?? 80) - 3 - LABEL - 1;     // the last column stays free
    const w = barWidth(s.width);
    const map = (tail) => sub('model', `${P.dim('▕')}${modelMap(w, { depths: cover.depths, loading: s.loading })}${P.dim('▏')} ${tail}`);
    if (!s.joined) {
        lines.push(P.dim([where, 'joining…'].join(' · ')));
        return section('cluster', lines, focus(s).cluster);
    }
    lines.push(...flow(facts, room));
    if (whole) lines.push(map(cover.r >= 2 ? P.dim('backed up') : P.yellow('▲ no backup')));
    else if (claimed) lines.push(map(P.yellow(`${Math.round(pct * 100)}% loaded`)));
    else lines.push(map(P.yellow(need ? `needs ~${amount(need)} more` : 'needs GPUs')));
    lines.push(...lanes(s, w), ...people(s));
    return section('cluster', lines, focus(s).cluster);
}

// --- What is this machine doing ---

// s.phase: 'none' | 'off' | 'asking' | 'starting' | 'lending' | 'failed'.
export function machineSection(s) {
    if (s.phase === 'asking') return [];         // promptBox() asks instead
    const now = s.now ?? Date.now();
    const lit = s.phase === 'lending' || s.phase === 'starting';
    const t = s.litAt != null ? (now - s.litAt) / LIGHT_MS : 1;
    const flashing = s.phase === 'lending' && t < 1 && Math.floor(t * 6) % 2 === 0;
    const light = flashing ? P.flash : P.glow;
    const st = s.stats ?? {};
    const width = s.width ?? 80;
    const lines = [];
    const free = s.gpu?.mem ? s.gpu.mem.total - s.gpu.mem.used : null;

    if (s.phase === 'none') {
        lines.push(P.dim(`chat only${s.gpuError ? ` · ${s.gpuError}` : ''}`));
    } else if (s.phase === 'off') {
        const offer = free != null ? ` · ${amount(free)} free` : '';
        lines.push(`not lending ${P.dim(`· ${s.gpu.name}${offer} ·`)} press ${P.bold('l')} to lend`);
    } else if (s.phase === 'failed') {
        lines.push(`${P.red('✗ stopped lending')} ${P.dim('·')} ${P.red(cut(s.note ?? 'see the log', width - LABEL - 24))}`);
        lines.push(P.dim(`press ${P.bold('l')} to try again`));
    } else {
        const f = s.progress?.fraction;
        const downloading = s.phase === 'starting' || (s.progress?.text && !(f >= 1) && !/^done$/.test(s.progress.text));
        lines.push(s.phase === 'starting'
            ? `${light('◐ starting')} ${P.dim('·')} ${s.gpu.name}${downloading && f != null ? P.dim(` · downloading ${Math.round(f * 100)}%`) : ''}`
            : `${light('● lending')} ${P.dim('·')} ${s.gpu.name}${st.since ? P.dim(` · since ${hm(st.since)}`) : ''}`);
        // Memory this GPU has in use, against the limit you set (or the GPU).
        const of = st.limit != null && st.limit !== Infinity ? st.limit : s.gpu?.mem?.total ?? null;
        const used = `${st.bytes >= GB / 10 ? `${(st.bytes / GB).toFixed(1)} GB` : amount(st.bytes ?? 0)} used`;
        const cap = st.limit === Infinity ? P.dim(' · no limit') : of != null ? P.dim(` · ${Math.round(of / GB)} GB limit`) : '';
        lines.push(sub('memory', `${P.dim('▕')}${meter(barWidth(width), of ? st.bytes / of : 0, light)}${P.dim('▏')} ${used}${cap}`));
        if (downloading && s.progress?.text) lines.push(sub('loading', P.dim(cut(s.progress.text, width - LABEL - SUB - 4))));
        if (s.phase === 'lending') {
            lines.push(sub('served', `${plural(st.ran ?? 0, 'token')} to the cluster${st.rate >= 0.5 ? P.dim(` · ${st.rate.toFixed(0)} tok/s`) : ''}`));
        }
    }
    // The last thing that happened to the GPU: errors stay, the rest for ten minutes.
    if (s.event && s.phase !== 'off' && s.phase !== 'none' && (s.event.error || now - s.event.at < 10 * 60000)) {
        const text = cut(s.event.text, width - LABEL - SUB - 10);
        lines.push(sub('note', `${P.dim(hm(s.event.at))}  ${s.event.error ? P.red(text) : text}`));
    }
    return section('your GPU', lines, focus(s).gpu);
}

// --- How do I connect ---

// s.tools: [{ label, cmd }].
export function connectSection(s) {
    if (!s.url) return [];
    const w = Math.max(...s.tools.map((t) => t.label.length), 'other'.length) + 2;
    return section('connect', focus(s).connect === 'quiet' ? [
        ...s.tools.map((t) => ({ text: `${P.dim(t.label.padEnd(w))}${t.cmd}`, wrap: true })),
        `${P.dim('other'.padEnd(w))}the address above ${P.dim('(Anthropic- or OpenAI-compatible)')}`,
    ] : [
        ...s.tools.map((t) => ({ text: `${P.dim(t.label.padEnd(w))}${P.bold(t.cmd)}`, wrap: true })),
        `${P.dim('other'.padEnd(w))}the address above ${P.dim('(Anthropic- or OpenAI-compatible)')}`,
    ], focus(s).connect);
}

// --- What is happening now ---

// The heading of the request log: what your agents have had from the cluster.
export function requestsHeader(s) {
    const r = s.requests ?? { replies: 0, out: 0, rate: 0 };
    return section('requests', [r.replies
        ? `${plural(r.replies, 'reply', 'replies')} ${P.dim('·')} ${k(r.out)} tokens to your agents${r.rate ? P.dim(` · ${r.rate.toFixed(0)} tok/s avg`) : ''}`
        : P.dim(s.url ? 'waiting for the first one…' : 'none: this machine only lends (--no-bridge)')], focus(s).requests);
}

// --- The keys ---

// [[key, what], …] as a list of controls: the keys bold, the words dim, wide
// gaps, so it does not read as more content. `message` replaces it for a
// moment: a key waiting to be pressed again, or what a key just did.
export function footer(keys, message = null) {
    if (message) return message;
    return keys.map(([key, what]) => `${P.bold(key)} ${P.dim(what)}`).join('    ');
}
