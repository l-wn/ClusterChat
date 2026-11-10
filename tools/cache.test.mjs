// Tests cli/cache.js's weight cache against a local server with ETags and
// ranges: a miss is stored as it streams through, a repeat comes from disk,
// ranges are kept and joined, and a changed file is fetched again.
//
//   node tools/cache.test.mjs

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'cc-cache-'));
process.env.XDG_CACHE_HOME = tmp;
const { cacheWeights, mergeRanges, parseRange } = await import('../cli/cache.js');
const realFetch = globalThis.fetch;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${g}, want ${w}`); }
};

eq('merge joins touching ranges', mergeRanges([[10, 19], [0, 9], [30, 39]]), [[0, 19], [30, 39]]);
eq('merge keeps overlaps once', mergeRanges([[0, 15], [5, 9]]), [[0, 15]]);
eq('parse a range', parseRange('bytes=8-15'), [8, 15]);
eq('no range', parseRange(undefined), null);
eq('an open range is not handled', parseRange('bytes=8-'), undefined);

let file = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
let etag = '"v1"';
const gets = [];
const server = createServer((req, res) => {
    const h = { etag, 'accept-ranges': 'bytes' };
    if (req.method === 'HEAD') { res.writeHead(200, { ...h, 'content-length': file.length }); return res.end(); }
    gets.push(req.headers.range ?? 'whole');
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (m) {
        const a = Number(m[1]), b = Math.min(Number(m[2]), file.length - 1);
        res.writeHead(206, { ...h, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${file.length}` });
        return res.end(file.subarray(a, b + 1));
    }
    res.writeHead(200, { ...h, 'content-length': file.length });
    res.end(file);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const counts = cacheWeights();
const bytes = async (url, range) => Buffer.from(await (await fetch(url, range ? { headers: { Range: range } } : {})).arrayBuffer());

try {
    const whole = `${base}/w/block_00.bin`;
    eq('a miss: the whole file', (await bytes(whole)).equals(file), true);
    gets.length = 0;
    eq('a repeat: the same bytes', (await bytes(whole)).equals(file), true);
    eq('and no GET reached the server', gets, []);
    eq('a range of a cached file, from disk', (await bytes(whole, 'bytes=100-199')).equals(file.subarray(100, 200)), true);
    eq('still no GET', gets, []);
    eq('counted as hits', counts.hit, file.length + 100);

    const ranged = `${base}/w/block_01.bin`;
    await bytes(ranged, 'bytes=0-2047');
    await bytes(ranged, 'bytes=2048-4095');
    gets.length = 0;
    eq('ranges joined: the whole file from disk', (await bytes(ranged)).equals(file), true);
    eq('with no GET', gets, []);
    await bytes(`${base}/w/block_02.bin`, 'bytes=0-1023');
    gets.length = 0;
    await bytes(`${base}/w/block_02.bin`, 'bytes=1000-1100');
    eq('a range past what is held goes to the server', gets, ['bytes=1000-1100']);

    // A new run (a new wrapper, so the ETag is checked again) after the file changed.
    file = Buffer.from(file.map((x) => 255 - x));
    etag = '"v2"';
    globalThis.fetch = realFetch;
    const again = cacheWeights();
    gets.length = 0;
    eq('a changed file: the new bytes', (await bytes(whole)).equals(file), true);
    eq('fetched from the server', gets, ['whole']);
    eq('nothing served from the old copy', again.hit, 0);
} finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
