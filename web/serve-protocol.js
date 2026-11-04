// What the page and the serving worker say to each other.
//
// The worker (web/serve-host.js) runs the whole Engine; the page
// (web/serve-client.js) is a thin client over it. This file holds the parts
// both sides need, so neither has to import the other.
//
//   main → worker   { t: 'cmd', id, name, args }      a method call
//                   { t: 'gen', id, text, opts }      start generate()
//                   { t: 'genreturn', id }            the consumer broke out
//                   { t: 'rtc', … }                    RTC events and replies
//   worker → main   { t: 'res', id, ok, value|err, snap }
//                   { t: 'tok', id, chunk, ctxLen }
//                   { t: 'gend', id, ok, err?, snap }
//                   { t: 'ev', type, detail, snap }   an engine event
//                   { t: 'rtc', … }                    RTC instructions
//
// Every worker → main message but 'tok' and 'rtc' carries `snap`, the state
// the page reads synchronously while it renders (web/serve-host.js's
// snapshot).

import { ContextFullError } from './errors.js';

// How many links share the bufferedAmount array. A peer links only to the
// peers it needs (net.js's `wants`), so this is far above any real mesh; a
// slot is freed when its link closes.
export const LINK_SLOTS = 64;

// `link.ch.bufferedAmount` is read synchronously on the hot path — the
// high-water refusal in net.js's send() and buffered(), which route.js reads
// in plan()'s candidate filter and inside armAck's expire timer. It is a
// scalar per link that changes continuously as SCTP drains, which is the one
// thing here that earns shared memory: fixed layout, no variable length, and
// nothing to encode.
//
// An Int32Array, not a Float64Array: Atomics accepts only integer element
// types, and a byte count never needs more. Returns null where the page is not
// cross-origin isolated (COOP + COEP), in which case the proxy keeps its own
// over-estimate instead.
export function makeBufferedArray() {
    if (typeof SharedArrayBuffer !== 'function' || !globalThis.crossOriginIsolated) return null;
    try {
        return new Int32Array(new SharedArrayBuffer(LINK_SLOTS * 4));
    } catch {
        return null;         // a runtime that has the constructor but refuses it
    }
}

// An Error across postMessage. structuredClone keeps `name` and `message` but
// drops the subclass and every own property, and both carry meaning here:
// web/peer.js and web/dev/harness.js test `err instanceof ContextFullError`,
// and route.js sets `busy` on a peer's capacity refusal. `history` is
// route.js's own retry state and never leaves the worker.
export function packError(err) {
    if (err == null) return { name: 'Error', message: 'unknown failure' };
    return {
        name: err.name ?? 'Error',
        message: String(err.message ?? err),
        stack: err.stack ?? null,
        ...(err instanceof ContextFullError
            && { ctxFull: true, needed: err.needed, room: err.room }),
        ...(err.busy && { busy: true }),
        ...(err.cancelled && { cancelled: true }),
    };
}

// The counterpart. A ContextFullError is rebuilt as one so `instanceof` still
// answers, keeping the worker's message, which knew the context size.
export function unpackError(e) {
    if (e == null) return new Error('unknown failure');
    let err;
    if (e.ctxFull) {
        err = new ContextFullError(e.needed, e.room, 0);
        err.message = e.message;
    } else {
        err = new Error(e.message);
        err.name = e.name ?? 'Error';
    }
    if (e.stack) err.stack = e.stack;
    if (e.busy) err.busy = true;
    if (e.cancelled) err.cancelled = true;
    return err;
}
