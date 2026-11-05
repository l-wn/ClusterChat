// Anthropic's Messages API, for Claude Code. Any model name is accepted:
// every request runs on the cluster's model.

import { sendJson, startSse, closed, heartbeat } from '../http.js';

const STOP = { end: 'end_turn', stopped: 'end_turn', length: 'max_tokens', tool: 'tool_use' };
const STATUS = { invalid: 400, context: 400, busy: 529, unready: 529 };
const TYPE = { invalid: 'invalid_request_error', context: 'invalid_request_error',
               busy: 'overloaded_error', unready: 'overloaded_error' };

function toCore(body, signal) {
    const messages = [];
    for (const m of body.messages ?? []) {
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
        if (m.role === 'assistant') {
            messages.push({ role: 'assistant', text: texts(blocks),
                calls: blocks.filter((b) => b.type === 'tool_use')
                    .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })) });
            continue;
        }
        // A user turn: its tool results first, then what the user wrote.
        for (const b of blocks.filter((b) => b.type === 'tool_result')) {
            const text = typeof b.content === 'string' ? b.content : texts(b.content ?? []);
            messages.push({ role: 'tool', callId: b.tool_use_id, text: b.is_error ? `Error: ${text}` : text });
        }
        const text = texts(blocks);
        if (text || !blocks.some((b) => b.type === 'tool_result')) messages.push({ role: 'user', text });
    }
    return {
        system: body.system == null ? null
            : typeof body.system === 'string' ? body.system : texts(body.system),
        tools: (body.tools ?? []).filter((t) => t.input_schema)
            .map((t) => ({ name: t.name, description: t.description, schema: t.input_schema })),
        messages,
        maxTokens: body.max_tokens ?? null,
        temperature: body.temperature ?? null,
        signal,
    };
}

// The text of a list of blocks. Thinking is dropped; an image becomes a note.
const texts = (blocks) => blocks.map((b) => b.type === 'text' ? b.text
    : b.type === 'image' || b.type === 'document' ? '[image omitted]' : null)
    .filter((t) => t != null).join('\n');

// `cache_read_input_tokens` is what the cluster did not have to compute: this
// chat's own context plus any prefix the peers already held from another chat
// (core.js's `shared`). The two are separate in the CLI's own line, where which
// it was matters; to a client they are one number.
const usage = (u) => ({ input_tokens: u.input - u.cached - (u.shared ?? 0),
    output_tokens: u.output,
    cache_read_input_tokens: u.cached + (u.shared ?? 0), cache_creation_input_tokens: 0 });

async function messages(req, res, cluster, body) {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const model = body.model ?? cluster.info.id;
    const events = cluster.chat(toCore(body, closed(res)));
    await events.next();        // 'start': failing before it gets a status code

    if (!body.stream) {
        const content = [];
        let end;
        for await (const ev of events) {
            if (ev.type === 'text') {
                if (content.at(-1)?.type === 'text') content.at(-1).text += ev.text;
                else content.push({ type: 'text', text: ev.text });
            } else if (ev.type === 'call') content.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.args });
            else end = ev;
        }
        return sendJson(res, 200, { id, type: 'message', role: 'assistant', model, content,
            stop_reason: STOP[end.stop], stop_sequence: null, usage: usage(end.usage) });
    }

    const send = startSse(res);
    const event = (type, data) => send({ type, ...data }, type);
    const stop = heartbeat(res, 'event: ping\ndata: {"type": "ping"}\n\n');
    let index = -1, open = null;    // the block being written and its type
    const close = () => { if (open) event('content_block_stop', { index }); open = null; };
    try {
        event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        for await (const ev of events) {
            if (ev.type === 'text') {
                if (open !== 'text') {
                    close();
                    event('content_block_start', { index: ++index, content_block: { type: 'text', text: '' } });
                    open = 'text';
                }
                event('content_block_delta', { index, delta: { type: 'text_delta', text: ev.text } });
            } else if (ev.type === 'call') {
                close();
                event('content_block_start', { index: ++index,
                    content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} } });
                open = 'tool_use';
                event('content_block_delta', { index,
                    delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.args) } });
            } else {
                close();
                event('message_delta', { delta: { stop_reason: STOP[ev.stop], stop_sequence: null },
                    usage: usage(ev.usage) });
            }
        }
        event('message_stop', {});
    } catch (err) {
        event('error', { error: errorBody(err) });
    } finally {
        stop();
    }
    res.end();
}

// Claude Code compacts the conversation when it reads "prompt is too long".
const errorBody = (err) => ({ type: TYPE[err.kind] ?? 'api_error',
    message: err.kind === 'context' ? `prompt is too long: ${err.tokens} tokens > ${err.max} maximum. ${err.message}`
        : err.message });

export default {
    name: 'anthropic',
    routes: {
        'POST /v1/messages': messages,
        'POST /v1/messages/count_tokens': async (req, res, cluster, body) =>
            sendJson(res, 200, { input_tokens: await cluster.count(toCore(body)) }),
    },
    fail: (res, err) => sendJson(res, STATUS[err.kind] ?? 500, { type: 'error', error: errorBody(err) }),
};
