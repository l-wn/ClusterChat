#!/usr/bin/env node
// clusterchat: use a ClusterChat cluster from coding agents.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ui from './ui.js';
import { parseTarget, join } from './join.js';
import { makeCluster } from './core.js';
import { listen } from './http.js';
import { protocols, harnesses } from './plugins.js';

/* global __VERSION__ */
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__
    : JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PORT = 4747, HOST = '127.0.0.1';

// The page's defaults (web/chat.html), without the repetition penalties,
// which fight code that repeats on purpose. A request's temperature wins.
const SAMPLING = { temp: 0.7, topK: 40, rep: 1, freq: 0, pres: 0, ngram: 0, prof: 0, spec: true };

const HELP = `clusterchat ${VERSION}: use a ClusterChat cluster from your coding agent

  clusterchat connect '<invite link>'    join a private cluster (quote the link)
  clusterchat connect demo               join the public demo (strangers' GPUs see your prompts)
  clusterchat setup <tool>               print the setup for a tool (${harnesses.map((h) => h.name).join(', ')})

options
  --port <n>       local port (${PORT})
  --host <addr>    local address (${HOST})
  --server <url>   for demo: whose demo (default $CLUSTERCHAT_SERVER, else https://clusterchat.io)
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
        } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else args._.push(a);
    }
    if (args.port != null && !(Number(args.port) > 0 && Number(args.port) < 65536)) {
        throw new Error(`--port "${args.port}" is not a port`);
    }
    return args;
}

async function connect(args) {
    const target = parseTarget(args._[1], { server: args.server ?? null });
    const port = Number(args.port ?? PORT), host = args.host ?? HOST;
    const { paints: c, num } = ui;
    ui.banner(VERSION, 'your own AI, on your own computers');
    ui.capture();
    connecting = true;
    if (target.demo) ui.plain(`${'   '}${c.yellow('!')} the public demo runs on strangers' GPUs, and they see your prompts\n`);

    const where = new URL(target.server).host;
    let s = ui.step(`joining ${where}`), joined = null;
    const gpuText = () => `${joined.gpus} GPU${joined.gpus === 1 ? '' : 's'} serving`;
    const { engine, template, info } = await join(target, { client: `clusterchat/${VERSION}`, on: (what, d) => {
        if (what === 'joined') {
            joined = d;
            s.done('joined', `${where} ${c.dim('·')} ${d.room}`);
            ui.line('✓', 'model', `${d.model} ${c.dim(`· ${num(d.ctx)}-token context`)}`);
        } else if (what === 'no-gpus') {
            ui.line('!', 'gpus', d.demo ? 'none serving the demo right now. Requests are refused until one is.'
                : 'none serving this cluster. If you expected some, put the link in quotes: unquoted, '
                  + 'the shell cuts it at "&" and opens a different, empty cluster.');
        } else if (what === 'linking') s = ui.step(`linking to ${gpuText().replace(' serving', '')}`);
        else if (what === 'linked') s.done('linked', `${gpuText()} ${c.dim(`· ${d.seconds.toFixed(1)} s`)}`);
        else if (what === 'unlinked') s.warn('linked', 'no link to the GPUs yet. Requests are refused until there is one.');
    } }).catch((err) => { s.fail('joined', err.message); throw Object.assign(err, { shown: true }); });

    const cluster = makeCluster({ engine, template, info, sampling: SAMPLING,
                                 onPrepare: promptDump() });
    const totals = { replies: 0, out: 0 };
    const server = await listen(cluster, { port, host, onChat: (r) => ui.request(r, totals) }).catch((err) => {
        engine.drop();
        throw err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use. Pick another with --port.`) : err;
    });
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    ui.line('✓', 'serving', `${c.bold(url)} ${c.dim(`· ${protocols.map((p) => p.name).join(' · ')}`)}`);

    const cmd = typeof __VERSION__ !== 'undefined' ? 'clusterchat'
        : `node ${relative(process.cwd(), fileURLToPath(import.meta.url)) || 'bin.js'}`;
    const setupCmd = (h) => `${cmd} setup ${h.name}${port !== PORT ? ` --port ${port}` : ''}`;
    for (const h of harnesses) ui.section(h.label, h.brief?.(url, info, setupCmd(h)) ?? h.setup(url, info));
    ui.rule('requests');
    ui.status(() => `${info.ready ? c.green('●') : c.yellow('○')} ${info.ready ? 'ready' : 'no link'}  `
        + `${c.dim('·')} ${gpuText()}  ${c.dim('·')} ${num(totals.replies)} repl${totals.replies === 1 ? 'y' : 'ies'}  `
        + `${c.dim('·')} ${num(totals.out)} tokens out     ${c.dim('ctrl+c to leave')}`);

    const leave = () => {
        ui.leave(`left the cluster after ${num(totals.replies)} repl${totals.replies === 1 ? 'y' : 'ies'}, `
            + `${num(totals.out)} tokens out`);
        engine.drop();
        server.close();
        setTimeout(() => process.exit(0), 300);
    };
    process.once('SIGINT', leave);
    process.once('SIGTERM', leave);
}

// The setup for one tool, with the model and context of the cluster that
// `connect` is serving on this port.
async function setup(args) {
    const h = harnesses.find((x) => x.name === args._[1]);
    if (!h) throw new Error(`say which tool: ${harnesses.map((x) => x.name).join(', ')}`);
    const url = `http://${args.host ?? HOST}:${Number(args.port ?? PORT)}`;
    const info = await fetch(`${url}/clusterchat`).then((r) => r.json()).catch(() => {
        throw new Error(`nothing is serving ${url}. Run clusterchat connect first.`);
    });
    console.log(h.setup(url, info));
}

let connecting = false;    // the screen is up: errors go to it

try {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    if (args.version) console.log(VERSION);
    else if (args.help || !command || command === 'help') console.log(HELP);
    else if (command === 'connect') await connect(args);
    else if (command === 'setup') await setup(args);
    else throw new Error(`unknown command "${command}". Run clusterchat --help.`);
} catch (err) {
    if (!connecting) console.error(`clusterchat: ${err.message}`);
    else if (!err.shown) ui.error(err.message);
    process.exit(1);
}
