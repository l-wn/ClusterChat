// The page's view of the serving peer, which runs in a worker.
//
// `EngineClient` has the shape of web/engine.js's `Engine`, so web/peer.js and
// web/dev/harness.js drive it the same way they drove the Engine directly, and
// web/turn.js's runTurn() works against it unchanged. What it does not have is
// the Engine: that, the signaling socket, the router and the GPU all live in
// web/serve-host.js, on the other side of a postMessage.
//
// The getters are synchronous because the worker pushes a snapshot of
// everything the page reads with every event it sends — which is already how
// the UI got its data (onChange → re-render). The methods are async because
// they are calls across a thread. Three things need more than that:
//
//   generate()        an async generator whose consumer stops it by breaking
//                     out of the loop (web/turn.js), so a break has to reach
//                     the worker and finalize the generator there
//   conversations     route.js's objects stay in the worker; the page holds ids
//   capacityFor()     web/welcome.js calls it synchronously while it renders,
//                     so the answers come over as a table
//
// `new Worker` happens in start(), never at module scope and never in
// web/engine.js: cli/ bundles the Engine for Node, where there is no Worker,
// and never serves.

import { makeBufferedArray, unpackError } from './serve-protocol.js';
import { installRtcHost } from './rtc-host.js';
import { source as tokenizerSource } from './model/tokenizer.js';

// A snapshot before the worker has sent one. Every field reads as "nothing
// yet", which is what the page showed before connect() resolved anyway.
const EMPTY = {
    net: null, role: 'spectator', canPrompt: null, dims: null, ctxLen: 0, ctxMax: 0,
    ran: 0, vramBytes: 0, vramLimit: Infinity, blocksPerSec: null, lastStopReason: null,
    lastPromptTokens: 0, lastFed: 0, lastProfile: null, meshTag: null, manifest: null,
    conversation: null, history: new Uint32Array(0), runner: null, capacity: null,
};

// The `net` the page reads. Its roster and scalars are the snapshot's; its
// three methods ask the worker, because each one is a request to the signaling
// server and the page already awaits them.
class NetView {
    constructor(client) { this.c = client; }

    seat() { return this.c.call('seat'); }
    unseat() { return this.c.call('unseat'); }
    enter(lend) { return this.c.call('enter', { lend }); }
}

for (const k of ['id', 'peers', 'people', 'maxPeople', 'positions', 'blocks', 'minBlocks',
                 'sessions', 'maxChats', 'ctx', 'online', 'connected', 'trouble', 'refused',
                 'idled', 'full', 'staffed', 'redundancy', 'authFailures', 'relay',
                 'relayOnly', 'weightsUrl', 'linking', 'me', 'readyPeers', 'coverage',
                 'transports', 'links', 'open', 'room']) {
    Object.defineProperty(NetView.prototype, k, {
        get() { return this.c.snap.net?.[k] ?? null; },
    });
}

export class EngineClient {
    #worker = null;
    #rtc = null;
    #buffered = null;
    #onEvent;
    #opts;
    #seq = 0;
    #waiting = new Map();
    #gens = new Map();
    #net = new NetView(this);
    #started = null;
    #convSeq = 0;

    snap = EMPTY;

    // The same options Engine takes, plus `wire`: 'bc' swaps the datachannel
    // for a BroadcastChannel inside the worker (tools/mesh.gpu.test.mjs's
    // --wire bc), in which case no RTC crosses the boundary at all.
    constructor({ onEvent = () => {}, mtp = false, warm = true, batch = true, share = true,
                  wire = 'rtc' } = {}) {
        this.#onEvent = onEvent;
        this.#opts = { mtp, warm, batch, share, wire };
    }

    // Lazy, and the only place a Worker is constructed.
    start() {
        if (this.#started) return this.#started;
        this.#worker = new Worker(new URL('./serve-worker.js', import.meta.url),
                                  { type: 'module', name: 'clusterchat-serve' });
        this.#worker.addEventListener('message', (e) => this.#receive(e.data));
        this.#worker.addEventListener('error', (e) =>
            console.error('the serving worker failed:', e.message ?? e));
        if (this.#opts.wire !== 'bc') {
            this.#buffered = makeBufferedArray();
            this.#rtc = installRtcHost({
                post: (m, transfer) => this.#worker.postMessage(m, transfer ?? []),
                buffered: this.#buffered,
            });
        }
        // net.js reports the tokens this GPU ran as the tab goes. A worker
        // never gets pagehide, so the page forwards it.
        globalThis.addEventListener?.('pagehide', () => {
            try { this.#worker.postMessage({ t: 'cmd', id: 0, name: 'pagehide' }); } catch { /* going */ }
        });
        this.#started = this.call('init', { ...this.#opts, buffered: this.#buffered });
        return this.#started;
    }

    // --- The bridge ---

    call(name, args = {}) {
        const id = ++this.#seq;
        return new Promise((resolve, reject) => {
            this.#waiting.set(id, { resolve, reject });
            this.#worker.postMessage({ t: 'cmd', id, name, args });
        });
    }

    #receive(m) {
        if (m.t === 'rtc') { this.#rtc?.handle(m); return; }
        // Applied before anything resumes on it, so a caller reading
        // `lastFed` the line after its generator ended sees the new value.
        if (m.snap) this.snap = m.snap;
        switch (m.t) {
        case 'ev':
            try { this.#onEvent(m.type, m.detail); }
            catch (err) { console.error(`onEvent(${m.type}) threw; the page carried on:`, err); }
            return;
        case 'res': {
            const w = this.#waiting.get(m.id);
            if (!w) return;
            this.#waiting.delete(m.id);
            if (m.ok) w.resolve(m.value);
            else w.reject(unpackError(m.err));
            return;
        }
        case 'tok': {
            // ctxLen rides along with each token rather than forcing a whole
            // snapshot: the page counts tokens against the context as they
            // arrive.
            if (m.ctxLen != null) this.snap = { ...this.snap, ctxLen: m.ctxLen };
            this.#gens.get(m.id)?.push(m);
            return;
        }
        case 'gend':
        case 'returned':
            this.#gens.get(m.id)?.push(m);
            return;
        default:
            return;
        }
    }

    // --- Joining and serving ---

    // `invite` is { secret, model, overrideToken }, not a room. openRoom()
    // returns a frozen object whose seal/verify close over a non-extractable
    // CryptoKey, so it cannot be cloned; the worker derives it instead, and
    // the page keeps its tag and historyTag from the snapshot.
    async connect({ invite = null, relayOnly = true, chats = null, sessions = null,
                    ctx = null, server = null } = {}) {
        await this.start();
        const r = await this.call('connect', { invite, relayOnly, chats, sessions, ctx, server });
        // The page tokenizes as well as the worker: web/turn.js decodes here to
        // find where a stop sequence cut the reply, so it can rewind the
        // context by the right number of tokens. web/model/tokenizer.js is a
        // module, so this realm has its own copy with its own source, and the
        // Engine's tokenizerSource() call happened in the other one. Unset, it
        // falls back to whatever /checkpoint.json names — the production
        // checkpoint, not the cluster's — so a private cluster on another model
        // would cut its replies with the wrong vocabulary, and a turn that hit
        // a stop sequence would fail outright wherever that host is
        // unreachable.
        if (r?.weightsUrl) {
            try { tokenizerSource(r.weightsUrl); }
            catch (err) { console.warn('tokenizer source:', err.message); }
        }
        return { manifest: r.manifest, canPrompt: r.canPrompt };
    }

    serve(args = {}) { return this.call('serve', args); }

    async setVramLimit(bytes) {
        const r = await this.call('setVramLimit', { bytes: bytes === Infinity ? null : bytes });
        return r?.vramBytes ?? 0;
    }

    // Fire and forget: the worker's generate() polls the flag this sets, and
    // with the closed loop the tokens already fed still arrive.
    stop() { this.call('stop').catch(() => {}); }

    rewind(n) { this.#tell('rewind', { n }); }
    drop() { this.call('drop').catch(() => {}); }

    // --- Chats ---
    //
    // A conversation is route.js's object, which stays in the worker. The id
    // standing for it is minted here, so these two can answer synchronously:
    // web/peer.js builds a conversation inside attach() while it renders, and
    // making that path async would open a window where the chat on screen is
    // not yet the chat the engine would answer for. postMessage is ordered, so
    // the worker has filed the conversation before any switchTo, discard or
    // generate names it.
    newConversation(history = []) {
        const conv = ++this.#convSeq;
        this.#tell('newConversation', { conv, history: Array.from(history) });
        return conv;
    }

    newChat() {
        const conv = ++this.#convSeq;
        this.#tell('newChat', { conv });
        return conv;
    }

    switchTo(conv) { return this.#tell('switchTo', { conv }); }
    discard(conv = null) { return this.#tell('discard', { conv }); }
    reset() { return this.#tell('reset'); }

    // A call whose result nobody waits for, but whose failure must not be
    // swallowed: the Engine refuses to change chats while a reply is
    // generating, and that is worth seeing.
    #tell(name, args) {
        const p = this.call(name, args);
        p.catch((err) => console.warn(`${name}:`, err));
        return p;
    }

    // --- Generating ---

    // The worker streams tokens as they come. Breaking out of this loop — how
    // web/turn.js ends a turn at a stop sequence — runs the `finally`, which
    // tells the worker to finalize its generator exactly as a local break
    // would have, and waits for it to say it has.
    //
    // That wait matters. Against the Engine directly, a `break` awaits the
    // generator's own `finally`, which halts the closed loop and drains the
    // tokens already fed before the next line runs — and the next lines read
    // `lastFed` and rewind the context by it. Without waiting here, that read
    // would come off a snapshot taken before the drain and rewind the wrong
    // number of tokens, leaving the next turn conditioned on text nobody saw.
    async *generate(text, opts = {}) {
        const id = ++this.#seq;
        const q = makeQueue();
        this.#gens.set(id, q);
        this.#worker.postMessage({ t: 'gen', id, text, opts });
        let ended = false;
        try {
            for (;;) {
                const m = await q.next();
                if (m.t === 'tok') { yield m.chunk; continue; }
                ended = true;
                if (!m.ok) throw unpackError(m.err);
                return;
            }
        } finally {
            if (!ended) {
                this.#worker.postMessage({ t: 'genreturn', id });
                // The reply carries the settled snapshot; #receive applies it.
                for (;;) {
                    const m = await q.next();
                    if (m.t === 'returned' || m.t === 'gend') break;
                }
            }
            this.#gens.delete(id);
        }
    }

    // --- Read-only state, for the page's rendering ---

    get net() { return this.snap.net ? this.#net : null; }
    get runner() { return this.snap.runner; }
    get role() { return this.snap.role; }
    get canPrompt() { return this.snap.canPrompt; }
    get dims() { return this.snap.dims; }
    get ctxLen() { return this.snap.ctxLen; }
    get ctxMax() { return this.snap.ctxMax; }
    get ran() { return this.snap.ran; }
    get vramBytes() { return this.snap.vramBytes; }
    get vramLimit() { return this.snap.vramLimit; }
    get blocksPerSec() { return this.snap.blocksPerSec; }
    get lastStopReason() { return this.snap.lastStopReason; }
    get lastPromptTokens() { return this.snap.lastPromptTokens; }
    get lastFed() { return this.snap.lastFed; }
    get lastProfile() { return this.snap.lastProfile; }
    get meshTag() { return this.snap.meshTag; }
    get manifest() { return this.snap.manifest; }
    get conversation() { return this.snap.conversation; }
    get history() { return this.snap.history; }

    // web/welcome.js calls this while it renders, so it answers from the table
    // the worker sent. The lending slider offers whole gigabytes and one stop
    // past them meaning no limit (web/lend.js, whose `value` reads Infinity
    // there), which is every value this is ever asked for; the last entry is
    // that stop.
    capacityFor(bytes) {
        const table = this.snap.capacity;
        if (!table) return 0;
        if (!Number.isFinite(bytes)) return table[table.length - 1] ?? 0;
        const gb = Math.round(bytes / 2 ** 30);
        return table[Math.min(Math.max(gb, 0), table.length - 2)] ?? 0;
    }

    // The worker's own state, for web/dev/harness.js. Includes `lag`, the
    // event-loop stalls on that side: the page's longtask observer cannot see
    // them, because `longtask` entries are per-realm.
    stats() { return this.call('stats'); }
}

// A one-reader queue over the messages of one generate().
function makeQueue() {
    const items = [];
    let wake = null;
    return {
        push(m) {
            items.push(m);
            const w = wake;
            wake = null;
            w?.();
        },
        async next() {
            while (!items.length) await new Promise((res) => { wake = res; });
            return items.shift();
        },
    };
}
