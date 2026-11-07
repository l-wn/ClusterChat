// The create page (create.html): start a private cluster. The model bar
// previews how much of the model this tab would hold at the amount on the
// slider; nobody else is in the cluster yet, so the preview grows outwards
// from the middle. "Create cluster" saves the choices, makes the invite and
// opens the chat in it, past the pre-join screen.
//
// The models on offer are checkpoint.json's `models`. The chosen one goes in
// the invite link (`&model=<id>`, web/room.js), so the cluster keeps it even
// after the signaling server restarts.

import { newSecret, cleanName, nameKey, creatorKey, chatsKey, ctxKey, snapsKey, LEGACY_MODEL } from './room.js';
import { storedBytes, costDims, modelBytes, CONTEXTS, DEFAULT_CTX, SNAP_SLOTS } from './split.js';
import { saveChoice, joinedKey } from './welcome.js';
import { lendSlider, previewRange, cellsFor } from './lend.js';

// What one tab spends on the GPU before it holds any piece (its working
// memory and the larger end table), roughly as engine.js's #capacity()
// charges it.
const FIXED_GB = 1.2;

const $ = (id) => document.getElementById(id);
let model = { L: 66, gb: 27 };      // replaced by the chosen checkpoint's numbers
let dims = null;                    // the chosen checkpoint's, for pricing each context
let chosen = LEGACY_MODEL;          // the chosen model's id
// Every model offered: { id, name, dims, L }, dims null until its manifest
// has loaded.
let offered = [];

// The shared prefix slots chosen, which every GB figure on this page has to
// price: each slot keeps one recurrent state per linear block, so going from
// 12 to 48 adds gigabytes across a hybrid model.
const snapsNow = () => Number($('snaps').value) || SNAP_SLOTS;

// The chat lengths a cluster can have, with what the whole model then takes.
const k = (n) => `${n / 1024}K`;
function fillCtx() {
    const sel = $('ctx'), at = Number(sel.value) || DEFAULT_CTX;
    sel.replaceChildren(...CONTEXTS.filter((n) => !dims?.n_pos || n <= dims.n_pos).map((n) => {
        const gb = dims && modelBytes(dims, { nMax: n, snaps: snapsNow() }) / 2 ** 30;
        const o = new Option(`${k(n)} tokens${gb ? `, about ${Math.round(gb)} GB in all` : ''}`, String(n));
        o.selected = n === at;
        return o;
    }));
}
fillCtx();
$('ctx').addEventListener('change', () => { setModelSize(); render(slider.value); });
// The slot count moves the same figures the chat length does, so it redraws
// the same three things, the context list included.
$('snaps').addEventListener('change', () => {
    fillCtx();
    setModelSize();
    render(slider.value);
});

// The model's size at the chosen context: weights plus every block's KV.
// Every tile shows its own model's, at that context or its longest.
function setModelSize() {
    const ctx = Number($('ctx').value) || DEFAULT_CTX;
    const gbOf = (d) => modelBytes(d, { nMax: Math.min(ctx, d.n_pos || ctx),
                                       snaps: snapsNow() }) / 2 ** 30;
    for (const m of offered) {
        const need = document.querySelector(`[data-need="${m.id}"]`);
        if (m.dims && need) need.textContent = `${Math.round(gbOf(m.dims))} GB`;
    }
    if (!dims) return;
    model.gb = gbOf(dims);
    const fallback = $('modelNeed');
    if (fallback) fallback.textContent = `${Math.round(model.gb)} GB`;
}

function render(gb) {
    const { L } = model;
    const cells = cellsFor($('previewBar'), L);
    const n = Math.max(0, Math.min(L, Math.floor((gb - FIXED_GB) / (model.gb / L))));
    const [lo, hi] = previewRange([], new Int32Array(L), L, 1, n) ?? [0, 0];
    cells.forEach((c, x) => { c.dataset.state = x >= lo && x < hi ? 'you' : 'empty'; });
    const pct = Math.round(((hi - lo) / L) * 100);
    // Only the percentage until a manifest gives the sizes.
    $('modelPct').textContent = !dims ? `${pct}%`
        : `${pct}% (${Math.round(((hi - lo) / L) * model.gb)}/${Math.round(model.gb)} GB)`;
    $('previewBar').classList.toggle('full', hi - lo === L);
    $('previewCaption').textContent = !gb ? ''
        : pct >= 100 ? 'You would hold the whole model on your own.'
        : !dims ? `You'd hold about ${pct}%. Invite people to lend the rest.`
        : `You'd hold about ${pct}%. Invite people to lend the rest, about ${Math.ceil(model.gb * (1 - pct / 100))} GB.`;
}

// Lending starts at 0: the visitor chooses to give some.
const slider = lendSlider({
    bar: $('lendBar'), fill: $('lendYou'), handle: $('lendHandle'), out: $('lendOut'),
    value: 0, onChange: render,
});
render(slider.value);


// Without checkpoint.json, the page's own tile keeps its rough figure.
function noSizes() {
    $('modelNeed').textContent = '27 GB';
}

// Make model `id` the cluster's: its size, piece count and context lengths.
function choose(id) {
    const m = offered.find((x) => x.id === id);
    if (!m) return;
    chosen = id;
    $('modelLabel').textContent = m.name;
    // A model whose manifest did not load shows percentages only.
    dims = m.dims;
    if (m.dims) model = { L: m.L, gb: model.gb };
    fillCtx();
    setModelSize();
    render(slider.value);
}

// A tile for each model checkpoint.json offers, replacing the page's own
// (Qwen3.8-27B), which stays if the file cannot be read.
function showModels() {
    const tiles = offered.map((m) => {
        const label = document.createElement('label');
        label.className = 'model-option';
        const input = Object.assign(document.createElement('input'),
            { type: 'radio', name: 'model', value: m.id, checked: m.id === chosen });
        input.addEventListener('change', () => input.checked && choose(m.id));
        const name = Object.assign(document.createElement('span'),
            { className: 'model-option-name', textContent: m.name });
        const meta = Object.assign(document.createElement('span'), { className: 'model-option-meta' });
        const need = Object.assign(document.createElement('b'), { textContent: '…' });
        need.dataset.need = m.id;
        meta.append('Needs about ', need, ' across your group');
        label.append(input, name, meta);
        return label;
    });
    $('modelList').replaceChildren(...tiles);
}

(async () => {
    let cfg;
    try {
        cfg = await (await fetch('/checkpoint.json')).json();
    } catch (err) {
        console.info('create: using the default model size', err);
        noSizes();
        return;
    }
    const list = Array.isArray(cfg.models) && cfg.models.length ? cfg.models
        : [{ id: LEGACY_MODEL, name: 'Qwen3.8-27B', url: cfg.url }];
    offered = list.filter((m) => typeof m?.id === 'string' && typeof m.url === 'string')
        .map((m) => ({ id: m.id, name: m.name ?? m.id, url: m.url.replace(/\/$/, ''), dims: null, L: 0 }));
    if (!offered.length) return noSizes();
    chosen = offered.some((m) => m.id === LEGACY_MODEL) ? LEGACY_MODEL : offered[0].id;
    showModels();
    await Promise.all(offered.map(async (m) => {
        try {
            const man = await (await fetch(`${m.url}/manifest.json`)).json();
            if (!storedBytes(man)) return;
            m.dims = { ...costDims(man), n_pos: man.n_pos };
            m.L = man.n_layer + 2;
        } catch (err) {
            console.info(`create: no manifest for ${m.id}`, err);
        }
    }));
    choose(chosen);
    setModelSize();
})();

$('create').addEventListener('click', () => {
    const secret = newSecret();
    const gb = slider.value;
    const store = (fn) => { try { fn(); } catch { /* not kept */ } };
    store(() => sessionStorage.setItem(creatorKey(secret), '1'));
    store(() => sessionStorage.setItem(joinedKey(secret), '1'));
    // Room capacity: the cluster's limit on replies at once (blank: none).
    const cap = Number($('capacity').value);
    if (Number.isInteger(cap) && cap >= 1) store(() => sessionStorage.setItem(chatsKey(secret), String(cap)));
    store(() => sessionStorage.setItem(ctxKey(secret), $('ctx').value));
    // Shared prefix slots each peer keeps: what lets several agents prompting
    // at once reuse each other's prefill instead of repeating it.
    store(() => sessionStorage.setItem(snapsKey(secret), $('snaps').value));
    store(() => sessionStorage.setItem(nameKey(secret), cleanName($('name').value)));
    saveChoice(gb ? { contribute: true, limit: `${gb}gb` } : { contribute: false, limit: '' });
    // LEGACY_MODEL's links name no model, as every link did before there
    // was a choice (web/room.js).
    location.href = `/chat#mesh=${secret}${chosen !== LEGACY_MODEL ? `&model=${chosen}` : ''}`;
});
