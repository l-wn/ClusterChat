// The page's half of web/rtc-proxy.js: the real RTCPeerConnections.
//
// This is all that is left of the mesh on the main thread. It creates no
// policy and reads no state of its own — the worker's net.js decides who to
// link to, seals the SDP and frames every message; this file only does the
// one thing a worker cannot, and reports what happened.
//
// The `bufferedAmount` of each link is written into the shared array as it
// changes, because the worker reads it synchronously on the hot path (net.js's
// send() and buffered(), route.js's ack timer). Nothing else here is on a
// per-job path except forwarding the frames themselves.

// How often the queued bytes of a draining channel are re-read. SCTP reports
// no event as it drains below the low-water mark, only when it crosses it, and
// a reading is two property reads — far less than the fragmenting this thread
// used to do per job.
const DRAIN_MS = 20;

// Channel ids the page allocates, for a datachannel the far end opened. The
// worker counts up from 1, so counting down from -1 keeps the two apart with
// no handshake.
let pageSeq = 0;

export function installRtcHost({ post, buffered = null }) {
    const pcs = new Map();           // id -> { pc, slot, channels:Set }
    const chans = new Map();         // id -> { ch, pcId }
    let drain = null;

    const reply = (id, ok, value, err) =>
        post({ t: 'rtc', op: 'reply', id, ok, value, err: err && { message: err.message } });

    // The queued bytes of one channel, into shared memory if there is any and
    // alongside the next event either way, so the worker's estimate resets to
    // the truth whenever anything happens on the link.
    function level(entry) {
        const n = entry.ch.bufferedAmount ?? 0;
        const slot = pcs.get(entry.pcId)?.slot;
        if (buffered && slot != null) Atomics.store(buffered, slot, Math.min(n, 0x7fffffff));
        return n;
    }

    // Runs only while something is queued. A link that is keeping up costs
    // nothing.
    function watchDrain() {
        if (drain != null) return;
        drain = setInterval(() => {
            let busy = false;
            const levels = [];
            for (const [id, entry] of chans) {
                const n = level(entry);
                if (n > 0) busy = true;
                levels.push([id, n]);
            }
            // Without shared memory the readings have to be pushed.
            if (!buffered && levels.length) post({ t: 'rtc', op: 'drain', levels });
            if (!busy) { clearInterval(drain); drain = null; }
        }, DRAIN_MS);
    }

    function attach(pcId, chId, ch) {
        const entry = { ch, pcId };
        chans.set(chId, entry);
        pcs.get(pcId)?.channels.add(chId);
        ch.binaryType = 'arraybuffer';
        ch.addEventListener('open', () => {
            post({ t: 'rtc', op: 'chev', ch: chId, type: 'open', buffered: level(entry),
                   // SCTP is established by now, so its per-message limit is
                   // known. net.js's wireLimit() reads it on every send.
                   maxMessageSize: pcs.get(pcId)?.pc?.sctp?.maxMessageSize ?? null });
        });
        ch.addEventListener('close', () => {
            chans.delete(chId);
            pcs.get(pcId)?.channels.delete(chId);
            post({ t: 'rtc', op: 'chev', ch: chId, type: 'close' });
        });
        ch.addEventListener('message', (ev) => {
            // Transferred, not copied: this buffer is the page's and nothing
            // here reads it again. net.js reassembles and unpacks it on the
            // other side.
            const data = ev.data;
            if (data instanceof ArrayBuffer) {
                post({ t: 'rtc', op: 'chev', ch: chId, type: 'message', data,
                       buffered: level(entry) }, [data]);
            } else {
                // net.js drops a non-binary message itself; pass it through so
                // it keeps counting them.
                post({ t: 'rtc', op: 'chev', ch: chId, type: 'message', data });
            }
        });
        ch.addEventListener('bufferedamountlow', () => {
            post({ t: 'rtc', op: 'chev', ch: chId, type: 'low', buffered: level(entry) });
        });
        return entry;
    }

    function handle(m) {
        switch (m.op) {
        case 'new': {
            const pc = new RTCPeerConnection(m.config);
            pcs.set(m.pc, { pc, slot: m.slot, channels: new Set() });
            // `localDescription` rides along with every event, because net.js
            // gathers ICE without trickling: it sets the local description,
            // waits for gathering to end, and only then reads the description
            // back — by which point the SDP has the candidates in it. A
            // description captured when it was set carries none, and a link
            // offered with no candidates never opens.
            const state = () => ({
                iceGatheringState: pc.iceGatheringState,
                connectionState: pc.connectionState,
                iceConnectionState: pc.iceConnectionState,
                localDescription: pc.localDescription
                    ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : null,
            });
            // Every candidate is forwarded, not only the null one that ends
            // gathering, because each one grows the local description and the
            // worker's copy has to grow with it. Chrome here never reaches
            // `complete` and sends no null candidate at all: net.js's iceDone()
            // gives up after GATHER_MS and seals whatever has been gathered by
            // then, which against the real object is a live read. Forward only
            // the end of gathering and that read is frozen at the moment
            // gathering started, with no candidates in it, and no link ever
            // opens.
            pc.addEventListener('icecandidate', (e) => {
                post({ t: 'rtc', op: 'pcev', pc: m.pc, type: 'icecandidate',
                       candidate: e.candidate ? { candidate: e.candidate.candidate } : null,
                       ...state() });
            });
            for (const type of ['icegatheringstatechange', 'connectionstatechange',
                                'iceconnectionstatechange']) {
                pc.addEventListener(type, () =>
                    post({ t: 'rtc', op: 'pcev', pc: m.pc, type, ...state() }));
            }
            pc.addEventListener('datachannel', (e) => {
                const chId = --pageSeq;
                attach(m.pc, chId, e.channel);
                post({ t: 'rtc', op: 'dcev', pc: m.pc, ch: chId, label: e.channel.label });
            });
            return;
        }
        case 'dc': {
            const rec = pcs.get(m.pc);
            if (!rec) return;
            attach(m.pc, m.ch, rec.pc.createDataChannel(m.label, m.opts));
            return;
        }
        case 'call': {
            const rec = pcs.get(m.pc);
            if (!rec) return reply(m.id, false, null, new Error('this link is gone'));
            call(rec.pc, m).then((value) => reply(m.id, true, value),
                                 (err) => reply(m.id, false, null, err));
            return;
        }
        case 'send': {
            const entry = chans.get(m.ch);
            if (!entry) return;
            try {
                entry.ch.send(m.buf);
            } catch (err) {
                // net.js guards with readyState, so this is a race with a
                // closing channel. It counts as a dropped frame there.
                post({ t: 'rtc', op: 'chev', ch: m.ch, type: 'error',
                       err: { message: err.message } });
            }
            level(entry);
            watchDrain();
            return;
        }
        case 'chclose': {
            chans.get(m.ch)?.ch.close();
            return;
        }
        case 'close': {
            const rec = pcs.get(m.pc);
            if (!rec) return;
            for (const id of rec.channels) chans.delete(id);
            pcs.delete(m.pc);
            if (buffered && rec.slot != null) Atomics.store(buffered, rec.slot, 0);
            try { rec.pc.close(); } catch { /* already gone */ }
            return;
        }
        default:
            return;
        }
    }

    async function call(pc, { method, arg }) {
        switch (method) {
        case 'createOffer': {
            const d = await pc.createOffer();
            return { type: d.type, sdp: d.sdp };
        }
        case 'createAnswer': {
            const d = await pc.createAnswer();
            return { type: d.type, sdp: d.sdp };
        }
        case 'setLocalDescription':
            await pc.setLocalDescription(arg);
            // Read here, because net.js reads `localDescription` on the line
            // after this resolves.
            return { localDescription: pc.localDescription
                ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : null };
        case 'setRemoteDescription':
            await pc.setRemoteDescription(arg);
            return null;
        case 'addIceCandidate':
            await pc.addIceCandidate(arg);
            return null;
        case 'getStats': {
            // An RTCStatsReport is a live Map of host objects. net.js wants
            // only the nominated candidate pair and its two candidates, but it
            // walks the report to find them, so the whole thing goes over as
            // plain entries.
            const report = await pc.getStats();
            const out = [];
            for (const [id, r] of report) out.push([id, { ...r }]);
            return out;
        }
        default:
            throw new Error(`unknown peer connection method ${method}`);
        }
    }

    return { handle, stop() { if (drain != null) clearInterval(drain); drain = null; } };
}
