// From the command line's target to a joined Engine.
//
// The target is an invite link, whose origin is the server, or `demo` for a
// server's public demo. Nothing else is accepted: a missing or damaged link
// must not fall back to the demo, where strangers' GPUs see the prompts.

import { webcrypto } from 'node:crypto';
import { Engine } from '../web/engine.js';
import { REFUSED } from '../web/net.js';
import { readInvite, inviteModel, openRoom } from '../web/room.js';
import { templates } from './plugins.js';
import { cacheTokenizer } from './cache.js';

globalThis.crypto ??= webcrypto;    // Node 18
cacheTokenizer();

export const DEFAULT_SERVER = 'https://clusterchat.io';
const LINK_WAIT_MS = 30000;
const JOIN_WAIT_MS = 20000;

// { server, hash, demo } for `connect`'s argument. Throws with what to do.
export function parseTarget(arg, { server = null } = {}) {
    if (!arg) throw new Error("say which cluster: clusterchat connect '<invite link>', or "
        + 'clusterchat connect demo for the public demo');
    if (arg === 'demo') {
        return { server: origin(server ?? process.env.CLUSTERCHAT_SERVER ?? DEFAULT_SERVER), hash: '', demo: true };
    }
    if (server) throw new Error('--server is only for demo. An invite link already names its server.');
    let url;
    try { url = new URL(arg); } catch {
        throw new Error(`"${arg.slice(0, 60)}" is not a link. Expected an invite link `
            + "(https://…/chat#mesh=…, in quotes) or demo.");
    }
    if (readInvite(url.hash) == null) {
        throw new Error('this link has no invite code (#mesh=…). Copy the invite link from the '
            + "cluster's page, in quotes. For the public demo, run: clusterchat connect demo");
    }
    return { server: url.origin, hash: url.hash, demo: false };
}

function origin(s) {
    try { return new URL(s).origin; } catch { throw new Error(`--server "${s}" is not a URL`); }
}

// Join `target` as a chat-only peer. Resolves { engine, template, info }
// once the mesh has welcomed it, after waiting up to LINK_WAIT_MS for a link
// to the GPUs; requests are refused until there is one.
//
// `on(step, detail)` follows along: 'joined' with info, then 'no-gpus', or
// 'linking' and then 'linked' { seconds } or 'unlinked'. `onEvent` is the
// Engine's (web/engine.js), for a caller that wants its repairs.
export async function join(target, { on = () => {}, client = null, onEvent = () => {} } = {}) {
    let Polyfill, WebSocket;
    try {
        ({ RTCPeerConnection: Polyfill } = await import('node-datachannel/polyfill'));
        ({ default: WebSocket } = await import('ws'));
    } catch (err) {
        throw new Error(`a dependency is missing (${err.message}). Run npm install in the cli folder.`);
    }
    // The polyfill writes TURN credentials into a turn:user:pass@host URL as
    // they are, and the server's have a ":" in the username (expiry:peer) and
    // base64 in the password, so libdatachannel misreads them and no relay
    // link opens. Escaped, they come through.
    class RTCPeerConnection extends Polyfill {
        constructor(config = {}) {
            super({ ...config, iceServers: (config.iceServers ?? []).map((s) => s.username == null ? s
                : { ...s, username: encodeURIComponent(s.username), credential: encodeURIComponent(s.credential) }) });
        }
    }
    const room = await openRoom(readInvite(target.hash), { model: inviteModel(target.hash) });
    const engine = new Engine({ onEvent });
    let manifest, timer;
    try {
        // The mesh retries a server it cannot reach for as long as it runs,
        // which a page wants and a command line does not.
        ({ manifest } = await Promise.race([
            engine.connect({ room, relayOnly: true,
                platform: { server: target.server, WebSocket, RTCPeerConnection, client } }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(
                `could not reach ${target.server}: ${engine.net?.trouble?.replace(/, retrying in .*/, '') ?? 'no answer'}`)), JOIN_WAIT_MS); }),
        ]));
    } catch (err) {
        engine.drop();
        if (err.message === REFUSED[4001]) throw new Error(`${target.server} speaks a different `
            + 'version of the protocol. Update clusterchat (npm i -g clusterchat@latest), or if '
            + "the server runs modified code, run the client from that server's checkout.");
        if (err.message === REFUSED[4003]) throw new Error(`${target.server} does not offer this `
            + "link's model. Check the link, and that it was quoted.");
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const template = templates.find((t) => t.format === manifest.chat_format);
    if (!template) {
        engine.drop();
        throw new Error(`${manifest.model} uses the "${manifest.chat_format}" chat format, and this `
            + `client knows ${templates.map((t) => t.format).join(', ')}`);
    }

    const net = engine.net;
    const info = {
        server: target.server,
        room: target.demo ? 'public demo' : `private cluster ${room.tag}`,
        model: manifest.model,
        id: room.model ?? manifest.model.split('/').pop().toLowerCase(),
        ctx: engine.ctxMax,
        get gpus() { return net.peers.filter((p) => p.ready).length; },
        get ready() { return net.connected; },
    };
    on('joined', info);
    if (!info.gpus) {
        on('no-gpus', { demo: target.demo });
        return { engine, template, info };
    }
    on('linking');
    const t0 = Date.now();
    while (!net.connected && Date.now() - t0 < LINK_WAIT_MS) await new Promise((r) => setTimeout(r, 250));
    on(net.connected ? 'linked' : 'unlinked', { seconds: (Date.now() - t0) / 1000 });
    return { engine, template, info };
}
