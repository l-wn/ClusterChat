// Tests the worker boundary in web/serve-client.js: that every room-shaping
// choice a page makes reaches the worker's join, and that every scalar the
// worker mirrors in its snapshot is readable through `engine.net`.
//
// This is the seam a creator's choices cross. `snaps` was added to the join on
// both sides of it and dropped in the middle, so a private mesh opened with
// the server's default no matter what the create page chose, and nothing
// caught it: no test touched this file, and the dev harness asks for slots
// through serve() instead.
//
//   node tools/serve.test.mjs

import { EngineClient } from '../web/serve-client.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    if (got === want) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// The least Worker the client needs: it records what the page posts and
// answers each command with an empty result. `wire: 'bc'` keeps installRtcHost
// (and the rest of the browser) out of it.
function stubWorker() {
    const sent = [];
    globalThis.Worker = class {
        constructor() { this.on = null; }
        addEventListener(type, fn) { if (type === 'message') this.on = fn; }
        postMessage(m) {
            sent.push(m);
            if (m.t !== 'cmd' || !m.id) return;
            queueMicrotask(() => this.on?.({ data: { t: 'res', id: m.id, ok: true, value: {} } }));
        }
    };
    return { sent, cmd: (name) => sent.find((m) => m.t === 'cmd' && m.name === name)?.args };
}

console.log('\nconnect() carries the creator\'s choices to the worker');
{
    const { cmd } = stubWorker();
    const engine = new EngineClient({ wire: 'bc' });
    await engine.connect({ invite: { secret: 'a'.repeat(22), model: 'qwen3.5-4b' },
                           chats: 3, sessions: 20, snaps: 48, ctx: 32768, relayOnly: false });
    const args = cmd('connect');
    eq('the invite', args.invite.secret, 'a'.repeat(22));
    eq('its model', args.invite.model, 'qwen3.5-4b');
    eq('chats at once', args.chats, 3);
    eq('chats in memory', args.sessions, 20);
    eq('shared prefixes', args.snaps, 48);
    eq('the context window', args.ctx, 32768);
    eq('relayOnly', args.relayOnly, false);
}

console.log('\nand defaults every one it is not given');
{
    const { cmd } = stubWorker();
    const engine = new EngineClient({ wire: 'bc' });
    await engine.connect({});
    const args = cmd('connect');
    eq('no invite: the global mesh', args.invite, null);
    eq('no chat limit asked', args.chats, null);
    eq('no session count asked', args.sessions, null);
    eq('no prefix count asked', args.snaps, null);
    eq('no context asked', args.ctx, null);
    eq('relayed by default', args.relayOnly, true);
}

console.log('\nevery scalar the worker mirrors is readable through engine.net');
{
    stubWorker();
    const engine = new EngineClient({ wire: 'bc' });
    // The shape serve-host.js's snapshot() builds, as the page receives it.
    const net = { id: 2, sessions: 16, maxChats: 4, snaps: 48, ctx: 16384, online: 3 };
    engine.snap = { ...engine.snap, net };
    for (const [k, want] of Object.entries(net)) eq(`net.${k}`, engine.net[k], want);
    eq('and a field the worker did not send reads null', engine.net.coverage, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
