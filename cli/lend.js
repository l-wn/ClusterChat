// This machine's GPU in the cluster: start lending, follow the engine as it
// downloads and grows, and keep the numbers the status line shows.
//
// The engine does the work (web/engine.js serve() and #growClaim()). This
// file turns its events into log lines and a state, and measures tokens per
// second. Growth stops at the VRAM limit, and a raised limit wakes it again.

import { describeRange, positions } from '../web/split.js';
import { classify } from '../web/errors.js';
import { size } from './vram.js';

const GB = 2 ** 30;

// `log(text, { error })` writes a line. `onChange()` asks for a redraw.
// `downloads` is cache.js's { hit, fetched } counts, to say where the weights came from.
// `onLit()` is called the moment lending begins, for the box's light-up.
export function makeLender(engine, { log = () => {}, onChange = () => {}, downloads = null, onLit = () => {} } = {}) {
    // off -> starting -> lending | failed. `progress` is the last progress
    // text while starting (shown pinned, not logged: there are many).
    // `rates` is the last minute of tok/s samples, for the sparkline.
    const state = { phase: 'off', progress: null, fraction: null, since: null, rate: 0, rates: [], note: null, litAt: null };
    let lastRan = 0, lastAt = 0, timer = null;

    const sample = () => {
        const now = Date.now(), ran = engine.ran;
        if (lastAt) {
            const r = (ran - lastRan) / ((now - lastAt) / 1000);
            state.rate = state.rate * 0.7 + r * 0.3;      // smoothed, so one busy second does not jump
            state.rates.push(state.rate);
            if (state.rates.length > 120) state.rates.shift();
        }
        lastRan = ran;
        lastAt = now;
    };

    return {
        state,
        // Engine events, as join()'s onEvent gets them. Ignored until start().
        event(type, d) {
            if (state.phase === 'off') return;
            if (type === 'progress' && d.text) {
                state.progress = d.text;
                state.fraction = d.fraction ?? null;
                onChange();
            } else if (type === 'status' && d.text) {
                // As the page words them (web/peer.js). Retries and the
                // MTP head are left out, as there.
                const said = {
                    limit: () => `reached the ${Math.round(d.limit / GB)} GB limit · → to lend more`,
                    'limit-room': () => 'the limit has room again: growing',
                    'grow-stopped': () => classify(d.cause, '') === 'GPU_FULL'
                        ? 'the GPU is full. It keeps lending what it holds.' : d.text,
                    ceiling: () => d.text,
                    whole: () => 'holding the whole model',
                    'gpu-lost': () => d.text,
                    'gpu-recovering': () => 'the GPU ran out of memory. Reloading a smaller part of the model…',
                    'gpu-recovered': () => 'lending again, with less of the model',
                    'gpu-error': () => d.text,
                }[d.code];
                if (said) log(said(), { error: /^gpu-(lost|error)$/.test(d.code) });
                if (/^(whole|limit|ceiling|grow-stopped)$/.test(d.code)) { state.progress = null; state.fraction = null; }
                if (d.code === 'gpu-lost') state.phase = 'failed';
                onChange();
            } else if (type === 'grow') {
                log(`grew to ${size(engine.vramBytes)}`);
            }
        },

        // Resolves once the first claim is held (or lending failed). Growth
        // goes on in the background.
        async start(limitBytes) {
            engine.setVramLimit(limitBytes);
            state.phase = 'starting';
            state.progress = 'checking this GPU…';
            onChange();
            const before = downloads && { ...downloads };
            const r = await engine.serve({});
            if (r.role !== 'worker') {
                state.phase = 'failed';
                state.note = r.cause?.message ?? r.note;
                log(`could not lend: ${state.note}`, { error: true });
                onChange();
                return r;
            }
            state.phase = 'lending';
            state.since = Date.now();
            state.litAt = Date.now();
            state.progress = null;
            onLit();
            lastRan = engine.ran;
            lastAt = Date.now();
            timer = setInterval(() => { sample(); onChange(); }, 1000).unref();
            const hit = before ? downloads.hit - before.hit : 0, got = before ? downloads.fetched - before.fetched : 0;
            const from = !hit ? '' : !got ? ' · all from the cache' : ` · ${size(got)} downloaded, ${size(hit)} from the cache`;
            log(`lending ${size(engine.vramBytes)}${from}`);
            onChange();
            return r;
        },

        setLimit(bytes) { engine.setVramLimit(bytes); onChange(); },

        stop() { clearInterval(timer); state.phase = 'off'; },

        // What the status line and /clusterchat show.
        get stats() {
            const r = engine.runner;
            const L = engine.dims?.n_layer;
            return {
                phase: state.phase,
                bytes: engine.vramBytes,
                limit: engine.vramLimit,
                held: r ? [r.lo, r.have] : null,
                range: r && L ? describeRange(r.lo, r.have, L) : null,
                share: r && L ? (r.have - r.lo) / positions(L) : 0,
                ran: engine.ran,
                rate: state.rate,
                since: state.since,
            };
        },
    };
}
