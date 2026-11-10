// End to end on a real GPU: `clusterchat connect --lend` as the only GPU in
// a local cluster with the tiny test model. A browser tab prompting through
// it must get the text it gets from a browser worker, token for token, and
// the same CLI's own bridge must answer from the GPU it is lending.
//
//   node tools/tinymodel.mjs && node tools/cli.lend.gpu.mjs

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness/cdp.mjs';
import { serve } from './harness/serve.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const L = JSON.parse(readFileSync(`${ROOT}/weights/tiny-test/manifest.json`)).n_layer;
const PROMPTS = ['Tell me about the sea.', 'And the sky?'];
const MAX = 24;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const sigPort = 18000 + Math.floor(Math.random() * 1000);
const sig = spawn('node', ['signal-server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(sigPort), WEIGHTS_URL: '/weights/tiny-test',
           N_LAYER: String(L), MIN_BLOCKS: '1' } });
await new Promise((res) => sig.stdout.on('data', (d) => /signaling on ws:/.test(d) && res()));
const http = await serve({ root: ROOT, signalPort: sigPort });
const server = `http://localhost:${http.port}`;
const browser = await launch();
let cli = null;
// Its own cache and config, so a run neither reads nor leaves the user's.
const home = mkdtempSync(join(tmpdir(), 'cc-lend-'));
const env = { ...process.env, XDG_CACHE_HOME: `${home}/cache`, XDG_CONFIG_HOME: `${home}/config` };

const open = async (q) => {
    const tab = await browser.tab(`${server}/web/dev/harness.html?${q}`);
    await tab.waitFor('window.harness');
    const info = await tab.eval('window.harness.boot()');
    if (info.error) throw new Error(info.note);
    return tab;
};
const run = (tab) => tab.eval(`window.harness.run(${JSON.stringify({ prompts: PROMPTS, fresh: false, opts: { maxTokens: MAX } })})`)
    .then((r) => r.map((x) => x.text.trimEnd()));
const covered = (tab) => tab.waitFor('window.harness.stats().coverage >= 1', { timeout: 60000 }).catch(() => {});

try {
    // The reference: a browser tab holding the whole model.
    const w = await open(`role=worker&at=0-${L + 2}&label=w`);
    const s1 = await open('role=spectator&label=s1');
    await covered(s1);
    const want = await run(s1);
    console.log(`browser worker: ${JSON.stringify(want)}`);
    await w.close();
    await s1.close();

    // The CLI takes its place, with its bridge on.
    const port = 19000 + Math.floor(Math.random() * 1000);
    const start = () => new Promise((res, rej) => {
        const t0 = Date.now();
        cli = spawn('node', ['cli/bin.js', 'connect', 'demo', '--server', server, '--port', String(port), '--lend', 'max'],
            { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
        let out = '';
        cli.stderr.on('data', (d) => { out += d; });
        cli.stdout.on('data', (d) => {
            out += d;
            if (/gpu\s+lending \d+(\.\d)? [GM]B/.test(out)) res({ out, seconds: (Date.now() - t0) / 1000 });
        });
        cli.once('exit', (code) => rej(new Error(`clusterchat exited with ${code}:\n${out}`)));
        setTimeout(() => rej(new Error(`not lending after 120 s:\n${out}`)), 120000);
    });
    const stop = () => new Promise((res) => { cli.once('exit', res); cli.kill('SIGINT'); });

    // First run: downloads. Second: the same weights, from the disk cache.
    const first = await start();
    ok('first run: downloaded, nothing from the cache', !/from the cache/.test(first.out), first.out);
    await stop();
    const { out, seconds } = await start();
    console.log(`cli lending after ${seconds.toFixed(1)} s`);
    console.log(out.split('\n').filter((l) => l.trim()).map((l) => `  | ${l.trim()}`).join('\n'));
    ok('it found the GPU', /✓ gpu/.test(out), out);
    ok('second run: all from the cache', /all from the cache/.test(out), out);

    const s2 = await open('role=spectator&label=s2');
    await covered(s2);
    const got = await run(s2);
    ok('a browser prompting through the CLI\'s GPU: the browser worker\'s reply', JSON.stringify(got) === JSON.stringify(want),
        JSON.stringify(got));
    await s2.close();

    const api = `http://127.0.0.1:${port}`;
    const r = await fetch(`${api}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({
        messages: [{ role: 'user', content: PROMPTS[0] }], temperature: 0, max_tokens: MAX }) }).then((x) => x.json());
    ok('its own bridge, answered by its own GPU', r.choices?.[0]?.message?.content === want[0],
        JSON.stringify(r.choices?.[0]?.message?.content ?? r));

    const st = await fetch(`${api}/clusterchat`).then((x) => x.json());
    ok('/clusterchat says it is lending', st.lending?.phase === 'lending' && st.lending.ran > 0, JSON.stringify(st.lending));
} finally {
    cli?.kill('SIGINT');
    await browser.close?.();
    http.close?.();
    sig.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 500);
