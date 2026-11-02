// Tests the clusterchat client in cli/ without a mesh: the Qwen template
// against the checkpoint's own Jinja output, the reply parser, history reuse
// against a fake engine, and every protocol over HTTP against a fake cluster.
//
//   node tools/cli.test.mjs
//
// tools/fixtures/qwen-chat.json comes from tools/make_cli_fixture.py.

import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

import { readFileSync } from 'node:fs';
import * as qwen from '../cli/templates/qwen.js';
import * as chatml from '../cli/templates/chatml.js';
import { makeCluster, ApiError } from '../cli/core.js';
import { listen } from '../cli/http.js';
import { parseTarget } from '../cli/join.js';
import { harnesses } from '../cli/plugins.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rejects = async (name, p, check = () => true) => {
    try { await p; ok(name, false, 'did not throw'); } catch (err) { ok(name, check(err), err.message); }
};

const READ = { name: 'read', description: 'Read a file.',
    schema: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'integer' } } } };

console.log('\nthe qwen template renders what the jinja template renders');
for (const [i, c] of JSON.parse(readFileSync(new URL('./fixtures/qwen-chat.json', import.meta.url))).entries()) {
    eq(`case ${i}: ${c.msgs.map((m) => m.role).join(', ')}${c.tools.length ? ', tools' : ''}`,
        qwen.render(c.msgs, { tools: c.tools, system: c.system }), c.prompt);
}
{
    const next = qwen.render([{ role: 'tool', text: 'B' }, { role: 'user', text: 'and?' }], { first: false });
    eq('a continuation closes the open reply first', next,
        '<|im_end|>\n<|im_start|>user\n<tool_response>\nB\n</tool_response><|im_end|>\n'
        + '<|im_start|>user\nand?<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
    ok('chatml has no tool messages', (() => {
        try { chatml.render([{ role: 'tool', text: 'x' }]); return false; } catch { return true; }
    })());
}

console.log('\nreading a reply as it grows');
{
    const p = qwen.parser([READ]);
    const reply = 'Let me look.\n\n<tool_call>\n<function=read>\n<parameter=path>\na.js\n</parameter>\n'
        + '<parameter=lines>\n40\n</parameter>\n</function>\n</tool_call>';
    let shown = '';
    for (let n = 1; n <= reply.length; n++) shown += p.feed(reply.slice(0, n));
    eq('the text up to the call, without the space before it', shown, 'Let me look.');
    eq('typed arguments', p.end(), { text: '', calls: [{ name: 'read', args: { path: 'a.js', lines: 40 } }] });

    const q = qwen.parser([]);
    eq('a partial tag is held back', q.feed('Hi <tool'), 'Hi');
    eq('and shown once it is not one', q.feed('Hi <tools are fun'), ' <tools are fun');
    eq('a reply without calls', q.end(), { text: '', calls: [] });

    const r = qwen.parser([]);
    r.feed('one');
    eq('the end gives back held whitespace only if more followed', [r.feed('one  '), r.end().text], ['', '']);
    const split = qwen.parser([]);
    eq('a character split across tokens waits for its last byte', [split.feed('caf\uFFFD'), split.feed('café!')], ['caf', 'é!']);
    const objects = qwen.parser([]);
    objects.feed('<tool_call>\n<function=x>\n<parameter=o>\n{"a": [1]}\n</parameter>\n<parameter=s>\n'
        + 'two\nlines\n</parameter>\n</function>\n</tool_call>');
    eq('untyped JSON objects parse, strings stay', objects.end().calls[0].args, { o: { a: [1] }, s: 'two\nlines' });
}

// A fake engine: one token per character, replies from a script.
function fakeEngine(replies, { ctxMax = 100000, sessions = 2 } = {}) {
    let active = null;
    const fed = [], discarded = [];
    const engine = {
        net: { connected: true, peers: [{ lo: 0, hi: 4, ready: true }], sessions,
               seats: 0, seat: async () => { engine.net.seats++; return { ok: true }; }, unseat() { engine.net.seats--; } },
        ctxMax, lastStopReason: 'eos', lastPromptTokens: 0, lastFed: 0,
        get ctxLen() { return active?.len ?? 0; },
        newChat() { active = { len: 0 }; return active; },
        switchTo(c) { active = c; },
        discard(c) { discarded.push(c); },
        stop() { engine.lastStopReason = 'stopped'; },
        rewind(n) { active.len -= n; },
        async *generate(prompt) {
            fed.push(prompt);
            engine.lastPromptTokens = prompt.length;
            engine.lastFed = 0;
            engine.lastStopReason = 'eos';
            active.len += prompt.length;
            const reply = replies.shift() ?? '';
            for (let n = 3; n < reply.length + 3; n += 3) {
                active.len += 1;
                engine.lastFed++;
                yield { text: reply.slice(0, n), tokenId: 1 };
            }
        },
    };
    return { engine, fed, discarded };
}

const run = async (cluster, req) => {
    const out = [];
    for await (const ev of cluster.chat(req)) out.push(ev);
    return out;
};
const textOf = (evs) => evs.filter((e) => e.type === 'text').map((e) => e.text).join('');
const count = async (s) => [...s];

console.log('\nhistory reuse');
{
    const { engine, fed, discarded } = fakeEngine(['Hello there.',
        'Reading it.\n\n<tool_call>\n<function=read>\n<parameter=path>\na.js\n</parameter>\n</function>\n</tool_call>',
        'It is one line.', 'Other.', 'Third.']);
    const cluster = makeCluster({ engine, template: qwen, info: { model: 'm' }, count });
    const sys = 'You code.';
    const u1 = { role: 'user', text: 'hi' };

    const a = await run(cluster, { system: sys, tools: [READ], messages: [u1] });
    eq('events: start, text, end', a.map((e) => e.type), ['start', 'text', 'text', 'text', 'text', 'end']);
    eq('the reply', textOf(a), 'Hello there.');
    ok('the first request feeds the whole render', fed[0].startsWith('<|im_start|>system\n# Tools'));
    eq('nothing cached yet', a.at(-1).usage.cached, 0);

    const a1 = { role: 'assistant', text: 'Hello there.' };
    const b = await run(cluster, { system: sys, tools: [READ], messages: [u1, a1, { role: 'user', text: 'fix a.js' }] });
    eq('a request that continues it feeds only the new turn', fed[1],
        '<|im_end|>\n<|im_start|>user\nfix a.js<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
    ok('and reports the rest as cached', b.at(-1).usage.cached > fed[0].length);
    const call = b.find((e) => e.type === 'call');
    eq('a tool call', [call?.name, call?.args], ['read', { path: 'a.js' }]);
    eq('ends for the tool', b.at(-1).stop, 'tool');
    eq('the text before it', textOf(b), 'Reading it.');

    // The agent sends the call back with its own id, and the tool's result.
    const msgs = [u1, a1, { role: 'user', text: 'fix a.js' },
        { role: 'assistant', text: 'Reading it.', calls: [{ id: 'other-id', name: 'read', args: { path: 'a.js' } }] },
        { role: 'tool', text: 'x = 1', callId: 'other-id' }];
    await run(cluster, { system: sys, tools: [READ], messages: msgs });
    eq('a tool result continues the chat too', fed[2],
        '<|im_end|>\n<|im_start|>user\n<tool_response>\nx = 1\n</tool_response><|im_end|>\n'
        + '<|im_start|>assistant\n<think>\n\n</think>\n\n');

    await run(cluster, { system: 'Other.', tools: [], messages: [u1] });
    ok('another system prompt is another chat', fed[3].startsWith('<|im_start|>system\nOther.'));
    eq('nothing evicted at two chats', discarded.length, 0);
    await run(cluster, { system: 'Third.', tools: [], messages: [u1] });
    eq('a third chat evicts the oldest', discarded.length, 1);
    eq('every seat was given back', engine.net.seats, 0);
}
{
    const { engine } = fakeEngine(['x'], { ctxMax: 50 });
    const cluster = makeCluster({ engine, template: qwen, info: { model: 'm' }, count });
    await rejects('a prompt past the context fails before the start',
        run(cluster, { messages: [{ role: 'user', text: 'hi' }] }),
        (err) => err.kind === 'context' && err.max === 50 && err.tokens > 50);
    engine.net.connected = false;
    await rejects('an unconnected cluster is unready', run(cluster, { messages: [{ role: 'user', text: 'hi' }] }),
        (err) => err.kind === 'unready');
    await rejects('no user message is invalid', run(cluster, { messages: [] }), (err) => err.kind === 'invalid');
    const plain = makeCluster({ engine, template: chatml, info: { model: 'tiny' }, count });
    await rejects('tools on a format without them are invalid',
        run(plain, { tools: [READ], messages: [{ role: 'user', text: 'hi' }] }), (err) => err.kind === 'invalid');
}

console.log('\nprotocols over HTTP');
{
    let last = null, fault = null;
    const cluster = {
        info: { id: 'qwen3.5-4b', model: 'Qwen/Qwen3.5-4B', ctx: 16384, gpus: 2, ready: true },
        async *chat(req) {
            last = req;
            if (fault) throw fault;
            yield { type: 'start' };
            yield { type: 'text', text: 'Hi' };
            yield { type: 'text', text: ' there' };
            yield { type: 'call', id: 'call_1', name: 'read', args: { path: 'a.js' } };
            yield { type: 'end', stop: 'tool', usage: { input: 10, output: 5, cached: 4 } };
        },
        count: async () => 42,
    };
    const server = await listen(cluster, { port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(url + path, { method: 'POST', body: JSON.stringify(body) });
    const sse = async (res) => (await res.text()).split('\n\n').filter((b) => b.includes('data: '))
        .map((b) => b.split('\n').find((l) => l.startsWith('data: ')).slice(6))
        .map((d) => d === '[DONE]' ? d : JSON.parse(d));

    const oa = {
        model: 'anything', max_tokens: 100, temperature: 0.2,
        messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function',
                function: { name: 'read', arguments: '{"path":"b"}' } }] },
            { role: 'tool', tool_call_id: 'c', content: 'B' }],
        tools: [{ type: 'function', function: { name: 'read', description: 'Read.', parameters: READ.schema } }],
    };
    let res = await post('/v1/chat/completions', oa);
    let j = await res.json();
    eq('openai: the request in the core shape', [last.system, last.messages, last.tools[0].name, last.maxTokens, last.temperature],
        ['Be brief.', [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '', calls: [{ id: 'c', name: 'read', args: { path: 'b' } }] },
            { role: 'tool', text: 'B', callId: 'c' }], 'read', 100, 0.2]);
    eq('openai: a reply', [res.status, j.choices[0].message.content, j.choices[0].finish_reason,
        j.choices[0].message.tool_calls[0].function], [200, 'Hi there', 'tool_calls', { name: 'read', arguments: '{"path":"a.js"}' }]);
    eq('openai: usage', j.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } });

    res = await post('/v1/chat/completions', { ...oa, stream: true, stream_options: { include_usage: true } });
    const chunks = await sse(res);
    eq('openai stream: text', chunks.slice(0, -1).map((c) => c.choices?.[0]?.delta?.content ?? '').join(''), 'Hi there');
    ok('openai stream: a tool call, the finish, usage and [DONE]',
        chunks.some((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'read')
        && chunks.some((c) => c.choices?.[0]?.finish_reason === 'tool_calls')
        && chunks.at(-2).usage?.total_tokens === 15 && chunks.at(-1) === '[DONE]');
    eq('openai: models', (await (await fetch(`${url}/v1/models`)).json()).data[0].id, 'qwen3.5-4b');

    const an = {
        model: 'claude-sonnet-4', max_tokens: 200, system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' },
                { type: 'tool_use', id: 't', name: 'read', input: { path: 'b' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'B' }] },
                { type: 'text', text: 'and?' }] }],
        tools: [{ name: 'read', description: 'Read.', input_schema: READ.schema }],
    };
    res = await post('/v1/messages', an);
    j = await res.json();
    eq('anthropic: the request in the core shape', [last.system, last.messages],
        ['Be brief.', [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Looking.', calls: [{ id: 't', name: 'read', args: { path: 'b' } }] },
            { role: 'tool', callId: 't', text: 'B' }, { role: 'user', text: 'and?' }]]);
    eq('anthropic: a reply', [j.content, j.stop_reason, j.usage.input_tokens, j.usage.cache_read_input_tokens],
        [[{ type: 'text', text: 'Hi there' }, { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.js' } }], 'tool_use', 6, 4]);

    res = await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...an, stream: true }) });
    const evs = await sse(res);
    eq('anthropic stream: the events in order', evs.map((e) => e.type), ['message_start', 'content_block_start',
        'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop']);
    eq('anthropic stream: the tool input', JSON.parse(evs[6].delta.partial_json), { path: 'a.js' });
    eq('anthropic: count_tokens', await (await post('/v1/messages/count_tokens', an)).json(), { input_tokens: 42 });

    fault = new ApiError('busy', 'the cluster is busy');
    res = await post('/v1/messages', { ...an, stream: true });
    eq('a busy cluster: anthropic 529 overloaded', [res.status, (await res.json()).error.type], [529, 'overloaded_error']);
    res = await post('/v1/chat/completions', { ...oa, stream: true });
    eq('and openai 429', res.status, 429);
    fault = Object.assign(new ApiError('context', 'too long'), { tokens: 20000, max: 16384 });
    res = await post('/v1/messages', an);
    j = await res.json();
    ok('a long prompt: 400 with the words Claude Code compacts on', res.status === 400
        && j.error.message.startsWith('prompt is too long: 20000 tokens > 16384 maximum'), j.error.message);
    eq('unknown path 404, wrong method 405', [(await fetch(`${url}/nope`)).status,
        (await fetch(`${url}/v1/messages`)).status], [404, 405]);
    res = await fetch(url + '/v1/messages', { method: 'POST', body: '{' });
    eq('a body that is not JSON is a 400', res.status, 400);
    eq('the info clusterchat setup reads', (await (await fetch(`${url}/clusterchat`)).json()).id, 'qwen3.5-4b');
    server.close();

    for (const h of harnesses) ok(`${h.name}'s setup names the url and model`,
        h.setup(url, cluster.info).includes(url) && h.setup(url, cluster.info).includes('qwen3.5-4b'));
}

console.log('\nwhich cluster');
{
    const code = 'AAAAAAAAAAAAAAAAAAAAAA';
    eq('a link names its server', parseTarget(`https://my.host/chat#mesh=${code}&model=qwen3.5-4b`).server, 'https://my.host');
    eq('demo is clusterchat.io by default', parseTarget('demo').server, 'https://clusterchat.io');
    eq('or --server', parseTarget('demo', { server: 'http://localhost:8000/chat' }).server, 'http://localhost:8000');
    for (const [what, arg] of [['nothing', undefined], ['a link without an invite', 'https://clusterchat.io/chat'],
        ['a damaged code', 'https://clusterchat.io/chat#mesh=abc'], ['not a link', 'clusterchat.io']]) {
        ok(`${what} is an error, not the demo`, (() => { try { parseTarget(arg); return false; } catch { return true; } })());
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
