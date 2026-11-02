// A disk cache for the tokenizer, the one large download a chat-only peer
// makes (20 MB for Qwen). Kept under $XDG_CACHE_HOME/clusterchat (or
// ~/.cache/clusterchat) by URL and checked with its ETag on every start, so
// a changed tokenizer is fetched again.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'clusterchat');
const CACHED = /\/tokenizer\/tokenizer\.json$/;

export function cacheTokenizer() {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const href = typeof url === 'string' ? url : url.href ?? url.url;
        if (!CACHED.test(href) || init?.method && init.method !== 'GET') return fetch(url, init);
        const file = join(DIR, createHash('sha256').update(href).digest('hex').slice(0, 32));
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
