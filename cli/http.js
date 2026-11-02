// The local HTTP server: every protocol's routes, and nothing else.

import { createServer } from 'node:http';
import { protocols, harnesses } from './plugins.js';

const BODY_MAX = 32 << 20;      // a long agent conversation, with room to spare

// `onChat({ route, agent })` is called when a request starts a reply and
// returns a tap that sees its events: event(ev) for each, fail(err), close().
// `agent` is the harness whose `agent` pattern matches the User-Agent.
export function listen(cluster, { port, host, onChat = null }) {
    // What `clusterchat setup` reads: the cluster this process serves.
    const routes = new Map([['GET /clusterchat', { protocol: { fail: (res, err) => sendJson(res, 500, { error: err.message }) },
        handler: (req, res, c) => sendJson(res, 200, { ...c.info, gpus: c.info.gpus, ready: c.info.ready }) }]]);
    for (const p of protocols) {
        for (const [route, handler] of Object.entries(p.routes)) {
            if (routes.has(route)) throw new Error(`${p.name} and another protocol both serve ${route}`);
            routes.set(route, { handler, protocol: p });
        }
    }
    const server = createServer(async (req, res) => {
        const path = new URL(req.url, 'http://x').pathname;
        const hit = routes.get(`${req.method} ${path}`);
        if (!hit) {
            const known = [...routes.keys()].some((r) => r.endsWith(` ${path}`));
            return sendJson(res, known ? 405 : 404, { error: { message: `${known ? 'no ' + req.method + ' on' : 'nothing at'} ${path}` } });
        }
        try {
            const body = req.method === 'POST' ? await readJson(req) : null;
            const ua = req.headers['user-agent'] ?? '';
            const agent = harnesses.find((h) => h.agent?.test(ua))?.name ?? hit.protocol.name;
            await hit.handler(req, res, onChat ? tapped(cluster, () => onChat({ route: `${req.method} ${path}`, agent }))
                : cluster, body);
        } catch (err) {
            if (!res.headersSent) hit.protocol.fail(res, err);
            else res.end();
            if (!err.kind) console.error(`${req.method} ${path}:`, err);
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}

// `cluster` with every chat() reported to the tap `open()` makes.
function tapped(cluster, open) {
    return { ...cluster, info: cluster.info, async *chat(req) {
        const tap = open();
        try {
            for await (const ev of cluster.chat(req)) { tap.event(ev); yield ev; }
        } catch (err) {
            tap.fail(err);
            throw err;
        } finally {
            tap.close();
        }
    } };
}

async function readJson(req) {
    let size = 0;
    const parts = [];
    for await (const part of req) {
        size += part.length;
        if (size > BODY_MAX) throw Object.assign(new Error('the request body is too large'), { kind: 'invalid' });
        parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch {
        throw Object.assign(new Error('the request body is not JSON'), { kind: 'invalid' });
    }
}

export function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

// Server-sent events. `event` names the event for protocols that use one.
export function startSse(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
                         connection: 'keep-alive' });
    return (data, event = null) => res.write(`${event ? `event: ${event}\n` : ''}data: ${
        typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

// An AbortSignal that fires when the client goes away before the reply ends.
export function closed(res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    return ac.signal;
}

// Write `line` every `ms` until the reply ends, so a long prefill does not
// look like a dead connection. Returns the function that stops it.
export function heartbeat(res, line, ms = 10000) {
    const timer = setInterval(() => res.write(line), ms);
    res.once('close', () => clearInterval(timer));
    return () => clearInterval(timer);
}
