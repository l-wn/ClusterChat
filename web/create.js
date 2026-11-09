// The create page (create.html): start a private cluster. The card on the
// left holds the model and the graphics card memory the group needs, and
// counts up or down as options change. Every option shows its own size and
// what it would add or save against what is picked now. "Create cluster"
// saves the choices, makes the invite and opens the chat in it, past the
// pre-join screen.
//
// The models on offer are checkpoint.json's `models`. The chosen one goes in
// the invite link (`&model=<id>`, web/room.js), so the cluster keeps it even
// after the signaling server restarts.

import { newSecret, cleanName, nameKey, creatorKey, chatsKey, ctxKey, snapsKey, LEGACY_MODEL } from './room.js';
import { storedBytes, costDims, modelBytes, CONTEXTS, DEFAULT_CTX, SNAP_SLOTS, MAX_PRIVATE_SNAPS } from './split.js';
import { saveChoice, joinedKey } from './welcome.js';
import { MAX_GB } from './lend.js';

const $ = (id) => document.getElementById(id);
const GIB = 2 ** 30;
const SNAPS = [4, 12, 24, 48].filter((n) => n <= MAX_PRIVATE_SNAPS);
// What one person is assumed to lend when counting who else is needed.
const PER_PERSON_GB = 8;

// GiB per model, keyed `${ctx}_${snaps}`: modelBytes() on each manifest. These
// are the figures from the last time they were worked out, shown until the
// manifests load (or if they cannot).
const SIZES = {
    'qwen3.8-27b': { '4096_4': 29, '4096_12': 30.1, '4096_24': 31.9, '4096_48': 35.4, '8192_4': 29.3, '8192_12': 30.4, '8192_24': 32.2, '8192_48': 35.7, '16384_4': 29.8, '16384_12': 31, '16384_24': 32.7, '16384_48': 36.3, '32768_4': 30.9, '32768_12': 32.1, '32768_24': 33.9, '32768_48': 37.4 },
    'qwen3.5-4b': { '4096_4': 5.6, '4096_12': 6, '4096_24': 6.6, '4096_48': 7.8, '8192_4': 5.8, '8192_12': 6.2, '8192_24': 6.8, '8192_48': 7.9, '16384_4': 6.1, '16384_12': 6.4, '16384_24': 7, '16384_48': 8.2, '32768_4': 6.6, '32768_12': 7, '32768_24': 7.6, '32768_48': 8.8 },
};
// The words on each model's tile. A model checkpoint.json adds without an
// entry here gets its name only.
const BLURBS = {
    'qwen3.8-27b': { sub: 'Our strongest. Best for coding and agents.', tag: 'Recommended' },
    'qwen3.5-4b': { sub: 'Light and quick. One laptop can run it.' },
};
const CTX_WORDS = { 4096: 'Quick questions', 8192: 'Everyday chat', 16384: 'Long documents', 32768: 'Whole codebases' };
const SNAP_WORDS = { 4: 'Just chatting', 12: 'One agent', 24: 'A few agents', 48: 'Many agents' };
const CAPS = [
    { v: '', name: 'No limit', sub: 'As many as join' },
    { v: 2, name: '2', sub: 'chats' }, { v: 4, name: '4', sub: 'chats' }, { v: 8, name: '8', sub: 'chats' },
];

// Every model offered: { id, name, sub, tag }. The two known ones until
// checkpoint.json says otherwise.
let models = [
    { id: 'qwen3.8-27b', name: 'Qwen3.8-27B', ...BLURBS['qwen3.8-27b'] },
    { id: 'qwen3.5-4b', name: 'Qwen3.5-4B', ...BLURBS['qwen3.5-4b'] },
];
const state = { model: LEGACY_MODEL, ctx: DEFAULT_CTX, snaps: SNAP_SLOTS, cap: '' };

const k = (n) => `${n / 1024}K`;
// The chat lengths model `id` can have: the longest is its own limit.
const ctxsOf = (id) => CONTEXTS.filter((n) => SIZES[id]?.[`${n}_${SNAPS[0]}`] != null);
// A model's size at a chat length it may not reach: its longest instead.
function gb(id, ctx, snaps) {
    const t = SIZES[id];
    const fit = ctxsOf(id).filter((n) => n <= ctx).at(-1) ?? ctxsOf(id)[0];
    return t[`${fit}_${snaps}`];
}
const size = (s) => gb(s.model, s.ctx, s.snaps);
// A full bar: the biggest setup on offer.
const fullGb = () => Math.max(...models.flatMap((m) => Object.values(SIZES[m.id])));

// One radio tile. Its price fills in on every render.
function card(group, o) {
    const el = document.createElement('label');
    el.className = 'choice' + (group === 'model' ? ' model' : '');
    el.dataset.group = group;
    el.dataset.value = o.v;
    const input = Object.assign(document.createElement('input'),
        { type: 'radio', name: group, value: String(o.v), checked: String(state[group]) === String(o.v) });
    input.addEventListener('change', () => {
        state[group] = group === 'model' || group === 'cap' ? o.v : Number(o.v);
        if (group === 'model') showCtx();
        render();
    });
    const info = Object.assign(document.createElement('span'), { className: 'info' });
    if (o.tag) info.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: o.tag }));
    info.append(Object.assign(document.createElement('span'), { className: 'name', textContent: o.name }));
    if (o.sub) info.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: o.sub }));
    el.append(input, info);
    if (group !== 'cap') {
        const price = Object.assign(document.createElement('span'), { className: 'price' });
        price.dataset.price = '';
        el.append(price);
    }
    return el;
}

function showModels() {
    $('models').replaceChildren(...models.map((m) => card('model', { v: m.id, name: m.name, sub: m.sub, tag: m.tag })));
}
// The chat lengths the chosen model can have; a longer pick drops to its longest.
function showCtx() {
    const offered = ctxsOf(state.model);
    if (!offered.includes(state.ctx)) state.ctx = offered.filter((n) => n <= state.ctx).at(-1) ?? offered[0];
    $('ctx').replaceChildren(...offered.map((n) => card('ctx',
        { v: n, name: k(n), sub: CTX_WORDS[n] ?? '', tag: n === DEFAULT_CTX ? 'Popular' : '' })));
}
function showSnaps() {
    $('snaps').replaceChildren(...SNAPS.map((n) => card('snaps',
        { v: n, name: String(n), sub: SNAP_WORDS[n] ?? '', tag: n === SNAP_SLOTS ? 'Popular' : '' })));
}
showModels();
showCtx();
showSnaps();
$('cap').replaceChildren(...CAPS.map((o) => card('cap', o)));

// What an option is on its own (the model's weights, or what that chat
// length or prefix count adds over the smallest), and what picking it would
// change, in brackets.
function priceCards() {
    const now = size(state);
    const own = (g, v) => {
        const id = g === 'model' ? v : state.model, low = ctxsOf(id)[0];
        if (g === 'model') return gb(id, low, SNAPS[0]);
        if (g === 'ctx') return gb(id, v, SNAPS[0]) - gb(id, low, SNAPS[0]);
        return gb(id, state.ctx, v) - gb(id, state.ctx, SNAPS[0]);
    };
    document.querySelectorAll('[data-price]').forEach((p) => {
        const el = p.closest('.choice'), g = el.dataset.group;
        const v = g === 'model' ? el.dataset.value : Number(el.dataset.value);
        const d = size({ ...state, [g]: v }) - now, o = own(g, v);
        p.classList.remove('more', 'less');
        let rel = '';
        if (String(state[g]) !== String(v)) {
            if (Math.abs(d) < 0.05) rel = '(+0 GB)';
            else { rel = `(${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} GB)`; p.classList.add(d > 0 ? 'more' : 'less'); }
        }
        p.replaceChildren(
            Object.assign(document.createElement('span'), { className: 'rel', textContent: rel }),
            Object.assign(document.createElement('span'), { className: 'abs', textContent: o >= 0.05 ? `${o.toFixed(1)} GB` : '' }));
    });
}

// Count the big number from where it was to where it is going.
let shown = size(state), raf = 0;
function tweenTo(target) {
    cancelAnimationFrame(raf);
    const from = shown, t0 = performance.now(), dur = 500;
    const step = (t) => {
        const p = Math.min(1, (t - t0) / dur), e = 1 - (1 - p) ** 3;
        shown = from + (target - from) * e;
        $('num').textContent = shown.toFixed(1);
        $('miniNum').textContent = `${shown.toFixed(1)} GB`;
        if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
}

let last = size(state);
function render() {
    const total = size(state), low = ctxsOf(state.model)[0];
    const base = gb(state.model, low, SNAPS[0]);
    const withCtx = gb(state.model, state.ctx, SNAPS[0]);
    const ctxAdd = withCtx - base, snapAdd = total - withCtx;
    const name = models.find((m) => m.id === state.model)?.name ?? state.model;

    $('boxModel').textContent = $('miniModel').textContent = name;
    $('stack').style.width = `${(total / fullGb()) * 100}%`;
    $('segBase').style.flexGrow = base;
    $('segCtx').style.flexGrow = ctxAdd;
    $('segSnap').style.flexGrow = snapAdd;
    $('lnBase').textContent = `${base.toFixed(1)} GB`;
    $('lnCtx').textContent = ctxAdd < 0.05 ? 'included' : `+ ${ctxAdd.toFixed(1)} GB`;
    $('lnSnap').textContent = snapAdd < 0.05 ? 'included' : `+ ${snapAdd.toFixed(1)} GB`;
    $('lnCtxL').textContent = k(state.ctx);
    $('lnSnapL').textContent = state.snaps;

    const d = total - last;
    if (Math.abs(d) >= 0.05) {
        const chip = $('delta');
        chip.textContent = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} GB`;
        chip.classList.toggle('down', d < 0);
        chip.classList.remove('show'); void chip.offsetWidth; chip.classList.add('show');
        const n = $('num'); n.classList.remove('bump'); void n.offsetWidth; n.classList.add('bump');
    }
    last = total;
    tweenTo(total);
    priceCards();
    renderLend();

    const cur = (key, t) => { const el = document.querySelector(`[data-cur="${key}"]`); if (el) el.textContent = t; };
    cur('models', name);
    cur('ctx', `${k(state.ctx)} tokens`);
    cur('snaps', `${state.snaps} prefixes`);
    cur('cap', state.cap ? `${state.cap} chats` : 'No limit');
    cur('name', $('name').value.trim() || 'Not set');
}

// How much of it you cover, and who else it takes: you in purple, then a
// grey person per PER_PERSON_GB still missing.
const PERSON = '<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>';
let drawn = 0;
function drawCrowd(lend, others) {
    const max = 14, n = Math.min(others, max);
    const you = `<svg viewBox="0 0 24 24" class="me${lend ? '' : ' idle'}"><title>You</title>${PERSON}</svg>`;
    const them = Array.from({ length: n }, (_, i) =>
        `<svg viewBox="0 0 24 24" class="${i >= drawn ? 'pop' : ''}">${PERSON}</svg>`).join('');
    $('crowd').innerHTML = you + them + (others > max ? `<span class="more">+${others - max}</span>` : '');
    drawn = n;
}
function renderLend() {
    const total = size(state), lend = Number($('lend').value);
    $('lendOut').textContent = lend ? `${lend} GB` : 'Nothing';
    const rest = Math.max(0, total - lend);
    const people = Math.ceil(rest / PER_PERSON_GB);
    drawCrowd(lend, people);
    $('cover').innerHTML = rest === 0
        ? '<b>You can run it all yourself.</b> Invite people to make it faster.'
        : `<b>You${lend ? '' : ' (not lending)'} + ${people} ${people === 1 ? 'person' : 'people'}</b> with ${PER_PERSON_GB} GB cards to cover the other ${rest.toFixed(1)} GB.`;
}
$('lend').max = String(MAX_GB);
$('lend').addEventListener('input', renderLend);
$('name').addEventListener('input', render);
render();

// The models checkpoint.json offers, each priced from its own manifest.
(async () => {
    let cfg;
    try {
        cfg = await (await fetch('/checkpoint.json')).json();
    } catch (err) {
        console.info('create: using the built-in model sizes', err);
        return;
    }
    const list = Array.isArray(cfg.models) && cfg.models.length ? cfg.models
        : [{ id: LEGACY_MODEL, name: 'Qwen3.8-27B', url: cfg.url }];
    const offered = list.filter((m) => typeof m?.id === 'string' && typeof m.url === 'string');
    await Promise.all(offered.map(async (m) => {
        try {
            const man = await (await fetch(`${m.url.replace(/\/$/, '')}/manifest.json`)).json();
            if (!storedBytes(man)) return;
            const dims = costDims(man), t = {};
            for (const n of CONTEXTS.filter((c) => !man.n_pos || c <= man.n_pos)) {
                for (const s of SNAPS) t[`${n}_${s}`] = modelBytes(dims, { nMax: n, snaps: s }) / GIB;
            }
            SIZES[m.id] = t;
        } catch (err) {
            console.info(`create: no manifest for ${m.id}`, err);
        }
    }));
    // A model with no size, from its manifest or the table above, is left out.
    const priced = offered.filter((m) => SIZES[m.id]);
    if (!priced.length) return;
    models = priced.map((m) => ({ id: m.id, name: m.name ?? m.id, ...BLURBS[m.id] }));
    if (!models.some((m) => m.id === state.model)) state.model = models[0].id;
    showModels();
    showCtx();
    render();
})();

function create() {
    const secret = newSecret();
    const lend = Number($('lend').value);
    const store = (fn) => { try { fn(); } catch { /* not kept */ } };
    store(() => sessionStorage.setItem(creatorKey(secret), '1'));
    store(() => sessionStorage.setItem(joinedKey(secret), '1'));
    // Chats at once: the cluster's limit on replies at once (blank: none).
    if (Number.isInteger(state.cap) && state.cap >= 1) store(() => sessionStorage.setItem(chatsKey(secret), String(state.cap)));
    store(() => sessionStorage.setItem(ctxKey(secret), String(state.ctx)));
    // Shared prefix slots each peer keeps: what lets several agents prompting
    // at once reuse each other's prefill instead of repeating it.
    store(() => sessionStorage.setItem(snapsKey(secret), String(state.snaps)));
    store(() => sessionStorage.setItem(nameKey(secret), cleanName($('name').value)));
    saveChoice(lend ? { contribute: true, limit: `${lend}gb` } : { contribute: false, limit: '' });
    // LEGACY_MODEL's links name no model, as every link did before there
    // was a choice (web/room.js).
    location.href = `/chat#mesh=${secret}${state.model !== LEGACY_MODEL ? `&model=${state.model}` : ''}`;
}
$('create').addEventListener('click', create);
$('createMini').addEventListener('click', create);
