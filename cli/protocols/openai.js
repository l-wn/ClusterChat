// OpenAI's Chat Completions API, for opencode and most other tools.

import { sendJson, startSse, closed, heartbeat } from '../http.js';

const FINISH = { end: 'stop', stopped: 'stop', length: 'length', tool: 'tool_calls' };
const STATUS = { invalid: 400, context: 400, busy: 429, unready: 503 };

function toCore(body, signal) {
    const system = [], messages = [];
    for (const m of body.messages ?? []) {
        const text = flatten(m.content);
        if (m.role === 'system' || m.role === 'developer') system.push(text);
        else if (m.role === 'user') messages.push({ role: 'user', text });
        else if (m.role === 'tool') messages.push({ role: 'tool', text, callId: m.tool_call_id });
        else if (m.role === 'assistant') {
            messages.push({ role: 'assistant', text, calls: (m.tool_calls ?? []).map((c) => ({
                id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) })) });
        }
    }
    return {
        system: system.length ? system.join('\n\n') : null,
        tools: (body.tools ?? []).filter((t) => t.type === 'function').map((t) => ({
            name: t.function.name, description: t.function.description, schema: t.function.parameters })),
        messages,
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? null,
        temperature: body.temperature ?? null,
        signal,
    };
}

function flatten(content) {
    if (typeof content === 'string') return content;
    return (content ?? []).map((p) => p.type === 'text' ? p.text : '[image omitted]').join('\n');
}

function parseArgs(s) {
    try { return typeof s === 'string' ? JSON.parse(s || '{}') : s ?? {}; } catch { return { _: s }; }
}

async function completions(req, res, cluster, body) {
    const id = `chatcmpl-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000);
    const model = body.model ?? cluster.info.id;
    const events = cluster.chat(toCore(body, closed(res)));
    await events.next();        // 'start': failing before it gets a status code
    const usage = (u) => ({ prompt_tokens: u.input, completion_tokens: u.output,
        total_tokens: u.input + u.output, prompt_tokens_details: { cached_tokens: u.cached } });

    if (!body.stream) {
        let text = '', calls = [], end;
        for await (const ev of events) {
            if (ev.type === 'text') text += ev.text;
            else if (ev.type === 'call') calls.push(ev);
            else end = ev;
        }
        return sendJson(res, 200, { id, object: 'chat.completion', created, model,
            choices: [{ index: 0, finish_reason: FINISH[end.stop], message: { role: 'assistant',
                content: text || (calls.length ? null : ''),
                ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) } })) }) } }],
            usage: usage(end.usage) });
    }

    // The first token can wait for a long prefill, so the headers and a
    // heartbeat go out now.
    const send = startSse(res);
    const stop = heartbeat(res, ': ping\n\n');
    const chunk = (delta, finish = null) => send({ id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }] });
    try {
        chunk({ role: 'assistant', content: '' });
        let n = 0;
        for await (const ev of events) {
            if (ev.type === 'text') chunk({ content: ev.text });
            else if (ev.type === 'call') {
                chunk({ tool_calls: [{ index: n++, id: ev.id, type: 'function',
                    function: { name: ev.name, arguments: JSON.stringify(ev.args) } }] });
            } else {
                chunk({}, FINISH[ev.stop]);
                if (body.stream_options?.include_usage) {
                    send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage(ev.usage) });
                }
            }
        }
    } catch (err) {
        send({ error: errorBody(err) });
    } finally {
        stop();
    }
    send('[DONE]');
    res.end();
}

const errorBody = (err) => ({ message: err.message, type: err.kind ?? 'server_error',
    ...(err.kind === 'context' && { code: 'context_length_exceeded' }) });

export default {
    name: 'openai',
    routes: {
        'GET /v1/models': (req, res, cluster) => sendJson(res, 200, { object: 'list', data: [
            { id: cluster.info.id, object: 'model', created: 0, owned_by: 'clusterchat' }] }),
        'POST /v1/chat/completions': completions,
    },
    fail: (res, err) => sendJson(res, STATUS[err.kind] ?? 500, { error: errorBody(err) }),
};
