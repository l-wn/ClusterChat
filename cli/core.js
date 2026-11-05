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
//                                       (of which the peers may already hold a
//                                       prefix from another chat: `shared` on
//                                       the 'end' event, once it is known)
//                                       reused ones. Errors before this are
//                                       the request's, not the reply's
//   { type: 'text', text }              a piece of the reply, in order
//   { type: 'call', id, name, args }    a tool call, after the text
//   { type: 'end', stop, usage }        stop: 'end' | 'length' | 'tool' | 'stopped'
//                                       usage: { input, output, cached, shared }
//                                       in tokens
// and throws an ApiError when the request cannot run.
//
// Agents send the whole conversation every time. The cluster keeps the last
// few chats it ran, and a request that continues one feeds only its new
// messages, so the mesh does not prefill the conversation again. A request
// that is a *prefix* of a kept chat continues it too, by rewinding the chat to
// where that reply began: an agent that gave up on a slow reply and started a
// new session re-sends its first turn verbatim, and that turn is already
// cached on the GPUs.

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

// Tokens a rewind must save, over the best position that needs no rewind,
// before it is worth taking. A rewind gives back the end of the chat it
// rewinds: the messages past that point stop being continuable, so an agent
// that comes back with them pays a full prefill. Worth it for the thousands of
// tokens a restarted session re-sends, not for a few hundred.
const REWIND_MIN = 512;

// `engine` has joined (join.js). `template` is the model's chat format
// (templates/). `info` is printed and served as is. `count` is the tokenizer's
// encode(), replaced in tests. `onPrepare` sees what each request decided to
// feed, before it is fed: bin.js uses it to dump prompts for
// tools/prefix-overlap.mjs, which measures how much two agents' prompts
// actually share. Nothing in here depends on it.
export function makeCluster({ engine, template, info, sampling = {}, count: tokens = encode,
                              onPrepare = null }) {
    const net = engine.net;
    // { conv, key, msgs, len, marks }, most recent first. `len` is the chat's
    // context length now; `marks` is where it can be continued from (below).
    const recent = [];
    let queue = Promise.resolve();
    // The assistant-turn opener's length in tokens, measured once. A template
    // that does not export one records no 'prompt' marks, so such a cluster
    // keeps exactly the reuse it had before.
    let openLen = null;
    const openTokens = async () => (openLen ??= (await tokens(template.open)).length);

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
            try {
                yield { type: 'start', tokens: plan.fresh, cached: plan.cached };
                yield* turn(req, plan);
            } finally { net.unseat(); }
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

    // --- Where a chat's context can be continued from ---
    //
    // Every render() ends on the assistant-turn opener (`template.open`), and
    // render(..., { first: false }) begins by closing that turn. So only two
    // positions per turn have the shape a continuation expects, and a mark
    // records which of the two it is:
    //
    //   'prompt'  the prompt was fed up to but not including the opener, so
    //             the context ends on message `i`'s own end-of-turn. Only a
    //             request that stops at `i` can continue here, by feeding the
    //             opener alone and generating the reply again: anything after
    //             it would leave an empty assistant turn in the context. This
    //             is where a restarted agent's re-sent first turn lands.
    //   'reply'   the reply at index `i` is in the context with its turn left
    //             unclosed, which is what render({ first: false }) assumes.
    //             Any request repeating messages 0..i continues here. The last
    //             one of these is the chat's current end, and reaching it needs
    //             no rewind: that is the reuse this file has always done.
    //
    // `i` indexes the whole conversation, not the request, because an agent
    // resends every message every time and `entry.msgs` is built from that.

    // The chat and position a request continues from, or undefined. The
    // deepest position over every kept chat wins, since that is the most
    // tokens reused.
    //
    // A position that needs a rewind must save REWIND_MIN tokens over the best
    // that does not. On a hybrid checkpoint one is never taken at all: a rewind
    // there marks the chat stale (route.js's rewind()) because a linear
    // attention layer cannot give back the tokens it folded in, so the next
    // turn rebuilds the whole conversation — more than the miss it avoids.
    function bestHit(key, msgs) {
        const cands = [];
        for (const entry of recent) {
            if (entry.key !== key) continue;
            // How many of this chat's messages the request repeats.
            let k = 0;
            while (k < entry.msgs.length && k < msgs.length && entry.msgs[k] === msgs[k]) k++;
            for (const mark of entry.marks) {
                if (mark.i >= k) continue;
                if (mark.kind === 'prompt' && mark.i !== msgs.length - 1) continue;
                const back = entry.len - mark.len;
                if (back > 0 && engine.hybrid) continue;
                cands.push({ entry, mark, back });
            }
        }
        const free = cands.filter((c) => !c.back).sort((a, b) => b.mark.len - a.mark.len)[0];
        const deep = cands.sort((a, b) => b.mark.len - a.mark.len)[0];
        if (!deep || !deep.back) return deep;
        return deep.mark.len - (free?.mark.len ?? 0) >= REWIND_MIN ? deep : free;
    }

    // Which chat a request runs in and what it feeds, checked against the
    // context before anything changes.
    async function prepare(req) {
        const tools = req.tools ?? [];
        const key = JSON.stringify([req.system ?? null, tools]);
        const msgs = req.messages.map(norm);

        const hit = bestHit(key, msgs);
        const prompt = !hit
            ? template.render(req.messages, { tools, system: req.system, first: true })
            : hit.mark.kind === 'prompt' ? template.open
            : template.render(req.messages.slice(hit.mark.i + 1), { first: false });
        const fresh = (await tokens(prompt)).length;
        const cached = hit?.mark.len ?? 0;
        const total = cached + fresh;
        if (total >= engine.ctxMax) {
            throw Object.assign(new ApiError('context', `the conversation needs ${total} tokens and `
                + `this cluster's context holds ${engine.ctxMax}. Shorten it, or use a cluster `
                + 'created with a longer context.'), { tokens: total, max: engine.ctxMax });
        }
        onPrepare?.({ prompt, fresh, cached, reused: hit?.mark.kind ?? null });
        return { tools, key, msgs, hit, prompt, fresh, cached };
    }

    async function* turn(req, { tools, key, msgs, hit, prompt }) {
        let entry;
        if (hit) {
            entry = hit.entry;
            engine.switchTo(entry.conv);
            // Rewinding to a mark drops the context past it, so everything the
            // entry recorded past it stops being true and is truncated here,
            // before anything can throw: otherwise a later request would
            // continue from tokens that have been overwritten. The peers need
            // no telling. A full-attention layer's KV is addressed by position,
            // so the next job's shorter `past` overwrites the rows above it.
            //
            // The rewind lands by subtracting from `entry.len`, this chat's
            // context length as of its last turn. If the router disagrees, it
            // would land somewhere else and the prompt prepare() rendered would
            // be fed at the wrong position, which produces wrong tokens and no
            // error. Refuse and drop the chat instead: the agent's retry gets a
            // fresh one and pays a prefill, which is the cost of being sure.
            if (hit.back > 0) {
                if (engine.ctxLen !== entry.len) {
                    forget(entry);
                    engine.discard(entry.conv);
                    throw new ApiError('unready', 'this chat changed underneath the request; '
                        + 'try again and it will be sent in full');
                }
                engine.rewind(hit.back);
                entry.msgs = entry.msgs.slice(0, hit.mark.i + 1);
                entry.marks = entry.marks.filter((m) => m.len <= hit.mark.len);
                entry.len = hit.mark.len;
            }
        } else {
            entry = { conv: engine.newChat(), key, msgs: [], len: 0, marks: [] };
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
        // Where the next request may continue this chat (see the marks above).
        // The 'prompt' mark is `cached` plus the prompt's own tokens, less the
        // opener's, rather than engine.ctxLen - engine.lastFed: runTurn()
        // rewinds a stop sequence *after* the engine has counted what it fed,
        // so the subtraction would be short by the cut. It is exact because
        // the opener starts on a special token, which the tokenizer never
        // merges across — the same property render({ first: false }) relies on.
        if (template.open) {
            mark(entry, 'prompt', msgs.length - 1,
                 cached + result.promptTokens - (await openTokens()));
        }
        mark(entry, 'reply', msgs.length, engine.ctxLen);
        entry.len = engine.ctxLen;

        const stopped = engine.lastStopReason;
        const stop = ids.length ? 'tool' : stopped === 'stopped' ? 'stopped'
            : stopped === 'length' || stopped === 'context' ? 'length' : 'end';
        yield { type: 'end', stop,
                // `cached`: tokens this chat already had on the peers.
                // `shared`: tokens of this prompt the peers held from another
                // chat, so they were never sent (route.js's probe). Two
                // sessions in different directories share no chat but almost
                // all of their prompt, which is the whole point.
                usage: { input: cached + result.promptTokens, output: result.ids.length, cached,
                         shared: engine.lastShared } };
    }

    const forget = (entry) => {
        const i = recent.indexOf(entry);
        if (i >= 0) recent.splice(i, 1);
    };

    // Record where this chat can be continued from. Marks are added in
    // ascending `len` order, and a turn regenerated after a rewind to its own
    // 'prompt' mark re-records that same (kind, i) rather than adding a
    // duplicate, so the list stays ascending and one entry long per position.
    const mark = (entry, kind, i, len) => {
        const at = entry.marks.findIndex((m) => m.kind === kind && m.i === i);
        if (at >= 0) entry.marks[at].len = len;
        else entry.marks.push({ kind, i, len });
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
