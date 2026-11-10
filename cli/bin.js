#!/usr/bin/env node
// clusterchat: put this computer into a ClusterChat cluster. While connected
// it can lend its GPU (hold part of the model and run other people's chats),
// serve the cluster to coding agents on localhost (the bridge), or both.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ui from './ui.js';
import { parseTarget, join, downloads } from './join.js';
import { cacheSize, clearCache, DIR as CACHE_DIR } from './cache.js';
import { makeCluster } from './core.js';
import { listen } from './http.js';
import { protocols, harnesses } from './plugins.js';
import { claudeEnv } from './harnesses/claude-code.js';
import { mergeConfig, providerSnippet } from './harnesses/opencode.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync as readText, writeFileSync as writeText } from 'node:fs';
import { probeGpu } from './gpu.js';
import { readGpus, pickGpu, suggestBytes, gb, size } from './vram.js';
import { makeLender } from './lend.js';
import { statusLine, panel, connectSection, requestsHeader, footer, LIGHT_MS } from './screen.js';
import { savedChoice, saveChoice } from './config.js';
import { positionBytes, coverage, holding } from '../web/split.js';

/* global __VERSION__ */
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__
    : JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PORT = 4747, HOST = '127.0.0.1';
const GB = 2 ** 30;

// The page's defaults (web/chat.html), without the repetition penalties,
// which fight code that repeats on purpose. A request's temperature wins.
const SAMPLING = { temp: 0.7, topK: 40, rep: 1, freq: 0, pres: 0, ngram: 0, prof: 0, spec: true };

const HELP = `clusterchat ${VERSION}: join a ClusterChat cluster from your terminal.
Lend your GPU, use the cluster from your coding agent, or both.

  clusterchat connect '<invite link>'    join a private cluster (quote the link)
  clusterchat connect demo               join the public demo (strangers' GPUs see your prompts)
  clusterchat gpu                        what this machine could lend, without joining
  clusterchat claude [args]              start Claude Code on the cluster a running connect serves
  clusterchat setup opencode --write     add the cluster to ./opencode.json, keeping the rest
  clusterchat setup <tool>               print the setup for a tool (${harnesses.map((h) => h.name).join(', ')})
  clusterchat status                     what a running connect is doing
  clusterchat cache [clear]              the downloaded model files kept on disk

connect options
  --lend [GB|max]  lend this GPU: the suggested amount, that many GB, or as much as fits
  --no-lend        don't lend, and don't ask
  --no-bridge      don't serve your coding agents (a machine that only lends)
  --direct         GPU-to-GPU links skip the relay (other GPUs then see your address)
  --port <n>       the bridge's local port (${PORT})
  --host <addr>    the bridge's local address (${HOST})
  --server <url>   for demo: whose demo (default $CLUSTERCHAT_SERVER, else https://clusterchat.io)

while connected: l lend · s stop lending · ←/→ amount · c copy the Claude Code command · q leave
`;

// With CLUSTERCHAT_DUMP_PROMPTS set to a directory, write what every request
// decided to feed into it, one file per request. Two agents' dumps are what
// tools/prefix-overlap.mjs measures the shared prefix of, which is the number
// that says whether sharing KV pages between chats is worth building
// (PLAN-prefix-sharing.md). Off unless the variable is set, and a write that
// fails is reported once and then ignored: this must never cost a request.
function promptDump() {
    const dir = process.env.CLUSTERCHAT_DUMP_PROMPTS;
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    let n = 0, warned = false;
    return ({ prompt, fresh, cached, reused }) => {
        const name = `${process.pid}-${String(++n).padStart(4, '0')}.txt`;
        try {
            writeFileSync(joinPath(dir, name), prompt);
            writeFileSync(joinPath(dir, `${name}.json`),
                JSON.stringify({ fresh, cached, reused }) + '\n');
        } catch (err) {
            if (!warned) { warned = true; ui.line('!', 'dump', `${dir}: ${err.message}`); }
        }
    };
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') args.help = true;
        else if (a === '-v' || a === '--version') args.version = true;
        else if (/^--(port|host|server)$/.test(a)) {
            if (argv[i + 1] == null) throw new Error(`${a} needs a value`);
            args[a.slice(2)] = argv[++i];
        } else if (a === '--lend') {
            // The amount is optional, so only a number or "max" is taken as it.
            const v = argv[i + 1];
            if (v != null && /^(\d+(\.\d+)?|max)$/i.test(v)) { args.lend = v.toLowerCase(); i++; }
            else args.lend = 'suggested';
        } else if (a === '--no-lend') args.noLend = true;
        else if (a === '--no-bridge') args.bridge = false;
        else if (a === '--direct') args.direct = true;
        else if (a === '--write') args.write = true;
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else args._.push(a);
    }
    if (args.port != null && !(Number(args.port) > 0 && Number(args.port) < 65536)) {
        throw new Error(`--port "${args.port}" is not a port`);
    }
    if (args.noLend && args.lend) throw new Error('--lend and --no-lend say opposite things. Pick one.');
    if (args.noLend && args.bridge === false) throw new Error('with --no-lend and --no-bridge there is nothing left to do');
    if (args.lend && args.lend !== 'max' && args.lend !== 'suggested' && !(Number(args.lend) >= 1)) {
        throw new Error(`--lend ${args.lend}: lend at least 1 GB`);
    }
    return args;
}

// This machine's GPU: the adapter the engine would use, its memory, and what
// to suggest lending. { error } when there is none to lend.
async function findGpu() {
    let probe;
    try { probe = await probeGpu(); } catch (err) { return { error: err.message }; }
    if (!probe) return { error: 'no GPU that WebGPU can use was found' };
    const mem = pickGpu(await readGpus(), probe.label);
    const name = (mem?.name ?? probe.label.split(' · ').find((p) => /[a-z]-|\s/i.test(p)) ?? probe.label)
        .replace(/^NVIDIA (GeForce )?/, '');
    return { ...probe, mem, name, suggest: suggestBytes(mem) };
}

function describeGpu(g) {
    if (!g.mem) return `${g.name} ${ui.paints.dim('· memory unknown: lends until the GPU is full')}`;
    const free = g.mem.total - g.mem.used;
    return `${g.name} ${ui.paints.dim(`· ${gb(g.mem.total)}, ${gb(free)} free${g.mem.shared ? ' (shared with system memory)' : ''}`)}`;
}

// `--lend`'s value (or a saved amount) in bytes. Infinity is no limit.
function limitFrom(choice, g) {
    if (choice === 'max') return Infinity;
    if (choice === 'suggested' || choice == null) return g?.suggest ? g.suggest : Infinity;
    return Number(choice) * GB;
}
const limitText = (bytes) => bytes === Infinity ? 'as much as fits' : `${Math.round(bytes / GB)} GB`;

// `clusterchat gpu`: what this machine could lend, without joining anything.
async function gpuCommand() {
    const g = await findGpu();
    const { paints: c } = ui;
    if (g.error) {
        console.log(`  ${c.yellow('!')} ${g.error}. This machine can still use a cluster from your coding agent.`);
        return;
    }
    console.log(`  ${c.green('✓')} gpu      ${describeGpu(g)}`);
    console.log(`             ${c.dim(g.label)}${g.f16 ? '' : c.dim(' · no shader-f16')}`);
    if (g.suggest) console.log(`  ${c.green('✓')} suggest  lend ${Math.round(g.suggest / GB)} GB `
        + c.dim(`(the free memory, less ${gb(Math.max(2 * GB, g.mem.total * 0.1))} for your desktop and other programs)`));
    else if (g.mem) console.log(`  ${c.yellow('!')} suggest  too little free memory to lend. Close something that uses the GPU, or pass --lend <GB>.`);
    console.log(`\n  clusterchat connect '<invite link>' --lend${g.suggest ? '' : ' <GB>'}`);
}

async function connect(args) {
    const target = parseTarget(args._[1], { server: args.server ?? null });
    const port = Number(args.port ?? PORT), host = args.host ?? HOST;
    const bridge = args.bridge !== false;
    const { paints: c, num } = ui;

    // Whether to lend: the flag; else, on a terminal, ask on every start,
    // with last time's amount filled in; else what this cluster was told
    // last time. A machine that does not bridge is here to lend.
    const saved = savedChoice(target);
    let want = args.noLend ? 'no' : args.lend ? 'yes' : ui.interactive ? 'ask'
        : !bridge ? 'yes' : saved?.lend ? 'yes' : 'no';
    let limit = null;    // bytes, once known

    // Before the screen is drawn: Dawn writes two warnings to stderr when the
    // first adapter is requested, which would break the pinned lines.
    const g = args.noLend ? null : await findGpu();
    const canLend = !!g && !g.error;
    limit = limitFrom(args.lend ?? saved?.gb ?? 'suggested', g);

    ui.banner(VERSION, 'your own AI, on your own computers');
    ui.capture();
    connecting = true;
    if (target.demo) ui.plain(`${'   '}${c.yellow('!')} the public demo runs on strangers' GPUs, and they see your prompts\n`);
    if (canLend) ui.line('✓', 'gpu', describeGpu(g));
    else if (g && want === 'yes') ui.line('!', 'gpu', `${g.error}: can't lend${bridge ? ', so this machine only chats' : ''}`);
    if (!canLend && !bridge) throw Object.assign(new Error('nothing to do without a GPU to lend. Drop --no-bridge.'), { shown: false });
    if (canLend && g.suggest === 0 && want === 'yes' && !args.lend) {
        ui.line('!', 'gpu', 'too little free memory to lend. Pass --lend <GB> to lend anyway.');
        want = 'no';
    }

    // The session: one engine in the cluster, which the bridge and the lender
    // share. Stopping lending or lending less rejoins, so the bridge reaches
    // it through `session` and never holds an engine of its own.
    const where = new URL(target.server).host;
    const totals = { replies: 0, out: 0 };
    let session = null, lender = null, posBytes = null;
    const onEvent = (type, d) => lender?.event(type, d);
    // On a live screen everyone gets the cluster box, and GPU events go in
    // it, so the log is the agents'; without one they are log lines.
    const boxed = ui.live;
    let lastEvent = null;
    const gpuLog = (text, { error = false } = {}) => {
        if (boxed) lastEvent = { at: Date.now(), text: text.replace(/\x1b\[[0-9;]*m/g, ''), error };
        else ui.gpu(text, { error });
    };

    // A rejoin on the dashboard (stopping, lending less) says nothing in the
    // request log, which is the agents': the GPU section shows it.
    const silent = { done() {}, warn() {}, fail() {} };
    async function open(first) {
        const step = (label) => (!first && ui.live ? silent : ui.step(label));
        let s = step(`joining ${where}`), joined = null;
        const gpuText = () => `${joined.gpus} GPU${joined.gpus === 1 ? '' : 's'} serving`;
        const j = await join(target, { client: `clusterchat/${VERSION}`, gpu: canLend ? g.gpu : null,
            relayOnly: !args.direct, onEvent, on: (what, d) => {
                if (what === 'joined') {
                    joined = d;
                    s.done('joined', `${where} ${c.dim('·')} ${d.room}`);
                    if (first) ui.line('✓', 'model', `${d.model} ${c.dim(`· ${num(d.ctx)}-token context`)}`);
                } else if (what === 'no-gpus') {
                    if (first && (!canLend || want === 'no')) ui.line('!', 'gpus', d.demo ? 'none serving the demo right now. Requests are refused until one is.'
                        : 'none serving this cluster. If you expected some, put the link in quotes: unquoted, '
                          + 'the shell cuts it at "&" and opens a different, empty cluster.');
                } else if (what === 'linking') s = step(`linking to ${gpuText().replace(' serving', '')}`);
                else if (what === 'linked') s.done('linked', `${gpuText()} ${c.dim(`· ${d.seconds.toFixed(1)} s`)}`);
                else if (what === 'unlinked') s.warn('linked', 'no link to the GPUs yet. Requests are refused until there is one.');
            } }).catch((err) => { s.fail('joined', err.message); throw Object.assign(err, { shown: true }); });
        session = { ...j, cluster: makeCluster({ engine: j.engine, template: j.template, info: j.info,
                                                  sampling: SAMPLING, onPrepare: promptDump() }) };
        lender = makeLender(j.engine, { log: gpuLog, downloads, onLit: () => ui.wake(LIGHT_MS + 200) });
        const net = j.engine.net;
        posBytes = positionBytes(j.engine.manifest, { nMax: j.engine.ctxMax, sessions: net.sessions, snaps: net.snaps });
    }
    await open(true);
    const modelBytes = () => posBytes?.reduce((a, b) => a + b, 0) ?? null;
    const shareText = (bytes) => {
        const m = modelBytes();
        return m && bytes !== Infinity ? c.dim(` · ${Math.min(100, Math.round(bytes / m * 100))}% of the model`) : '';
    };

    // The bridge: what the HTTP server calls. Reads the session every time.
    let server = null, url = null;
    const front = {
        get info() { return session.info; },
        get lending() { return lender.state.phase === 'off' ? null : lender.stats; },
        chat: (req) => session.cluster.chat(req),
    };
    const cmd = typeof __VERSION__ === 'undefined'
        ? `node ${relative(process.cwd(), fileURLToPath(import.meta.url)) || 'bin.js'}`
        : process.env.npm_command === 'exec' ? 'npx clusterchat@latest' : 'clusterchat';
    // `clusterchat <sub>` as this person would type it, with --port if not the default.
    const run = (sub) => `${cmd} ${sub}${port !== PORT ? ` --port ${port}` : ''}`;
    const toolCmd = (h) => h.brief?.({ url, info: session.info, run }) ?? h.setup(url, session.info);
    const showSetup = () => { for (const h of harnesses) ui.section(h.label, toolCmd(h)); };
    if (bridge) {
        server = await listen(front, { port, host, onChat: (r) => ui.request(r, totals) }).catch((err) => {
            session.engine.drop();
            throw err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use. Pick another with --port.`) : err;
        });
        url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    }

    // --- Lending ---

    let busy = false;      // a rejoin is running: keys wait
    let asking = null;     // the question's state while it is up
    const remember = (lend) => saveChoice(target, { lend, gb: limit === Infinity ? 'max' : Math.round(limit / GB) });

    const startLending = async () => {
        gpuLog(`lending ${limitText(limit)}${limit === Infinity ? '' : ' at most'}`
            + `${target.demo ? c.dim(' · you run strangers\' chats; the relay hides your address') : ''}`);
        await lender.start(limit);
    };
    // Lend less than is held, stop, or start over after a failure: the
    // engine cannot give memory back, so leave and join again.
    const rejoin = async (thenLend) => {
        busy = true;
        try {
            lender.stop();
            session.engine.drop();
            await open(false);
            if (thenLend) await startLending();
            else gpuLog('stopped lending. This machine only chats now.');
        } catch (err) {
            ui.error(`could not rejoin: ${err.message}`);
        } finally { busy = false; }
    };

    const ask = () => {
        const most = g.mem ? Math.max(1, Math.floor((g.mem.total - g.mem.used) / GB)) : 64;
        // Last time's amount if there was one, else the suggestion.
        const before = saved?.gb === 'max' ? most : Number(saved?.gb) || Math.round((g.suggest || 4 * GB) / GB);
        asking = { gb: Math.max(1, Math.min(most, before)), most,
                   last: saved ? (saved.lend ? (saved.gb === 'max' ? 'as much as fits' : `${saved.gb} GB`) : 'not lending') : null };
        asking.terms = `${new URL(target.server).host}/terms`;
        if (!boxed) {
            ui.plain(`${'   '}${c.dim(`By lending you confirm you are 18 or over and agree to the terms, code of conduct and privacy policy: ${target.server}/terms`)}`);
            asking.unpin = ui.pin({ line: () => `${'   '}${c.violet('?')} lend your ${g.name} to this cluster?  `
                + `${c.bold(`${asking.gb} GB`)}${shareText(asking.gb * GB)}   ${c.dim('←/→ amount · enter lend · n no')}` });
        }
    };
    const answer = (yes) => {
        asking.unpin?.();
        limit = asking.gb * GB;
        asking = null;
        remember(yes);
        if (yes) startLending();
        else gpuLog(`not lending. Press l to lend later${c.dim(' · remembered for this cluster')}`);
    };

    if (canLend && want === 'yes') {
        if (saved && !args.lend && bridge) gpuLog(`lending as you chose last time ${c.dim('· l to stop')}`);
        startLending();
    } else if (canLend && want === 'ask') ask();

    // --- The screen ---

    const modelShare = (bytes) => {
        const m = modelBytes();
        return m ? Math.min(100, Math.round(bytes / m * 100)) : null;
    };
    // A key waiting to be pressed again ({ key, until, text }), or a note
    // for a moment ({ until, text }): either replaces the keys line.
    let confirm = null, flash = null;

    // Everything the screen shows, read fresh on every redraw (screen.js).
    const state = () => {
        const st = lender.stats, net = session.engine.net, cov = net.coverage;
        const holders = net.peers.filter(holding);
        const whole = cov.total > 0 && cov.covered === cov.total;
        const kind = !net.online ? 'reconnecting' : !net.positions ? 'joining' : !whole ? 'waiting'
            : bridge && !session.info.ready ? 'linking' : 'ready';
        return {
            status: { kind }, model: session.info.model.split('/').pop(), url,
            room: session.info.room, tag: session.info.room.replace(/^private cluster /, ''),
            connected: net.peers.length, gpus: holders.length, cover: cov, posBytes, modelBytes: modelBytes(),
            peers: holders.map((p) => ({ id: p.id, name: p.name, lo: p.lo, hi: p.hi, have: p.have, me: p.id === net.id })),
            everyone: net.peers.map((p) => ({ me: p.id === net.id, lending: holding(p) })),
            loading: net.positions ? coverage(holders, net.positions).depths : [],
            joined: !!net.positions, canLend,
            phase: !canLend ? 'none' : asking ? 'asking' : st.phase,
            gpu: canLend ? g : null, gpuError: g?.error ?? null, L: session.engine.dims?.n_layer ?? null,
            stats: st, event: lastEvent, note: lender.state.note, litAt: lender.state.litAt,
            progress: lender.state.progress && { text: lender.state.progress, fraction: lender.state.fraction },
            asking: asking && { gb: asking.gb, share: modelShare(asking.gb * GB), terms: asking.terms, last: asking.last },
            tools: harnesses.map((h) => ({ label: h.label, cmd: toolCmd(h) })),
            requests: { replies: totals.replies, out: totals.out, rate: totals.seconds ? totals.out / totals.seconds : 0 },
            width: process.stdout.columns || 100,
        };
    };

    // The keys that do something now, and only those.
    const keysNow = () => {
        if (!ui.interactive) return [['ctrl+c', 'leave']];
        const phase = lender.state.phase;
        const copy = bridge && ['c', 'copy the Claude Code command'];
        if (asking) return [['enter', 'lend & accept terms'], ['←/→', 'amount'], ['n', 'not now'], ['q', 'leave']];
        if (!canLend) return [copy, ['q', 'leave']].filter(Boolean);
        if (phase === 'lending' || phase === 'starting') return [['←/→', 'amount'], ['s', 'stop lending'], copy, ['q', 'leave']].filter(Boolean);
        return [['l', phase === 'failed' ? 'try again' : 'lend'], copy, ['q', 'leave']].filter(Boolean);
    };
    const keysLine = () => {
        const now = Date.now();
        if (confirm && now > confirm.until) confirm = null;
        if (flash && now > flash.until) flash = null;
        return footer(keysNow(), confirm?.text ?? flash?.text ?? null);
    };

    // A terminal gets the dashboard; anything else the plain lines.
    const dashboard = ui.dashboard({
        head: () => statusLine(state()),
        sections: () => {
            const s = state();
            return [panel(s), connectSection(s)]
                .filter((x) => x.length).flatMap((x) => [...x, '']).concat(requestsHeader(s));
        },
        lit: () => /^(lending|starting)$/.test(lender.state.phase),
        keys: keysLine,
    });
    if (!dashboard) {
        if (bridge) {
            ui.line('✓', 'serving', `${c.bold(url)} ${c.dim('· Anthropic- and OpenAI-compatible API')}`);
            showSetup();
        }
        ui.rule(bridge ? 'requests' : 'your GPU');
        ui.status(() => [c.dim('ctrl+c to leave')]);
    }

    // --- Keys ---

    const leave = () => {
        const st = lender.stats;
        const lent = st.since ? `lent ${size(st.bytes)} for ${Math.round((Date.now() - st.since) / 60000)} min, `
            + `ran ${num(st.ran)} tokens` : null;
        const used = bridge ? `${num(totals.replies)} repl${totals.replies === 1 ? 'y' : 'ies'}, ${num(totals.out)} tokens out` : null;
        ui.leave(`left the cluster${[lent, used].filter(Boolean).length ? ': ' : ''}${[lent, used].filter(Boolean).join(' · ')}`);
        lender.stop();
        session.engine.drop();
        server?.close();
        setTimeout(() => process.exit(0), 300);
    };

    // How many other people lose the model if this GPU stops: it holds a
    // piece nobody else does, and someone else is connected.
    const offlineFor = () => {
        const st = lender.stats, net = session.engine.net;
        if (!st.held || !/^(lending|starting)$/.test(st.phase)) return 0;
        const d = net.coverage.depths;
        let sole = false;
        for (let p = st.held[0]; p < st.held[1]; p++) if (d[p] === 1) sole = true;
        return sole ? Math.max(0, net.peers.length - 1) : 0;
    };
    // Run `action` now, or, if it would take the model down for others,
    // only when `key` is pressed again within five seconds.
    const guarded = (key, label, what, action) => {
        const n = offlineFor();
        if (!n || (confirm?.key === key && Date.now() < confirm.until)) { confirm = null; return action(); }
        confirm = { key, until: Date.now() + 5000,
            text: `${c.yellow('▲')} ${what} takes the model offline for ${n} other${n === 1 ? '' : 's'} · press ${c.bold(label)} again` };
    };

    const stop = () => { remember(false); rejoin(false); };
    // The amount while lending. More applies at once (growth resumes). Less
    // than the GPU holds means reloading part of the model, so it asks first.
    const change = (by) => {
        if (busy || !canLend || !/^(lending|starting)$/.test(lender.state.phase)) return;
        const cur = limit === Infinity ? Math.ceil(session.engine.vramBytes / GB) : Math.round(limit / GB);
        const next = Math.max(1, cur + by);
        if (next === cur && limit !== Infinity) return;
        const apply = () => {
            limit = next * GB;
            remember(true);
            if (limit < session.engine.vramBytes) {
                gpuLog(`lending ${next} GB: less than this GPU holds, so reloading with less`);
                rejoin(true);
            } else {
                lender.setLimit(limit);
                gpuLog(`limit ${next} GB${shareText(limit)}`);
            }
        };
        if (next * GB >= session.engine.vramBytes || (confirm?.key === 'left' && Date.now() < confirm.until)) {
            confirm = null;
            return apply();
        }
        confirm = { key: 'left', until: Date.now() + 5000,
            text: `${c.yellow('▲')} ${next} GB is less than it holds, so part of the model reloads · press ${c.bold('←')} again` };
    };

    // The Claude Code command to the clipboard, through the terminal (OSC 52,
    // which most terminals and tmux with set-clipboard pass on, ssh included).
    const copy = () => {
        if (!bridge) return;
        const text = toolCmd(harnesses.find((h) => h.name === 'claude-code'));
        process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
        flash = { until: Date.now() + 3000, text: `${c.green('✓')} sent ${c.bold(text)} to your clipboard` };
    };

    ui.keys({
        'ctrl+c': leave,
        q: () => asking ? leave() : guarded('q', 'q', 'leaving', leave),
        n: () => asking && answer(false),
        enter: () => asking && answer(true),
        left: () => asking ? (asking.gb = Math.max(1, asking.gb - 1)) : change(-1),
        right: () => asking ? (asking.gb = Math.min(asking.most, asking.gb + 1)) : change(1),
        '-': () => !asking && change(-1), '+': () => !asking && change(1), '=': () => !asking && change(1),
        l: () => {
            if (busy || !canLend || asking) return;
            const phase = lender.state.phase;
            if (phase === 'off') { remember(true); if (session.engine.role === 'joining') startLending(); else rejoin(true); }
            else if (phase === 'failed') rejoin(true);
        },
        s: () => {
            if (busy || !canLend || asking || !/^(lending|starting)$/.test(lender.state.phase)) return;
            guarded('s', 's', 'stopping', stop);
        },
        c: () => !asking && copy(),
    });
    process.once('SIGINT', leave);
    process.once('SIGTERM', leave);
}

// The setup for one tool, with the model and context of the cluster that
// `connect` is serving on this port.
async function running(args) {
    const url = `http://${args.host ?? HOST}:${Number(args.port ?? PORT)}`;
    const info = await fetch(`${url}/clusterchat`).then((r) => r.json()).catch(() => {
        throw new Error(`no clusterchat connect is serving ${url}. Start one first, in another terminal: `
            + `npx clusterchat@latest connect '<invite link>'${args.port ? ` --port ${args.port}` : ''}`);
    });
    return { url, info };
}

async function setup(args) {
    const h = harnesses.find((x) => x.name === args._[1]);
    if (!h) throw new Error(`say which tool: ${harnesses.map((x) => x.name).join(', ')}`);
    const { url, info } = await running(args);
    if (!args.write) return console.log(h.setup(url, info));
    if (h.name !== 'opencode') throw new Error(`--write is for opencode. For ${h.label}, run: clusterchat claude`);
    // Merged into the file here, never over it: other providers and the
    // user's own default model stay.
    const file = 'opencode.json';
    const had = existsSync(file) ? readText(file, 'utf8') : null;
    const merged = mergeConfig(had, url, info);
    if (!merged) {
        console.log(`  ${file} has comments or is not plain JSON, so it was left alone. Add this under its "provider":\n`);
        return console.log(providerSnippet(url, info));
    }
    writeText(file, JSON.stringify(merged.json, null, 2) + '\n');
    const model = `clusterchat/${info.id}`;
    console.log(merged.created ? `  wrote ${file}: ${model} is opencode's default model here. Run opencode.`
        : merged.setModel ? `  added the cluster to ${file} and made ${model} the default model. Run opencode.`
        : `  added the cluster to ${file}. Your default model is unchanged: pick ${model} with /models in opencode.`);
}

// `clusterchat claude [args]`: Claude Code with every model it may pick set
// to the cluster's, through the connect running on --port. Its own
// arguments pass through as they are.
async function claude(args, rest) {
    const { url, info } = await running(args);
    const child = spawn('claude', rest, { stdio: 'inherit', shell: process.platform === 'win32',
        env: { ...process.env, ...claudeEnv(url, info) } });
    await new Promise((resolve, reject) => {
        child.once('error', (err) => reject(err.code === 'ENOENT'
            ? new Error('Claude Code is not installed. Install it with: npm install -g @anthropic-ai/claude-code') : err));
        child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
    });
}

// What the `connect` on this port is doing, from its /clusterchat.
async function status(args) {
    const url = `http://${args.host ?? HOST}:${Number(args.port ?? PORT)}`;
    const s = await fetch(`${url}/clusterchat`).then((r) => r.json()).catch(() => {
        throw new Error(`no clusterchat connect is running with a bridge on ${url}`);
    });
    console.log(`  cluster  ${s.room} · ${s.model} · ${s.gpus} GPU${s.gpus === 1 ? '' : 's'} · ${s.ready ? 'ready' : 'no link'}`);
    const l = s.lending;
    if (!l) console.log('  lending  no');
    else console.log(`  lending  ${l.phase} · ${(l.bytes / GB).toFixed(1)} GB of ${l.limit == null ? 'no limit' : `${Math.round(l.limit / GB)} GB`}`
        + `${l.range ? ` · ${l.range}` : ''} · ${l.ran.toLocaleString('en-US')} tokens run`);
    console.log(`  bridge   ${url}`);
}

// `clusterchat cache`: what is kept, and `cache clear` to drop it.
async function cache(args) {
    if (args._[1] === 'clear') {
        await clearCache();
        console.log(`  cleared ${CACHE_DIR}`);
    } else if (args._[1]) throw new Error(`unknown "cache ${args._[1]}". Run clusterchat cache, or clusterchat cache clear.`);
    else {
        const { bytes, files } = await cacheSize();
        console.log(`  ${size(bytes)} in ${files} file${files === 1 ? '' : 's'} at ${CACHE_DIR}`
            + (bytes ? '\n  clusterchat cache clear  deletes them; lending downloads them again' : ''));
    }
}

let connecting = false;    // the screen is up: errors go to it

try {
    // `claude` passes its arguments on to Claude Code, keeping only ours.
    const argv = process.argv.slice(2);
    let rest = [];
    if (argv[0] === 'claude') {
        const ours = ['claude'];
        for (let i = 1; i < argv.length; i++) {
            if (/^--(port|host)$/.test(argv[i])) ours.push(argv[i], argv[++i]);
            else rest.push(argv[i]);
        }
        argv.splice(0, argv.length, ...ours);
    }
    const args = parseArgs(argv);
    const command = args._[0];
    if (args.version) console.log(VERSION);
    else if (args.help || !command || command === 'help') console.log(HELP);
    else if (command === 'connect') await connect(args);
    else if (command === 'gpu') await gpuCommand();
    else if (command === 'setup') await setup(args);
    else if (command === 'claude') await claude(args, rest);
    else if (command === 'status') await status(args);
    else if (command === 'cache') await cache(args);
    else throw new Error(`unknown command "${command}". Run clusterchat --help.`);
} catch (err) {
    if (!connecting) console.error(`clusterchat: ${err.message}`);
    else if (!err.shown) ui.error(err.message);
    process.exit(1);
}
