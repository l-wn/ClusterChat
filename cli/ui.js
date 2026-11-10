// connect's screen. While joining: the logo and the join steps, printed as
// they happen. Once joined, on a terminal: the dashboard, a full screen
// redrawn top to bottom (the logo with the status line, then screen.js's
// sections: cluster, this machine, connect, requests, then the request log's
// latest lines with the ones running, then the keys), on the terminal's
// second screen, so leaving brings back what was there and prints the log
// into it.
//
// Nothing may print to the terminal behind this file's back: capture()
// routes console output from the web/ code into the log. Without a terminal
// (piped, NO_COLOR, TERM=dumb) there is no colour, no dashboard and nothing
// pinned, just one plain line per event.

import { LABEL, visible, k } from './screen.js';

const out = process.stdout;
export const live = !!out.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
// Keys can be read and a question asked: a terminal on both ends.
export const interactive = live && !!process.stdin.isTTY;
const paint = (code) => (s) => live ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const c = {
    dim: paint('2'), bold: paint('1'), green: paint('32'), red: paint('31'), yellow: paint('33'),
    ink: paint('97'), violet: paint('38;2;164;107;255'), brand: paint('38;2;112;34;214'),
};
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const IN = '   ';
const n = (x) => Math.round(x).toLocaleString('en-US');
const clock = () => new Date().toTimeString().slice(0, 8);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

// `s` cut to the terminal's width, so a pinned line never wraps and the
// redraw always knows how many lines it drew. Escapes take no width.
function fit(s) {
    const w = (out.columns || 120) - 1;
    let shown = 0, o = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\x1b') { const j = s.indexOf('m', i); o += s.slice(i, j + 1); i = j; continue; }
        if (shown === w - 1 && s.slice(i).replace(/\x1b\[[0-9;]*m/g, '').length > 1) return `${o}…\x1b[0m`;
        o += s[i];
        shown++;
    }
    return o;
}

// --- The pinned lines and the log above them ---

const pinned = new Set();       // objects with line(frame) → string
let footer = null;
let drawn = 0, frame = 0, ticker = null;

function redraw() {
    if (!live) return;
    if (dash) return drawDashboard();
    const lines = [...pinned].map((p) => p.line(SPIN[frame % SPIN.length]));
    if (footer) lines.push('', ...footer());
    out.write((drawn ? `\x1b[${drawn}F\x1b[J` : '') + lines.map((l) => fit(l) + '\n').join(''));
    drawn = lines.length;
}

// A line in the log, above the pinned ones.
function print(line = '') {
    if (dash) {
        log.push(line);
        if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
        return redraw();
    }
    if (live && drawn) { out.write(`\x1b[${drawn}F\x1b[J`); drawn = 0; }
    out.write(line + '\n');
    redraw();
}

export function pin(p) {
    pinned.add(p);
    if (live && !ticker) ticker = setInterval(() => { frame++; redraw(); }, 90).unref();
    redraw();
    return () => {
        pinned.delete(p);
        if (!pinned.size && ticker) { clearInterval(ticker); ticker = null; }
        redraw();
    };
}

// --- The dashboard ---

let dash = null;                // { head, sections, keys, empty, lit }: functions, read on every redraw
let brand = null;               // { version, tagline }, for the logo
const log = [];                 // what print() wrote since, newest last
const LOG_MAX = 2000;

// The logo, with the status line beside its last row. Its purple column is
// the lending light: bright while this machine lends.
function logoLines(status, lit) {
    const sq = lit ? c.violet('██') : c.brand('██');
    const bars = `${c.ink('██')} ${c.ink('██')} ${sq}`;
    return ['', `${IN}${bars}   ${c.bold('ClusterChat')} ${c.dim(`v${brand.version}`)}`,
            `${IN}${bars}   ${c.dim(brand.tagline)}`, `${IN}${bars}   ${status}`, ''];
}

// Every line of the screen, from the top. The log gets whatever height is
// left, its newest lines and then the requests running, indented to the
// label column, so the keys stay on the last line. A line is cut to the
// width, except a { wrap } line (a command to copy), which wraps and is
// counted as the rows it takes.
function drawDashboard() {
    const rows = out.rows || 40, cols = out.columns || 100;
    const spin = SPIN[frame % SPIN.length];
    const head = [...logoLines(dash.head?.() ?? '', !!dash.lit?.()),
        ...[].concat(dash.sections?.() ?? []).map((l) => typeof l === 'string' ? `${IN}${l}` : { ...l, text: `${IN}${l.text}` })];
    const tall = (l) => typeof l === 'string' ? 1 : Math.max(1, Math.ceil(visible(l.text) / cols));
    const keys = dash.keys?.() ?? '';
    const foot = keys ? ['', `${IN}${keys}`] : [];      // the caller styles the keys
    const indent = `${IN}${' '.repeat(LABEL)}`;
    const running = [...pinned].map((p) => `${indent}${p.line(spin).replace(/^ {3}/, '')}`);
    const used = head.reduce((n, l) => n + tall(l), 0);
    const room = Math.max(0, rows - used - foot.length);
    const body = [...log.map((l) => `${indent}${l.replace(/^ {3}/, '')}`), ...running].slice(-room);
    if (!body.length && dash.empty && room) body.push(`${indent}${c.dim(dash.empty)}`);
    while (body.length < room) body.push('');
    const lines = [...head, ...body, ...foot];
    let text = '', shown = 0;
    for (const l of lines) {
        if (shown >= rows) break;
        text += (shown ? '\n' : '') + (typeof l === 'string' ? `${fit(l)}\x1b[K` : `${l.text}\x1b[K`);
        shown += tall(l);
    }
    out.write(`\x1b[H${text}\x1b[J`);
}

// From here on, the dashboard. Off a terminal it does nothing, and the
// caller prints as before.
export function dashboard(spec) {
    if (!live) return false;
    dash = spec;
    drawn = 0;
    out.write('\x1b[?1049h\x1b[H\x1b[J');          // the second screen
    process.on('exit', () => { if (dash) out.write('\x1b[?1049l'); });
    out.on('resize', redraw);
    // Its own clock: the spinner's stops when the last pinned line goes.
    setInterval(() => { frame++; redraw(); }, 250).unref();
    redraw();
    return true;
}

// --- What connect shows ---

export function banner(version, tagline) {
    if (live) {
        out.write('\x1b[?25l');                     // no cursor blinking in the pinned lines
        process.on('exit', () => out.write('\x1b[?25h'));
    }
    brand = { version, tagline };
    for (const l of logoLines('', false)) print(l);
}

// A step that is running: a spinner until done(), warn() or fail() prints
// its outcome.
export function step(label) {
    const unpin = pin({ line: (s) => `${IN}${c.violet(s)} ${label} …` });
    const end = (mark) => (name, detail) => { unpin(); line(mark, name, detail); };
    return { done: end('✓'), warn: end('!'), fail: end('✗') };
}

// A finished step's line: `mark` is ✓, ! or ✗.
export function line(mark, name, detail = '') {
    const paint = { '✓': c.green, '!': c.yellow, '✗': c.red }[mark] ?? ((x) => x);
    print(`${IN}${paint(mark)} ${pad(name, 9)} ${detail}`);
}

export function section(title, body) {
    print();
    print(`${IN}${c.bold(title)}`);
    for (const l of body.split('\n')) print(`${IN}${c.violet('│')} ${l}`);
}

const rule_ = (title) => `${IN}${c.dim(`── ${title} ${'─'.repeat(Math.max(4, Math.min(out.columns || 80, 100) - title.length - 8))}`)}`;
export function rule(title) {
    print();
    print(rule_(title));
}

export const note = (text) => print(`${IN}${c.dim(`${clock()}  ${text}`)}`);
// A line from this machine's GPU, beside the agents' requests in the log.
export const gpu = (text, { error = false } = {}) =>
    print(`${IN}${c.dim(clock())}  ${c.brand(pad('gpu', 11))} ${error ? c.red(text) : text}`);
export const error = (text) => print(`${IN}${c.red('✗')} ${text}`);
export const plain = (text) => print(text);

// The status bar: `fn` returns its text, or one line per role, read on
// every redraw.
export function status(fn) {
    footer = () => [].concat(fn()).map((l) => `${IN}${l}`);
    // Its own clock too, for the same reason.
    if (live) setInterval(() => { frame++; redraw(); }, 1000).unref();
    redraw();
}
// Redraw quickly for `ms`, for an animation in the status lines (the GPU
// box lighting up).
let fastUntil = 0, fast = null;
export function wake(ms) {
    fastUntil = Math.max(fastUntil, Date.now() + ms);
    if (!live || fast) return;
    fast = setInterval(() => {
        redraw();
        if (Date.now() > fastUntil) { clearInterval(fast); fast = null; redraw(); }
    }, 40);
    fast.unref();
}
export const paints = c;
export const num = n;

// One request's line: waiting, reading its prompt, writing, then its
// outcome in the log. Returns the tap http.js feeds.
export function request({ agent }, totals) {
    const t0 = Date.now(), at = clock();
    let state = 'waiting for a turn', fresh = 0, cached = 0, written = 0, tFirst = null, ended = null, failed = null;
    const who = `${c.dim(at)}  ${c.violet(pad(agent, 11))}`;
    const inOut = (u) => `${k(u.input - u.cached)} in${u.cached ? c.dim(` (${k(u.cached)} cached)`) : ''} → ${k(u.output)} out`;
    const rate = () => tFirst && written > 1 ? written / ((Date.now() - tFirst) / 1000) : 0;
    const unpin = pin({ line: (s) => `${IN}${who} ${c.violet(s)} ${state === 'writing'
        ? `writing ${c.dim('·')} ${n(written)} tokens${rate() ? ` ${c.dim('·')} ${rate().toFixed(1)} tok/s` : ''}`
        : state}` });
    return {
        event(ev) {
            if (ev.type === 'start') {
                fresh = ev.tokens; cached = ev.cached;
                state = `reading ${n(fresh)} tokens${cached ? ` ${c.dim(`· ${n(cached)} cached`)}` : ''}`;
            } else if (ev.type === 'text') {
                if (!tFirst) { tFirst = Date.now(); state = 'writing'; }
                written++;
            } else if (ev.type === 'end') ended = ev;
        },
        fail(err) { failed = err; },
        close() {
            unpin();
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            if (failed) return print(`${IN}${who} ${c.red('✗')} ${c.red(reason(failed))}`);
            if (!ended) return print(`${IN}${who} ${c.yellow('■')} ${c.yellow(`stopped by the client after ${n(written)} tokens`)}`);
            const u = ended.usage;
            totals.replies++;
            totals.out += u.output;
            const tps = rate();
            const why = ended.stop === 'tool' ? c.violet('  → tool') : ended.stop === 'length' ? c.yellow('  cut at the limit') : '';
            // `cached` is this chat's own context; `shared` is tokens of this
            // prompt the mesh did not compute because another chat already
            // had — whether the peers held the prefix and it was never sent,
            // or it was sent and a peer answered it from a chat running right
            // now (route.js's lastShared). Two agent sessions in different
            // directories can never share a chat (the system prompt carries
            // the cwd) and still share almost all of their prompt, so the two
            // are worth telling apart.
            const shared = u.shared ? c.dim(` · ${k(u.shared)} shared`) : '';
            totals.seconds = (totals.seconds ?? 0) + (Date.now() - (tFirst ?? t0)) / 1000;
            print(`${IN}${who} ${c.green('✓')} ${inOut(u)}${shared}  ${c.dim(`${secs} s${tps ? ` · ${tps.toFixed(0)} tok/s` : ''}`)}${why}`);
        },
    };
}

function reason(err) {
    if (err.kind === 'context') return `too long: ${n(err.tokens)} tokens, the cluster holds ${n(err.max)}`;
    if (err.kind === 'busy') return 'the cluster is busy';
    return err.message;
}

// Send console output from the web/ code to the log.
// The GPU self-check is left out when it passes: a failure is shown, and
// is the reason lending stopped.
const QUIET = /^\s*PASS\s|^WebGPU adapter:|^kernel tests: (\d+)\/\1 passed|^link to peer \d+:/;
export function capture() {
    const say = (...a) => {
        const text = a.map((x) => typeof x === 'string' ? x : x?.message ?? String(x)).join(' ');
        if (!QUIET.test(text)) note(text);
    };
    console.log = console.info = console.warn = say;
    console.error = (...a) => say(...a);
}

// Single keys while connected: `map` is { key: fn }, with 'ctrl+c' for
// that. Only on a terminal; elsewhere nothing is read.
export function keys(map) {
    if (!live || !process.stdin.isTTY) return false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
        const name = k === '\x03' ? 'ctrl+c' : k === '\r' ? 'enter' : k === '\x1b[C' ? 'right'
            : k === '\x1b[D' ? 'left' : k.toLowerCase();
        map[name]?.();
    });
    process.on('exit', () => { try { process.stdin.setRawMode(false); } catch { /* gone */ } });
    return true;
}

export function leave(text) {
    footer = null;
    for (const p of [...pinned]) pinned.delete(p);
    if (dash) {
        // Back to the first screen, with the session's log printed into its
        // scrollback, so what happened is still there to read.
        dash = null;
        out.write('\x1b[?1049l');
        if (log.length) {
            print(rule_('requests'));
            for (const l of log) print(l);
        }
    }
    print();
    print(`${IN}${c.dim(text)}`);
}
