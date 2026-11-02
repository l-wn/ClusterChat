// End to end on a real GPU: a local signal server with the tiny test model,
// a browser tab holding the whole model, and `clusterchat connect` in front.
// Both protocols must answer with the text a browser tab gets for the same
// greedy prompt, and a request that continues a chat must feed only its new
// turn and still match the browser's second turn.
//
//   node tools/tinymodel.mjs && node tools/cli.gpu.mjs

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

try {
    const open = async (q) => {
        const tab = await browser.tab(`${server}/web/dev/harness.html?${q}`);
        await tab.waitFor('window.harness');
        const info = await tab.eval('window.harness.boot()');
        if (info.error) throw new Error(info.note);
        return tab;
    };
    await open(`role=worker&at=0-${L + 2}&label=w`);
    const spec = await open('role=spectator&label=s');
    await spec.waitFor('window.harness.stats().coverage >= 1', { timeout: 60000 }).catch(() => {});
    const ref = await spec.eval(`window.harness.run(${JSON.stringify({ prompts: PROMPTS, fresh: false, opts: { maxTokens: MAX } })})`);
    const want = ref.map((r) => r.text.trimEnd());
    console.log(`browser: ${JSON.stringify(want)}`);

    const port = 19000 + Math.floor(Math.random() * 1000);
    cli = spawn('node', ['cli/bin.js', 'connect', 'demo', '--server', server, '--port', String(port)],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    await new Promise((res, rej) => {
        cli.stdout.on('data', (d) => { out += d; if (/serving\s+http/.test(out)) res(); });
        cli.once('exit', (code) => rej(new Error(`clusterchat exited with ${code}:\n${out}`)));
    });
    console.log(out.split('\n').filter((l) => /joined|serving/.test(l)).join('\n'));
    const api = `http://127.0.0.1:${port}`;
    const post = (path, body) => fetch(api + path, { method: 'POST', body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: path.includes('stream') ? null : await r.text() }));

    const user = { role: 'user', content: PROMPTS[0] };
    const a = await post('/v1/chat/completions', { messages: [user], temperature: 0, max_tokens: MAX });
    const aj = JSON.parse(a.body);
    const got = aj.choices?.[0]?.message?.content;
    ok('openai: the browser\'s reply', got === want[0], `${a.status} ${JSON.stringify(got ?? aj)}`);

    const res = await fetch(`${api}/v1/messages`, { method: 'POST', body: JSON.stringify({
        model: 'claude-x', stream: true, temperature: 0, max_tokens: MAX, messages: [user] }) });
    const text = (await res.text()).split('\n').filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6))).filter((e) => e.delta?.type === 'text_delta')
        .map((e) => e.delta.text).join('');
    ok('anthropic stream: the same reply', text === want[0], JSON.stringify(text));

    const b = await post('/v1/chat/completions', { temperature: 0, max_tokens: MAX, messages: [user,
        { role: 'assistant', content: got }, { role: 'user', content: PROMPTS[1] }] });
    const bj = JSON.parse(b.body);
    const u = bj.usage ?? {};
    ok('a continuation: the browser\'s second turn', bj.choices?.[0]?.message?.content === want[1],
        JSON.stringify(bj.choices?.[0]?.message?.content ?? bj));
    ok('and it fed only the new turn', u.prompt_tokens_details?.cached_tokens > 0
        && u.prompt_tokens - u.prompt_tokens_details.cached_tokens < 60, JSON.stringify(u));
} finally {
    cli?.kill('SIGINT');
    await browser.close?.();
    http.close?.();
    sig.kill('SIGKILL');
}
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 500);
