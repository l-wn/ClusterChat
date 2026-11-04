// An RTCPeerConnection for a worker, driving the real one on the main thread.
//
// `RTCPeerConnection` is the only thing a dedicated worker cannot have:
// WebSocket, WebGPU, fetch, crypto.subtle, BroadcastChannel and timers all
// work there. So the serving peer runs in the worker whole and unchanged, and
// the page keeps nothing but the DOM and the peer connections.
//
// net.js needs no hook for this. It already takes the constructor
// (`platform.RTCPeerConnection`, used by cli/join.js for node-datachannel),
// and web/dev/bcwire.js already proves it works against a stand-in. This file
// implements the same surface bcwire does, plus the parts bcwire skips because
// it short-circuits ICE: candidate gathering, getStats and sctp.
//
// The one value that cannot wait for a round trip is `bufferedAmount`
// (web/serve-protocol.js says why), so it is read out of shared memory, or —
// where the page is not cross-origin isolated — from an estimate that is
// deliberately too high. Everything else is either mirrored from an event or
// is per link, not per job, so a round trip costs nothing that matters.

import { LINK_SLOTS } from './serve-protocol.js';

// The main thread's value is written to the shared array as SCTP drains, but
// between those writes this side has posted bytes the page has not sent yet.
// They are added in, so the number is never too low: refusing a job early is
// harmless, while overrunning the buffer makes Chrome close the channel and
// breaks every session on the link (net.js's send()).
class ChannelProxy extends EventTarget {
    constructor(bridge, pcId, chId, label, slot) {
        super();
        this.label = label;
        this.ordered = true;
        this.binaryType = 'arraybuffer';
        this.readyState = 'connecting';
        this.bufferedAmountLowThreshold = 0;
        this.maxMessageSize = null;      // from the page once SCTP is up
        this.posted = 0;                 // bytes handed over since the last report
        this.reported = 0;               // the page's last reading
        this.slot = slot;
        this.pcId = pcId;
        this.chId = chId;
        this.bridge = bridge;
    }

    get bufferedAmount() {
        const shared = this.bridge.read(this.slot);
        return (shared ?? this.reported) + this.posted;
    }

    send(buf) {
        if (this.readyState !== 'open') throw new Error('channel is not open');
        // Not transferred. fragment() returns the message unchanged when it
        // fits in one send (net.js, deliberately no copy), and route.js
        // forwards the same buffer to several candidate peers in a loop — a
        // transfer would detach it after the first one. One copy of at most
        // the wire limit per fragment, on this thread rather than the page's.
        const copy = buf instanceof ArrayBuffer
            ? buf.slice(0)
            : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        this.posted += copy.byteLength;
        this.bridge.post({ t: 'rtc', op: 'send', ch: this.chId, buf: copy }, [copy]);
    }

    close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.bridge.post({ t: 'rtc', op: 'chclose', ch: this.chId });
        this.dispatchEvent(new Event('close'));
    }
}

// Only what net.js reads: createDataChannel, createOffer/createAnswer,
// set{Local,Remote}Description, localDescription, iceGatheringState (iceDone),
// connectionState and iceConnectionState (#watch and #sync's prune), sctp
// (wireLimit, on every send), getStats (the transport readout) and close.
class PeerConnectionProxy extends EventTarget {
    constructor(bridge, config) {
        super();
        this.iceGatheringState = 'new';
        this.iceConnectionState = 'new';
        this.connectionState = 'new';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
        // Until the page reports SCTP's limit, wireLimit() falls back to
        // WIRE_DEFAULT, which is the value Chrome advertises anyway.
        this.sctp = { maxMessageSize: undefined };
        this.channel = null;
        this.bridge = bridge;
        this.pcId = bridge.nextId();
        this.slot = bridge.claim(this.pcId, this);
        bridge.post({ t: 'rtc', op: 'new', pc: this.pcId, slot: this.slot, config });
    }

    createDataChannel(label, opts) {
        const chId = this.bridge.nextId();
        const ch = new ChannelProxy(this.bridge, this.pcId, chId, label, this.slot);
        this.channel = ch;
        this.bridge.chans.set(chId, ch);
        this.bridge.post({ t: 'rtc', op: 'dc', pc: this.pcId, ch: chId, label, opts });
        return ch;
    }

    createOffer() { return this.#call('createOffer'); }
    createAnswer() { return this.#call('createAnswer'); }

    async setLocalDescription(desc) {
        // The description comes back with this, and again with every ICE
        // event, because net.js gathers without trickling: it reads
        // `localDescription` only after gathering has ended, wanting the
        // candidates that accumulated in it. Setting it here just means a
        // description exists before the first event arrives.
        const r = await this.#call('setLocalDescription', desc);
        if (r?.localDescription) this.localDescription = r.localDescription;
        return undefined;
    }

    async setRemoteDescription(desc) {
        await this.#call('setRemoteDescription', desc);
        this.remoteDescription = desc;
        return undefined;
    }

    addIceCandidate(c) { return this.#call('addIceCandidate', c); }

    // net.js reads the nominated candidate pair out of this once per link, to
    // say whether the link went direct or through the TURN relay. It wants a
    // report it can call .values() and .get(id) on, so the page sends entries
    // and they become a Map.
    async getStats() {
        const entries = await this.#call('getStats');
        return new Map(entries ?? []);
    }

    close() {
        if (this.connectionState === 'closed') return;
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.channel?.close();
        this.bridge.release(this.pcId);
        this.bridge.post({ t: 'rtc', op: 'close', pc: this.pcId });
    }

    #call(method, arg) {
        return this.bridge.call({ t: 'rtc', op: 'call', pc: this.pcId, method, arg });
    }
}

// Install the proxy. `post(msg, transfer)` sends to the main thread;
// `buffered` is the shared Int32Array, or null for the estimate. Returns the
// constructor to hand to `platform.RTCPeerConnection`, and the handler for
// what comes back.
export function installRtcProxy({ post, buffered = null }) {
    const pcs = new Map();
    const chans = new Map();
    const waiting = new Map();
    const slots = new Map();            // pcId -> slot
    const used = new Array(LINK_SLOTS).fill(false);
    let seq = 0;

    const bridge = {
        post,
        pcs,
        chans,
        nextId: () => ++seq,
        read: (slot) => (buffered && slot != null ? Atomics.load(buffered, slot) : null),

        // A link gets a slot for its bufferedAmount. The worker allocates,
        // because the worker is what creates links (net.js's #offer/#answer),
        // and frees it when the connection closes. Past LINK_SLOTS there is no
        // slot and the estimate is used, which is correct, only coarser.
        claim(pcId, pc) {
            pcs.set(pcId, pc);
            const i = used.indexOf(false);
            if (i < 0) return null;
            used[i] = true;
            if (buffered) Atomics.store(buffered, i, 0);
            slots.set(pcId, i);
            return i;
        },

        release(pcId) {
            const slot = slots.get(pcId);
            if (slot != null) used[slot] = false;
            slots.delete(pcId);
            pcs.delete(pcId);
        },

        call(msg) {
            const id = ++seq;
            return new Promise((resolve, reject) => {
                waiting.set(id, { resolve, reject });
                post({ ...msg, id });
            });
        },
    };

    function handle(m) {
        switch (m.op) {
        case 'reply': {
            const w = waiting.get(m.id);
            if (!w) return;
            waiting.delete(m.id);
            if (m.ok) w.resolve(m.value);
            else w.reject(new Error(m.err?.message ?? 'the page could not do that'));
            return;
        }
        case 'pcev': {
            const pc = pcs.get(m.pc);
            if (!pc) return;
            if (m.iceGatheringState != null) pc.iceGatheringState = m.iceGatheringState;
            if (m.connectionState != null) pc.connectionState = m.connectionState;
            if (m.iceConnectionState != null) pc.iceConnectionState = m.iceConnectionState;
            // Kept current as candidates arrive: net.js reads this after
            // waiting for gathering to end, and the candidates are in it.
            if (m.localDescription) pc.localDescription = m.localDescription;
            // iceDone() waits for the null candidate a browser sends or the
            // gathering state, whichever comes first, so both are forwarded.
            pc.dispatchEvent(Object.assign(new Event(m.type), { candidate: m.candidate ?? null }));
            return;
        }
        case 'dcev': {
            // The answering side's channel, which the page's `datachannel`
            // event brought. net.js listens for this and calls #attach.
            const pc = pcs.get(m.pc);
            if (!pc) return;
            const ch = new ChannelProxy(bridge, m.pc, m.ch, m.label, pc.slot);
            pc.channel = ch;
            chans.set(m.ch, ch);
            pc.dispatchEvent(Object.assign(new Event('datachannel'), { channel: ch }));
            return;
        }
        case 'chev': {
            const ch = chans.get(m.ch);
            if (!ch) return;
            // Every channel event carries the page's reading, so the estimate
            // resets to the truth whenever anything happens on the link.
            if (m.buffered != null) { ch.reported = m.buffered; ch.posted = 0; }
            if (m.type === 'open') {
                ch.readyState = 'open';
                // SCTP is up, so its message limit is known. wireLimit() reads
                // this on every send.
                if (m.maxMessageSize != null) {
                    const pc = pcs.get(ch.pcId);
                    if (pc) pc.sctp = { maxMessageSize: m.maxMessageSize };
                }
                ch.dispatchEvent(new Event('open'));
            } else if (m.type === 'close') {
                ch.readyState = 'closed';
                chans.delete(m.ch);
                ch.dispatchEvent(new Event('close'));
            } else if (m.type === 'message') {
                ch.dispatchEvent(Object.assign(new Event('message'), { data: m.data }));
            } else if (m.type === 'error') {
                console.warn(`link ${ch.label}: ${m.err?.message ?? 'send failed'}`);
            }
            return;
        }
        case 'drain': {
            // A periodic reading for links that are not otherwise busy, so the
            // estimate cannot drift upward while a channel quietly drains.
            // Only used without shared memory.
            for (const [chId, n] of m.levels ?? []) {
                const ch = chans.get(chId);
                if (ch) { ch.reported = n; ch.posted = 0; }
            }
            return;
        }
        default:
            return;
        }
    }

    // net.js calls `new this.#RTCPeerConnection(config)`, so the constructor
    // it gets takes only the config and closes over the bridge.
    class Proxy extends PeerConnectionProxy {
        constructor(config) { super(bridge, config); }
    }

    return { RTCPeerConnection: Proxy, handle };
}
