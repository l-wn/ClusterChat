// How much of two agents' prompts is the same text?
//
// PLAN-prefix-sharing.md turns on this number. Sharing KV cache pages between
// chats pays only for the span several sessions genuinely have in common, and
// only in whole PAGE_TOKENS pages, since a partial page is never shared. The
// repo recorded the number nowhere, so this measures it.
//
//   CLUSTERCHAT_DUMP_PROMPTS=~/dump clusterchat connect '<link>'   # per session
//   node tools/prefix-overlap.mjs ~/dump --tokenizer weights/<model>/tokenizer/tokenizer.json
//
// Each `connect` writes one file per request (cli/bin.js's promptDump), named
// by pid, so the files of one session sort together. Pass directories or
// files. --min skips the short requests an agent interleaves with its big one;
// the span that matters is the first big prompt of each session.
//
// Reports the common prefix of every file against the first, the common prefix
// of all of them, and what that is in whole pages. Under about 1,000 tokens,
// PLAN-prefix-sharing.md's Phase 2 is not worth its complexity.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, encode } from '../web/model/tokenizer.js';
import { PAGE_TOKENS } from '../web/split.js';

const args = process.argv.slice(2);
let tokenizer = null, min = 0, paths = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tokenizer') tokenizer = args[++i];
    else if (args[i] === '--min') min = Number(args[++i]);
    else if (args[i].startsWith('--')) { console.error(`unknown option ${args[i]}`); process.exit(2); }
    else paths.push(args[i]);
}
if (!paths.length || !tokenizer) {
    console.error('usage: node tools/prefix-overlap.mjs <dir|file...> --tokenizer <path|url> [--min <tokens>]');
    process.exit(2);
}

// The tokenizer fetches its vocabulary, which in a browser is always a URL. A
// local checkpoint is a path, so teach fetch about file: for this process only.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (!u.startsWith('file:')) return realFetch(url, opts);
    const body = readFileSync(new URL(u));
    return Promise.resolve(new Response(body, { status: 200 }));
};
const tokenizerUrl = /^https?:/.test(tokenizer) ? tokenizer
    : pathToFileURL(resolve(tokenizer)).href;

const files = [];
for (const p of paths) {
    if (statSync(p).isDirectory()) {
        for (const name of readdirSync(p).sort()) {
            if (name.endsWith('.txt')) files.push(resolve(p, name));
        }
    } else files.push(resolve(p));
}
if (!files.length) { console.error(`no .txt prompt dumps under ${paths.join(' ')}`); process.exit(2); }

// load() memoizes, so encode() below reuses this vocabulary rather than
// looking for a checkpoint.json that is not there.
await load(tokenizerUrl);

const dumps = [];
for (const f of files) {
    const ids = await encode(readFileSync(f, 'utf8'));
    if (ids.length >= min) dumps.push({ f, ids });
}
if (dumps.length < 2) {
    console.error(`need two prompts of at least ${min} tokens; got ${dumps.length}`);
    process.exit(2);
}

const common = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
};
const pages = (n) => Math.floor(n / PAGE_TOKENS);
const pct = (n, of) => `${(100 * n / of).toFixed(1)}%`;

console.log(`\n${dumps.length} prompts, tokenizer ${tokenizerUrl}\n`);
const first = dumps[0];
console.log('  tokens   shared with the first   pages');
for (const d of dumps) {
    const n = common(first.ids, d.ids);
    console.log(`  ${String(d.ids.length).padStart(6)}   ${String(n).padStart(10)} `
        + `${pct(n, d.ids.length).padStart(8)}   ${String(pages(n)).padStart(5)}   `
        + d.f.replace(`${process.cwd()}/`, ''));
}

// The span every one of them holds: what a cache shared by all of them saves.
let all = first.ids.length;
for (const d of dumps) all = Math.min(all, common(first.ids, d.ids));
const mean = dumps.reduce((s, d) => s + d.ids.length, 0) / dumps.length;

// And the best any two of them share, which bounds what pairwise sharing gives.
let best = 0;
for (let i = 0; i < dumps.length; i++) {
    for (let j = i + 1; j < dumps.length; j++) best = Math.max(best, common(dumps[i].ids, dumps[j].ids));
}

console.log(`\n  common to all ${dumps.length}   ${all} tokens = ${pages(all)} whole pages of `
    + `${PAGE_TOKENS}, ${pct(all, mean)} of the mean prompt (${Math.round(mean)} tokens)`);
console.log(`  best pair        ${best} tokens = ${pages(best)} whole pages`);
console.log(`\n  ${all < 1000 ? 'Under 1,000 tokens: Phase 0 is the whole project (PLAN-prefix-sharing.md).'
    : `Over 1,000 tokens: Phase 1 and 2 would save ${pages(all)} pages of prefill per extra session.`}\n`);
