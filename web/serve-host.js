// The serving peer, inside a worker.
//
// A serving peer is a server: it accepts jobs, routes them, runs them on the
// GPU and answers. This file is that server's main loop, running on a thread
// of its own so the page's event loop is free for the DOM and for the one
// thing a worker cannot have, RTCPeerConnection.
//
// Everything under it is the production code, unchanged: web/engine.js,
// web/net.js (the signaling socket, the roster, claims, framing),
// web/route.js and web/model/*. `RTCPeerConnection` arrives through the
// `platform` seam net.js already has (web/net.js's constructor,
// cli/join.js's node-datachannel) — here it is web/rtc-proxy.js, which drives
// the real one on the main thread.
//
// The page talks to this through web/serve-client.js. The split is:
//
//   main → here   engine commands, generate(), RTC events, pagehide
//   here → main   engine events + a state snapshot, generated tokens,
//                 RTC instructions
//
// Nothing in this module may use the DOM, `location` or the GPU at import
// time: tools/parse.test.mjs imports every browser module under Node to check
// that it evaluates. The worker's own global wiring is in
// web/serve-worker.js.

import { Engine } from './engine.js';
import { openRoom } from './room.js';
import { MAX_GB } from './lend.js';
import { installRtcProxy } from './rtc-proxy.js';
import { packError } from './serve-protocol.js';

// What the Runner tells the page about itself. `engine.runner` is a live object
// holding GPUBuffers, Maps and session frames, so only these numbers cross —
// the same ones web/dev/harness.js's stats() has always reported, and the ones
// tools/mesh.gpu.test.mjs asserts on (`admitted`, `logs` against `slots`,
// `vramMiB`, the page pool).
function runnerSnapshot(engine) {
    const r = engine.runner;
    if (!r) return null;
    return {
        lo: r.lo, hi: r.hi, have: r.have,
        live: r.live.size, slots: r.live.size + r.free.length,
        cuts: r.cuts.size, logs: r.logs.size,
        pagesFree: r.pool.free.length, pagesTotal: r.pool.nPages,
        pageTokens: r.pool.pageTokens,
        vramMiB: Math.round(engine.vramBytes / 2 ** 20),
        ...r.counts,
    };
}

// The lending slider offers whole gigabytes, 1 to MAX_GB (web/lend.js), and
// web/welcome.js calls capacity(gb) synchronously while it renders. A function
// cannot cross postMessage, so the answers come over as a table and the
// client rebuilds the closure around it. Index 0 is the "no GPU" end.
//
// Cached, because each entry re-reads the manifest and runs the placement
// arithmetic over the roster, and this is built for every snapshot. The
// numbers move only as peers join, leave or grow, and the slider they feed is
// read by a dialog a person is looking at, so a quarter second stale is
// nothing.
const CAPACITY_TTL_MS = 250;

// One entry past MAX_GB, for the slider's top stop: "no limit", meaning keep
// growing until the GPU is full (web/lend.js's `open`, whose `value` reads
// Infinity there). Clamping that to MAX_GB's answer would be the same number
// for every checkpoint that fits in 32 GB and quietly wrong for one that does
// not.
const UNLIMITED = MAX_GB + 1;

function capacityTable(engine, cache) {
    if (!engine.manifest) return null;
    const now = Date.now();
    if (cache.table && now - cache.at < CAPACITY_TTL_MS) return cache.table;
    const out = new Array(UNLIMITED + 1).fill(0);
    for (let gb = 1; gb <= MAX_GB; gb++) {
        try { out[gb] = engine.capacityFor(gb * 2 ** 30); } catch { out[gb] = 0; }
    }
    try { out[UNLIMITED] = engine.capacityFor(Infinity); } catch { out[UNLIMITED] = 0; }
    cache.at = now;
    cache.table = out;
    return out;
}

// Everything the page reads synchronously while it renders, in one structured
// clone. peer.js reaches into 26 `net.*` members and ~18 `engine.*` getters,
// several of them per frame, so they are pushed on every change rather than
// asked for: that is already how the UI gets its data (onChange → re-render).
//
// The roster is a plain array of JSON records (signal-room.js), so it clones as
// it is. `exits`/`reach`/`next`/`hub` are deliberately absent: only route.js
// calls them, and route.js is on this side.
function snapshot(engine, convIds, cache) {
    const net = engine.net;
    return {
        net: net && {
            id: net.id,
            peers: net.peers,
            people: net.people,
            maxPeople: net.maxPeople,
            positions: net.positions,
            blocks: net.blocks,
            minBlocks: net.minBlocks,
            sessions: net.sessions,
            maxChats: net.maxChats,
            ctx: net.ctx,
            online: net.online,
            connected: net.connected,
            trouble: net.trouble,
            refused: net.refused,
            idled: net.idled,
            full: net.full,
            staffed: net.staffed,
            redundancy: net.redundancy,
            authFailures: net.authFailures,
            relay: net.relay,
            relayOnly: net.relayOnly,
            weightsUrl: net.weightsUrl,
            linking: net.linking,
            me: net.me ?? null,
            readyPeers: net.readyPeers,
            coverage: net.positions ? net.coverage : null,
            transports: net.transports,
            links: [...net.links.keys()],
            open: [...net.links.keys()].filter((id) => net.linked(id)),
            room: { private: net.room?.private ?? false, tag: net.room?.tag ?? null,
                    historyTag: net.room?.historyTag ?? 'global',
                    model: net.room?.model ?? null },
        },
        role: engine.role,
        canPrompt: engine.canPrompt,
        dims: engine.dims,
        ctxLen: engine.ctxLen,
        ctxMax: engine.ctxMax,
        ran: engine.ran,
        vramBytes: engine.vramBytes,
        vramLimit: engine.vramLimit,
        blocksPerSec: engine.blocksPerSec,
        lastStopReason: engine.lastStopReason,
        lastPromptTokens: engine.lastPromptTokens,
        lastFed: engine.lastFed,
        lastProfile: engine.lastProfile,
        meshTag: engine.meshTag,
        manifest: engine.manifest ?? null,
        // The active chat as the id the client holds, not the object.
        conversation: convIds.get(engine.conversation) ?? null,
        history: engine.history,
        runner: runnerSnapshot(engine),
        capacity: capacityTable(engine, cache),
    };
}

// `change` fires once per generated token (web/engine.js's #closedLoop), and a
// snapshot is not free: it copies the roster, the profile and the context's
// token ids. The page uses it to redraw pills — the reply's own text comes
// from the generator — so coalescing to this costs nothing visible and keeps
// the worker's loop free, which is the point of being on it. Every other event
// is sent at once, and the trailing edge is always delivered, so the page
// never settles on a stale reading.
const CHANGE_MS = 100;

// How often the worker's own event-loop lag is sampled. The page's
// PerformanceObserver cannot see a long task in here — `longtask` entries are
// per-realm — so moving the work would make that number fall to zero whether
// or not the contention went anywhere. This measures the same thing on this
// side: a timer's drift is the time something else held the loop.
const LAG_MS = 50;

// Build the worker's half of the bridge. `post(msg, transfer)` sends to the
// main thread; the returned `handle(msg)` takes what comes back. Pure — no
// globals touched — so the entry file is the only part that is worker-only.
export function install(post) {
    let engine = null;
    let rtc = null;
    let lag = null;
    // Conversations live here; the page holds opaque ids for them. The page
    // mints the ids, so its newConversation() can stay synchronous — it builds
    // one while rendering (web/peer.js's attach()). Messages are ordered, so
    // the conversation exists here before any switchTo or generate names it.
    const convs = new Map();        // id -> conversation
    const convIds = new Map();      // conversation -> id
    // One generate() at a time, as the Engine already requires.
    let gen = null;

    const capCache = { at: -Infinity, table: null };
    const snap = () => (engine ? snapshot(engine, convIds, capCache) : null);

    let coalescing = null;
    let lastChange = -Infinity;

    function sendSnapshot(type, detail) {
        if (type !== 'change') {
            // This event carries a fresh snapshot, so a change waiting behind
            // it has nothing left to say.
            if (coalescing != null) { clearTimeout(coalescing); coalescing = null; }
            lastChange = Date.now();
            post({ t: 'ev', type, detail, snap: snap() });
            return;
        }
        if (coalescing != null) return;              // one is already due
        const wait = CHANGE_MS - (Date.now() - lastChange);
        if (wait <= 0) {
            lastChange = Date.now();
            post({ t: 'ev', type: 'change', detail, snap: snap() });
            return;
        }
        coalescing = setTimeout(() => {
            coalescing = null;
            lastChange = Date.now();
            post({ t: 'ev', type: 'change', detail, snap: snap() });
        }, wait);
    }

    // Tasks over LAG_MS that this thread spent not running the timer.
    function watchLag() {
        const seen = { count: 0, totalMs: 0, maxMs: 0 };
        let due = Date.now() + LAG_MS;
        setInterval(() => {
            const late = Date.now() - due;
            due = Date.now() + LAG_MS;
            if (late < LAG_MS) return;          // one interval's slack is not a stall
            seen.count++;
            seen.totalMs += late;
            seen.maxMs = Math.max(seen.maxMs, late);
        }, LAG_MS);
        lag = seen;
    }

    function file(id, conv) {
        convs.set(id, conv);
        convIds.set(conv, id);
        return { conv: id };
    }

    const commands = {
        async init({ wire, mtp, warm, batch, buffered }) {
            if (engine) throw new Error('already initialised');
            watchLag();
            // `--wire bc` (tools/mesh.gpu.test.mjs) swaps the datachannel for a
            // BroadcastChannel, which works in a worker, so no RTC crosses the
            // boundary at all. Imported only when asked for, so nothing in a
            // real tab evaluates it.
            if (wire === 'bc') {
                const { installBroadcastWire } = await import('./dev/bcwire.js');
                installBroadcastWire();
            } else {
                rtc = installRtcProxy({ post, buffered });
            }
            engine = new Engine({
                mtp, warm, batch,
                onEvent: (type, detail) => sendSnapshot(type, detail),
            });
            return { wire: wire === 'bc' ? 'bc' : 'rtc' };
        },

        // `invite` is { secret, model, overrideToken }, not a room: openRoom()
        // returns a frozen object whose seal/verify close over a
        // non-extractable CryptoKey, which cannot be cloned. crypto.subtle is
        // available here, so the room is derived on this side and the page
        // keeps only its tag and historyTag (see the snapshot).
        async connect({ invite, relayOnly, chats, sessions, ctx, server }) {
            const room = await openRoom(invite?.secret ?? null,
                { model: invite?.model ?? null, overrideToken: invite?.overrideToken ?? null });
            const platform = {
                ...(server && { server }),
                ...(rtc && { RTCPeerConnection: rtc.RTCPeerConnection }),
            };
            const r = await engine.connect({ room, relayOnly, chats, sessions, ctx, platform });
            // `weightsUrl` goes back because the page tokenizes too — see
            // web/serve-client.js's connect().
            return { manifest: r.manifest, canPrompt: r.canPrompt,
                     weightsUrl: engine.baseUrl ?? null };
        },

        async serve(args) {
            const r = await engine.serve(args ?? {});
            // `cause` is an Error; the page only ever shows its message.
            return { ...r, cause: r.cause ? packError(r.cause) : null };
        },

        setVramLimit({ bytes }) {
            engine.setVramLimit(bytes ?? Infinity);
            return { vramBytes: engine.vramBytes };
        },

        stop() { engine.stop(); return null; },
        rewind({ n }) { engine.rewind(n); return null; },
        drop() { engine.drop(); return null; },

        newConversation({ conv, history }) {
            return file(conv, engine.newConversation(history ?? []));
        },
        switchTo({ conv }) { engine.switchTo(convs.get(conv)); return { conv }; },
        newChat({ conv }) { return file(conv, engine.newChat()); },
        discard({ conv }) {
            engine.discard(conv == null ? undefined : convs.get(conv));
            return null;
        },
        reset() { engine.reset(); return null; },

        seat() { return engine.net.seat(); },
        unseat() { engine.net.unseat(); return null; },
        enter({ lend }) { return engine.net.enter(lend); },

        // The page's `pagehide`: a worker never gets one, and net.js reports
        // the tokens this GPU ran as the tab goes.
        pagehide() { engine?.net?.reportRan?.(); return null; },

        stats() {
            return {
                ...snap(),
                lag: lag && { count: lag.count, totalMs: Math.round(lag.totalMs),
                              maxMs: Math.round(lag.maxMs) },
            };
        },
    };

    // generate() is an async generator and the consumer stops it by breaking
    // out of the `for await` (web/turn.js). So it is not a command: tokens are
    // streamed as they come, and a `genreturn` from the page finalizes the
    // generator the same way a break does.
    async function runGenerate(id, text, opts) {
        const it = engine.generate(text, opts)[Symbol.asyncIterator]();
        gen = { id, it };
        try {
            for (;;) {
                const { value, done } = await it.next();
                if (done || gen?.id !== id) break;
                // ctxLen is read per token by the page (peer.js's token
                // counter), so it rides along rather than forcing a snapshot.
                post({ t: 'tok', id, chunk: value, ctxLen: engine.ctxLen });
            }
            post({ t: 'gend', id, ok: true, snap: snap() });
        } catch (err) {
            post({ t: 'gend', id, ok: false, err: packError(err),
                   snap: snap() });
        } finally {
            if (gen?.id === id) gen = null;
        }
    }

    async function handle(msg) {
        const m = msg;
        if (m.t === 'rtc') { rtc?.handle(m); return; }
        if (m.t === 'gen') { runGenerate(m.id, m.text, m.opts); return; }
        if (m.t === 'genreturn') {
            const g = gen;
            if (g?.id === m.id) {
                gen = null;
                // stop() first, then finalize. The page has stopped consuming,
                // which is what stop() means — and it is also what unblocks
                // this: runGenerate always has a next() in flight, and an
                // async generator queues return() behind it, so a generator
                // suspended waiting for a token that is no longer coming would
                // never run its cleanup. Halting the loop ends that wait, the
                // generator runs its own finally (halt, then drain the tokens
                // already fed), and return() resolves after it.
                //
                // Breaking out of the loop in the page is not itself a stop
                // (web/turn.js breaks at a stop sequence and reads
                // lastStopReason only when it has no reason of its own), so
                // nothing reads the reason this sets.
                try { engine.stop(); } catch { /* not generating any more */ }
                try { await g.it.return(); } catch { /* already sent as gend */ }
            }
            // Answered only now, and with a fresh snapshot, because the page
            // is waiting on this: web/turn.js reads `lastFed` and calls
            // rewind() the moment its loop ends, and both have to see the
            // settled context. A `break` on this side awaits return() before
            // the next line runs, so the page's must too.
            post({ t: 'returned', id: m.id, snap: snap() });
            return;
        }
        if (m.t !== 'cmd') return;
        try {
            const fn = commands[m.name];
            if (!fn) throw new Error(`unknown command ${m.name}`);
            const value = await fn(m.args ?? {});
            post({ t: 'res', id: m.id, ok: true, value,
                   snap: snap() });
        } catch (err) {
            post({ t: 'res', id: m.id, ok: false, err: packError(err),
                   snap: snap() });
        }
    }

    return { handle };
}
