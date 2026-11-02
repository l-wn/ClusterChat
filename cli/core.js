// The one request shape every protocol translates to, and the one place a
// request meets the mesh.
//
//   req       { system, tools, messages, maxTokens, temperature, signal }
//   tools     [{ name, description, schema }]   schema is JSON Schema
//   messages  [{ role: 'user' | 'assistant' | 'tool', text, calls?, callId? }]
//   calls     [{ id, name, args }]
//
// cluster.chat(req) yields
//   { type: 'start', tokens, cached }   the request has a seat and feeds
//                                       `tokens` new tokens after `cached`
//                                       reused ones. Errors before this are
//                                       the request's, not the reply's
//   { type: 'text', text }              a piece of the reply, in order
//   { type: 'call', id, name, args }    a tool call, after the text
//   { type: 'end', stop, usage }        stop: 'end' | 'length' | 'tool' | 'stopped'
//                                       usage: { input, output, cached } in tokens
// and throws an ApiError when the request cannot run.
//
// Agents send the whole conversation every time. The cluster keeps the last
// few chats it ran, and a request that continues one feeds only its new
// messages, so the mesh does not prefill the conversation again.

import { runTurn } from '../web/turn.js';
import { stopRe } from '../web/prompt.js';
import { encode } from '../web/model/tokenizer.js';
import { ContextFullError } from '../web/engine.js';

export class ApiError extends Error {
    // `kind`: 'invalid' (the request), 'busy' (no seat), 'unready' (the
    // cluster cannot answer yet), 'context' (does not fit). Each protocol maps
    // them to its own status codes.
    constructor(kind, message) { super(message); this.kind = kind; }
}

const SEAT_RETRY_MS = 2000;
const SEAT_WAIT_MS = 60000;

// `engine` has joined (join.js). `template` is the model's chat format
// (templates/). `info` is printed and served as is. `count` is the tokenizer's
// encode(), replaced in tests.
export function makeCluster({ engine, template, info, sampling = {}, count: tokens = encode }) {
    const net = engine.net;
    const recent = [];          // { conv, key, msgs }, most recent first
    let queue = Promise.resolve();

    const check = (req) => {
        if (!Array.isArray(req.messages) || !req.messages.some((m) => m.role === 'user')) {
            throw new ApiError('invalid', 'the request has no user message');
        }
        if (req.tools?.length && !template.tools) {
            throw new ApiError('invalid', `this cluster's model (${info.model}) has no tool calls`);
        }
    };

    async function* chat(req) {
        check(req);
        // One reply at a time: the engine has one active chat.
        let release;
        const turnDone = new Promise((r) => { release = r; });
        const before = queue;
        queue = queue.then(() => turnDone);
        await before;
        try {
            if (req.signal?.aborted) throw new ApiError('invalid', 'the client went away');
            if (!net.connected) {
                throw new ApiError('unready', net.peers.some((p) => p.hi > p.lo)
                    ? 'the cluster is not ready yet: waiting for a link to its GPUs'
                    : 'no GPUs are serving this cluster yet');
            }
            const plan = await prepare(req);
            await seat(req.signal);
            try { yield { type: 'start', tokens: plan.fresh, cached: plan.hit?.len ?? 0 }; yield* turn(req, plan); } finally { net.unseat(); }
        } finally {
            release();
        }
    }

    async function seat(signal) {
        for (const t0 = Date.now(); ;) {
            const s = await net.seat();
            if (s.ok) return;
            if (signal?.aborted || Date.now() - t0 > SEAT_WAIT_MS) {
                throw new ApiError('busy', `the cluster is busy: ${s.max} replies already running`);
            }
            await new Promise((r) => setTimeout(r, SEAT_RETRY_MS));
        }
    }

    // Which chat a request runs in and what it feeds, checked against the
    // context before anything changes.
    async function prepare(req) {
        const tools = req.tools ?? [];
        const key = JSON.stringify([req.system ?? null, tools]);
        const msgs = req.messages.map(norm);

        // The longest chat this request continues: same system and tools, and
        // its messages are where this request's start.
        const hit = recent.filter((e) => e.key === key && e.msgs.length < msgs.length
                && e.msgs.every((m, i) => m === msgs[i]))
            .sort((a, b) => b.msgs.length - a.msgs.length)[0];
        const prompt = hit
            ? template.render(req.messages.slice(hit.msgs.length), { first: false })
            : template.render(req.messages, { tools, system: req.system, first: true });
        const fresh = (await tokens(prompt)).length;
        const total = (hit?.len ?? 0) + fresh;
        if (total >= engine.ctxMax) {
            throw Object.assign(new ApiError('context', `the conversation needs ${total} tokens and `
                + `this cluster's context holds ${engine.ctxMax}. Shorten it, or use a cluster `
                + 'created with a longer context.'), { tokens: total, max: engine.ctxMax });
        }
        return { tools, key, msgs, hit, prompt, fresh };
    }

    async function* turn(req, { tools, key, msgs, hit, prompt }) {
        let entry;
        if (hit) {
            entry = hit;
            engine.switchTo(hit.conv);
        } else {
            entry = { conv: engine.newChat(), key, msgs: [], len: 0 };
        }
        forget(entry);
        recent.unshift(entry);
        for (const old of recent.splice(Math.max(1, net.sessions ?? 4))) engine.discard(old.conv);

        const cached = engine.ctxLen;
        const parser = template.parser(tools);
        const events = channel();
        let shown = '';     // what the client was sent, which the next request sends back
        const onAbort = () => engine.stop();
        req.signal?.addEventListener('abort', onAbort);
        const opts = { ...sampling, temp: req.temperature ?? sampling.temp,
                       maxTokens: req.maxTokens ?? Infinity, chat: true, thinking: false };
        const done = runTurn(engine, null, opts, {
            prompt, turnRe: stopRe(template.format),
            onToken: ({ text }) => {
                const t = parser.feed(text);
                if (t) { shown += t; events.push({ type: 'text', text: t }); }
            },
        }).then((r) => events.close(r), (err) => events.fail(err));

        let result, failed = true;
        try {
            for (;;) {
                const next = await events.next();
                if (next.done) { result = next.value; break; }
                yield next.value;
            }
            failed = false;
        } catch (err) {
            if (err instanceof ContextFullError) {
                throw Object.assign(new ApiError('context', `${err.message}. Shorten the `
                    + 'conversation, or use a cluster created with a longer context.'),
                    { tokens: engine.ctxLen + err.needed, max: engine.ctxMax });
            }
            throw err;
        } finally {
            req.signal?.removeEventListener('abort', onAbort);
            await done;
            // The chat's context may hold part of a turn its messages do not
            // describe, so no later request may continue it.
            if (failed) { forget(entry); engine.discard(entry.conv); }
        }

        const { text, calls } = parser.end();
        if (text) { shown += text; yield { type: 'text', text }; }
        const ids = calls.map((c) => ({ id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, ...c }));
        for (const c of ids) yield { type: 'call', ...c };

        const reply = { role: 'assistant', text: shown, calls: ids };
        entry.msgs = [...msgs, norm(reply)];
        entry.len = engine.ctxLen;

        const stopped = engine.lastStopReason;
        const stop = ids.length ? 'tool' : stopped === 'stopped' ? 'stopped'
            : stopped === 'length' || stopped === 'context' ? 'length' : 'end';
        yield { type: 'end', stop,
                usage: { input: cached + result.promptTokens, output: result.ids.length, cached } };
    }

    const forget = (entry) => {
        const i = recent.indexOf(entry);
        if (i >= 0) recent.splice(i, 1);
    };

    // The prompt tokens a request would take on a new chat.
    async function count(req) {
        check(req);
        const text = template.render(req.messages, { tools: req.tools ?? [], system: req.system });
        return (await tokens(text)).length;
    }

    return { chat, count, info };
}

// A message as compared between requests: the parts that reach the prompt,
// without ids or whitespace the template trims.
function norm(m) {
    return JSON.stringify([m.role, (m.text ?? '').trim(),
        (m.calls ?? []).map((c) => [c.name, sorted(c.args ?? {})])]);
}

function sorted(v) {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
    }
    return v;
}

// A queue a callback fills and an async loop drains.
function channel() {
    const items = [];
    let wake = null, end = null;
    const poke = () => { wake?.(); wake = null; };
    return {
        push(v) { items.push(v); poke(); },
        close(value) { end = { value }; poke(); },
        fail(error) { end = { error }; poke(); },
        async next() {
            while (!items.length && !end) await new Promise((r) => { wake = r; });
            if (items.length) return { done: false, value: items.shift() };
            if (end.error) throw end.error;
            return { done: true, value: end.value };
        },
    };
}
