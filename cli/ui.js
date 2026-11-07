// connect's screen: the logo, the join steps, each tool's setup, and a log of
// requests with the ones running and a status bar pinned under it.
//
// The pinned lines are redrawn in place, so nothing may print to the
// terminal behind this file's back: capture() routes console output from the
// web/ code into the log. Without a terminal (piped, NO_COLOR, TERM=dumb)
// there is no colour and nothing pinned, just one plain line per event.

const out = process.stdout;
const live = !!out.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
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
    const lines = [...pinned].map((p) => p.line(SPIN[frame % SPIN.length]));
    if (footer) lines.push('', footer());
    out.write((drawn ? `\x1b[${drawn}F\x1b[J` : '') + lines.map((l) => fit(l) + '\n').join(''));
    drawn = lines.length;
}

// A line in the log, above the pinned ones.
function print(line = '') {
    if (live && drawn) { out.write(`\x1b[${drawn}F\x1b[J`); drawn = 0; }
    out.write(line + '\n');
    redraw();
}

function pin(p) {
    pinned.add(p);
    if (live && !ticker) ticker = setInterval(() => { frame++; redraw(); }, 90).unref();
    redraw();
    return () => {
        pinned.delete(p);
        if (!pinned.size && ticker) { clearInterval(ticker); ticker = null; }
        redraw();
    };
}

// --- What connect shows ---

export function banner(version, tagline) {
    if (live) {
        out.write('\x1b[?25l');                     // no cursor blinking in the pinned lines
        process.on('exit', () => out.write('\x1b[?25h'));
    }
    const bars = `${c.ink('██')} ${c.ink('██')} ${c.brand('██')}`;
    print();
    print(`${IN}${bars}   ${c.bold('ClusterChat')} ${c.dim(`v${version}`)}`);
    print(`${IN}${bars}   ${c.dim(tagline)}`);
    print(`${IN}${bars}`);
    print();
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

export function rule(title) {
    print();
    print(`${IN}${c.dim(`── ${title} ${'─'.repeat(Math.max(4, Math.min(out.columns || 80, 100) - title.length - 8))}`)}`);
}

export const note = (text) => print(`${IN}${c.dim(`${clock()}  ${text}`)}`);
export const error = (text) => print(`${IN}${c.red('✗')} ${text}`);
export const plain = (text) => print(text);

// The status bar: `fn` returns its text, read on every redraw.
export function status(fn) {
    footer = () => `${IN}${fn()}`;
    if (live && !ticker) ticker = setInterval(() => { frame++; redraw(); }, 1000).unref();
    redraw();
}
export const paints = c;
export const num = n;

// One request's line: waiting, reading its prompt, writing, then its
// outcome in the log. Returns the tap http.js feeds.
export function request({ agent }, totals) {
    const t0 = Date.now(), at = clock();
    let state = 'waiting for a turn', fresh = 0, cached = 0, written = 0, tFirst = null, ended = null, failed = null;
    const who = `${c.dim(at)}  ${c.violet(pad(agent, 11))}`;
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
            const why = ended.stop === 'tool' ? c.violet(' → tool') : ended.stop === 'length' ? c.yellow(' (cut at the token limit)') : '';
            // `cached` is this chat's own context; `shared` is tokens of this
            // prompt the mesh did not compute because another chat already
            // had — whether the peers held the prefix and it was never sent,
            // or it was sent and a peer answered it from a chat running right
            // now (route.js's lastShared). Two agent sessions in different
            // directories can never share a chat (the system prompt carries
            // the cwd) and still share almost all of their prompt, so the two
            // are worth telling apart.
            const shared = u.shared ? c.dim(` · ${n(u.shared)} shared`) : '';
            print(`${IN}${who} ${c.green('✓')} ${n(u.input - u.cached)} in `
                + `${c.dim(`· ${n(u.cached)} cached`)}${shared}${c.dim(' ·')} `
                + `${n(u.output)} out ${c.dim(`· ${secs} s${tps ? ` · ${tps.toFixed(1)} tok/s` : ''}`)}${why}`);
        },
    };
}

function reason(err) {
    if (err.kind === 'context') return `too long: ${n(err.tokens)} tokens, the cluster holds ${n(err.max)}`;
    if (err.kind === 'busy') return 'the cluster is busy';
    return err.message;
}

// Send console output from the web/ code to the log.
export function capture() {
    const say = (...a) => note(a.map((x) => typeof x === 'string' ? x : x?.message ?? String(x)).join(' '));
    console.log = console.info = console.warn = say;
    console.error = (...a) => say(...a);
}

export function leave(text) {
    footer = null;
    for (const p of [...pinned]) pinned.delete(p);
    print();
    print(`${IN}${c.dim(text)}`);
}
