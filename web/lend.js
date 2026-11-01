// The lending slider and the model bar's preview, shared by the pre-join
// screen (welcome.js) and the create page (create.js).

import { place } from './split.js';

export const MAX_GB = 32;          // the most the slider offers
export const DEFAULT_GB = 4;

// "4gb" -> 4. Blank (no limit) and anything unreadable -> null.
export function limitGb(limit) {
    const m = /^(\d+(?:\.\d+)?)\s*(gb|gib)?$/i.exec(String(limit ?? '').trim());
    return m ? Math.round(Number(m[1])) : null;
}

// The range a new tab ends up holding with `n` pieces: the server's place()
// for the minimum claim, then growth toward the side with fewer copies,
// alternating when both sides have the same (as engine.js's #growClaim()).
// `held` is the copies of each piece that can run now.
export function previewRange(claims, held, L, floor, n) {
    const f = Math.min(Math.max(1, floor || 1), L);
    if (n < f) return null;
    let lo = place(claims, f, L), hi = lo + f, side = 'left';
    while (hi - lo < n) {
        const canLeft = lo > 0, canRight = hi < L;
        if (!canLeft && !canRight) break;
        const left = canLeft ? held[lo - 1] : Infinity;
        const right = canRight ? held[hi] : Infinity;
        const dir = !canLeft ? 'right' : !canRight ? 'left'
            : left < right ? 'left' : right < left ? 'right' : side;
        if (dir === 'left') lo--; else hi++;
        side = dir === 'left' ? 'right' : 'left';
    }
    return [lo, hi];
}

// One cell per piece in `bar`, rebuilt when the count changes.
export function cellsFor(bar, L) {
    if (bar.childElementCount !== L) {
        bar.replaceChildren(...Array.from({ length: L }, (_, x) => {
            const cell = document.createElement('i');
            cell.style.setProperty('--i', x);        // its place in the full-bar wave
            return cell;
        }));
        bar.style.setProperty('--n', L);
    }
    return [...bar.children];
}

// Wire a slider: `bar` the track, `fill` the part up to the value, `handle`
// the knob (role="slider"), `out` the number shown. Drag or click the track,
// or use the arrow keys on the handle. Calls onChange(gb) on every change.
// lock() pins it to the low end for good, for a browser that can't lend.
//
// `lo` is the lowest amount offered. The pre-join screens start at 0, which
// means "don't lend"; the Your GPU drawer starts at 1, because stopping is
// its own button there.
//
// `open` adds one stop past MAX_GB meaning "no limit": keep growing until the
// GPU is full. `value` reads Infinity there, which is what parseByteLimit()
// gives for a blank limit, so a caller can pass it straight on.
export function lendSlider({ bar, fill, handle, out, value = DEFAULT_GB,
                             lo = 0, open = false, onChange = () => {} }) {
    const hi = MAX_GB + (open ? 1 : 0);      // the top stop, "no limit" if open
    const clamp = (v) => Math.max(lo, Math.min(hi, Math.round(v)));
    const unlimited = () => open && gb > MAX_GB;
    const label = () => (unlimited() ? 'No limit' : gb ? `${gb} GB` : 'None');
    let gb = clamp(value === Infinity ? hi : value);
    let locked = false;
    const show = () => {
        out.textContent = label();
        fill.style.width = `${((gb - lo) / (hi - lo)) * 100}%`;
        handle.setAttribute('aria-valuemin', String(lo));
        handle.setAttribute('aria-valuemax', String(hi));
        handle.setAttribute('aria-valuenow', String(gb));
        handle.setAttribute('aria-valuetext', unlimited() ? 'no limit' : gb ? `${gb} GB` : 'none');
    };
    // `notify` is false when the value is being brought in from elsewhere (the
    // drawer's backing field), so syncing cannot loop back into onChange.
    const apply = (v, notify = true) => {
        if (locked) return;
        const next = clamp(v);
        if (next === gb) return;
        gb = next;
        show();
        if (notify) onChange(gb);
    };
    const fromPointer = (e) => {
        const r = bar.getBoundingClientRect();
        apply(lo + ((e.clientX - r.left) / r.width) * (hi - lo));
    };
    bar.addEventListener('pointerdown', (e) => {
        bar.setPointerCapture(e.pointerId);
        bar.classList.add('dragging');
        fromPointer(e);
        handle.focus({ preventScroll: true });
    });
    bar.addEventListener('pointermove', (e) => { if (bar.hasPointerCapture(e.pointerId)) fromPointer(e); });
    const stop = () => bar.classList.remove('dragging');
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 4, PageDown: -4 }[e.key];
        if (step) { e.preventDefault(); apply(gb + step); }
        else if (e.key === 'Home') { e.preventDefault(); apply(lo); }
        else if (e.key === 'End') { e.preventDefault(); apply(hi); }
    });
    show();
    return {
        get value() { return unlimited() ? Infinity : gb; },
        // Bring the knob to a value decided elsewhere, without calling back.
        set(v) { apply(v === Infinity ? hi : v, false); },
        lock() {
            apply(lo);
            locked = true;
            bar.classList.add('locked');
            handle.setAttribute('aria-disabled', 'true');
            handle.tabIndex = -1;
        },
    };
}
