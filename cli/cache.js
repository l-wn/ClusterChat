// A disk cache for what a peer downloads: the tokenizer (20 MB for Qwen, the
// one large download a chat-only peer makes) and, for a machine that lends,
// the checkpoint's weight files, gigabytes a page leaves to the browser's
// cache. Kept under $XDG_CACHE_HOME/clusterchat (or ~/.cache/clusterchat) by
// URL, and checked against the server's ETag, so a changed file is fetched
// again.
//
// Both work by wrapping fetch, so web/ code needs no changes.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'clusterchat');
const TOKENIZER = /\/tokenizer\/tokenizer\.json$/;
const WEIGHTS = /\/[^/?#]+\.bin$/;

const key = (href) => join(DIR, createHash('sha256').update(href).digest('hex').slice(0, 32));
const hrefOf = (url) => typeof url === 'string' ? url : url.href ?? url.url;
const isGet = (init) => !init?.method || init.method === 'GET';

export function cacheTokenizer() {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const href = hrefOf(url);
        if (!TOKENIZER.test(href) || !isGet(init)) return fetch(url, init);
        const file = key(href);
        const meta = await readFile(`${file}.etag`, 'utf8').catch(() => null);
        const res = await fetch(href, { ...init, headers: { ...init?.headers, ...(meta && { 'if-none-match': meta }) } });
        if (res.status === 304) {
            const body = await readFile(file).catch(() => null);
            if (body) return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
            return fetch(href, init);
        }
        const etag = res.headers.get('etag');
        if (!res.ok || !etag) return res;
        const body = Buffer.from(await res.arrayBuffer());
        await mkdir(DIR, { recursive: true });
        await writeFile(file, body);
        await writeFile(`${file}.etag`, etag);
        return new Response(body, { status: res.status, headers: res.headers });
    };
}

// --- Weights ---
//
// The loader reads a file whole, or in 8 MB ranges for a large one, under a
// watchdog that wants bytes every 20 s. So a miss is streamed through as it
// arrives and written to the cache file at its offset, and the ranges held
// are recorded beside it ({ etag, total, have: [[from, to], …] }, inclusive).
// A request whose bytes are all held is answered from disk.

// [[a, b], …] sorted and merged, touching ranges joined.
export function mergeRanges(list) {
    const out = [];
    for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
        const last = out[out.length - 1];
        if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
    }
    return out;
}
export const holds = (have, from, to) => have.some(([a, b]) => a <= from && to <= b);

// `bytes=a-b` to [a, b]; null for none. Open-ended and suffix ranges are not
// sent by the loader, so they go to the network.
export function parseRange(h) {
    const m = /^bytes=(\d+)-(\d+)$/.exec(h ?? '');
    return m ? [Number(m[1]), Number(m[2])] : h ? undefined : null;
}

// Returns { hit, fetched }: bytes answered from disk and from the network.
// `length` bytes of `file` from `at`, or null if it cannot give them all.
async function readAt(file, at, length) {
    let fh;
    try {
        fh = await open(file, 'r');
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, at);
        return bytesRead === length ? buf : null;
    } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

export function cacheWeights() {
    const counts = { hit: 0, fetched: 0 };
    const fetch = globalThis.fetch;
    // Per URL, once per run: the meta if the cached copy is still the
    // server's file, else null (and the copy is dropped).
    const checked = new Map();
    // Per URL, meta writes in order, so two ranges finishing together cannot
    // lose one another.
    const saving = new Map();

    const readMeta = (file) => readFile(`${file}.json`, 'utf8').then(JSON.parse, () => null);
    const check = (href, file) => {
        if (!checked.has(href)) checked.set(href, (async () => {
            const meta = await readMeta(file);
            if (!meta) return null;
            const head = await fetch(href, { method: 'HEAD' }).catch(() => null);
            if (head?.ok && head.headers.get('etag') === meta.etag) return meta;
            await rm(file, { force: true });
            await rm(`${file}.json`, { force: true });
            return null;
        })());
        return checked.get(href);
    };
    const record = (href, file, etag, total, range) => {
        const next = (saving.get(href) ?? Promise.resolve()).then(async () => {
            const meta = await readMeta(file);
            const have = meta?.etag === etag ? meta.have : [];
            const updated = { etag, total, have: mergeRanges([...have, range]) };
            await writeFile(`${file}.json`, JSON.stringify(updated));
            checked.set(href, Promise.resolve(updated));
        }).catch(() => {});
        saving.set(href, next);
        return next;
    };

    globalThis.fetch = async (url, init) => {
        const href = hrefOf(url);
        if (!WEIGHTS.test(href) || !isGet(init)) return fetch(url, init);
        const headers = init?.headers ?? {};
        const asked = parseRange(headers.Range ?? headers.range);
        if (asked === undefined) return fetch(url, init);
        const file = key(href);

        const meta = await check(href, file).catch(() => null);
        if (meta) {
            const [from, to] = asked ? [asked[0], Math.min(asked[1], meta.total - 1)] : [0, meta.total - 1];
            if (from <= to && holds(meta.have, from, to)) {
                const buf = await readAt(file, from, to - from + 1);
                if (buf) {
                    counts.hit += buf.length;
                    return new Response(buf, { status: asked ? 206 : 200, headers: {
                        'content-length': String(buf.length),
                        ...(asked && { 'content-range': `bytes ${from}-${to}/${meta.total}` }) } });
                }
                checked.delete(href);    // gone or short: fetched again below
            }
        }

        const res = await fetch(url, init);
        const etag = res.headers.get('etag');
        if (!res.ok || !etag || res.headers.get('content-encoding') || !res.body) return res;
        let start = 0, total;
        if (res.status === 206) {
            const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
            if (!m) return res;
            start = Number(m[1]);
            total = Number(m[2]);
        } else total = Number(res.headers.get('content-length'));
        if (!(total > 0)) return res;

        // Pass every chunk on at once and write it behind, in order. A
        // failed write ends the caching of this response, never the response.
        let fh = null, failed = false, written = 0, writes = Promise.resolve();
        try {
            await mkdir(DIR, { recursive: true });
            fh = await open(file, 'r+').catch(() => open(file, 'w+'));
        } catch { failed = true; }
        const reader = res.body.getReader();
        const body = new ReadableStream({
            async pull(ctl) {
                let done, value;
                try {
                    ({ done, value } = await reader.read());
                } catch (err) {
                    // The loader gave up on this request (its watchdog, or an abort).
                    failed = true;
                    await writes;
                    await fh?.close().catch(() => {});
                    throw err;
                }
                if (done) {
                    // Recorded before the end is passed on, so a request made
                    // as soon as this one finishes already finds it.
                    await writes;
                    await fh?.close().catch(() => {});
                    if (!failed && written > 0) await record(href, file, etag, total, [start, start + written - 1]);
                    ctl.close();
                    return;
                }
                if (!failed) {
                    const at = start + written;
                    writes = writes.then(() => fh.write(value, 0, value.byteLength, at)).catch(() => { failed = true; });
                }
                written += value.byteLength;
                counts.fetched += value.byteLength;
                ctl.enqueue(value);
            },
            async cancel(reason) {
                failed = true;
                await reader.cancel(reason).catch(() => {});
                await writes;
                await fh?.close().catch(() => {});
            },
        });
        return new Response(body, { status: res.status, headers: res.headers });
    };
    return counts;
}

// The cache's size on disk, for `clusterchat cache`.
export async function cacheSize() {
    const names = await readdir(DIR).catch(() => []);
    let bytes = 0;
    for (const n of names) bytes += (await stat(join(DIR, n)).catch(() => null))?.size ?? 0;
    return { bytes, files: names.filter((n) => !/\.(json|etag)$/.test(n)).length };
}

export const clearCache = () => rm(DIR, { recursive: true, force: true });
