// Tests web/f16.js: the half-precision rounding of the residual stream peers
// send each other (net.js's pack()).
//
//   node tools/f16.test.mjs
//   node tools/f16.test.mjs --exhaustive
//
// toF16() has two paths: Float16Array where the runtime has it, and the scalar
// toF16Scalar() that defines the rounding. Every reply in the cluster depends
// on the two agreeing bit for bit, so the default run compares them over every
// case that can differ and --exhaustive compares them over all 2^32 floats
// (~3 minutes, not in `npm test`). Re-run it if either path is touched.

import { toF16, toF16Scalar, fromF16 } from '../web/f16.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

console.log('f16: every half, both ways');
{
    const all = Uint16Array.from({ length: 65536 }, (_, i) => i);
    const v = fromF16(all), back = toF16(v);
    let bad = 0;
    for (let i = 0; i < 65536; i++) {
        if (((i >>> 10) & 0x1f) === 0x1f) continue;          // inf and NaN, below
        if (back[i] !== i) bad++;
    }
    ok('every finite half survives a round trip', bad === 0, `${bad} differ`);
    ok('the smallest subnormal is 2^-24', v[1] === 2 ** -24);
    ok('the largest finite half is 65504', v[0x7bff] === 65504);

    // Halfway between two neighbours goes to the one with an even mantissa,
    // for both signs and across the subnormal boundary.
    let ties = 0;
    for (const sign of [0, 0x8000]) {
        for (let i = 0; i < 0x7bff; i++) {
            const a = v[sign | i], b = v[sign | (i + 1)];
            const mid = Math.fround((a + b) / 2);
            if (mid === a || mid === b) continue;
            if (toF16([mid])[0] !== (sign | (i % 2 ? i + 1 : i))) ties++;
        }
    }
    ok('ties round to even', ties === 0, `${ties} wrong`);
}

console.log('\nf16: f32 values');
{
    let s = 1, worst = 0;
    const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    const x = Float32Array.from({ length: 100000 }, () => (rand() - 0.5) * 2 ** (rand() * 30 - 15));
    const y = fromF16(toF16(x));
    for (let i = 0; i < x.length; i++) {
        if (Math.abs(x[i]) >= 2 ** -14) worst = Math.max(worst, Math.abs(y[i] - x[i]) / Math.abs(x[i]));
    }
    ok('normal values are within half an f16 step', worst <= 2 ** -11, `worst ${worst}`);
    const big = fromF16(toF16([1e6, -1e6, Infinity, -Infinity, 65520]));
    ok('values past the range clamp to ±65504, not infinity',
        [...big].join() === '65504,-65504,65504,-65504,65504', [...big].join());
    ok('NaN stays NaN', Number.isNaN(fromF16(toF16([NaN]))[0]));
    ok('-0 keeps its sign', Object.is(fromF16(toF16([-0]))[0], -0));
    ok('a value below half the smallest subnormal is zero', fromF16(toF16([2 ** -26]))[0] === 0);
}

// Both paths of toF16(). A mismatch anywhere here means a peer on one browser
// would hand on different bits than a peer on another, for the same rows.
console.log('\nf16: the fast path agrees with the scalar one');
{
    const fast = typeof Float16Array === 'function';
    ok('this runtime has Float16Array, so the fast path is the one under test', fast,
        '(skipped: only toF16Scalar was exercised above)');

    // Every case the two paths could part ways on: each half's exact value,
    // each midpoint between neighbouring halves (the ties), the subnormal and
    // overflow boundaries, and the specials.
    const edges = [];
    const all = fromF16(Uint16Array.from({ length: 65536 }, (_, i) => i));
    for (let i = 0; i < 65536; i++) edges.push(all[i]);
    for (let i = 0; i < 0x7bff; i++) {
        for (const sign of [0, 0x8000]) {
            const a = all[sign | i], b = all[sign | (i + 1)];
            edges.push(Math.fround((a + b) / 2));
            // Just off each midpoint, where nearest wins over ties-to-even.
            edges.push(Math.fround(a + (b - a) * 0.4), Math.fround(a + (b - a) * 0.6));
        }
    }
    edges.push(0, -0, Infinity, -Infinity, NaN, -NaN, 65504, -65504, 65520, -65520,
               65535, 1e6, -1e6, Number.MAX_VALUE, -Number.MAX_VALUE,
               2 ** -24, 2 ** -25, 2 ** -26, -(2 ** -25), 5e-324, Number.MIN_VALUE);

    let s = 1;
    const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    // The range a residual stream actually occupies, plus a wide sweep.
    for (let i = 0; i < 200000; i++) edges.push((rand() - 0.5) * 8);
    for (let i = 0; i < 200000; i++) edges.push((rand() - 0.5) * 2 ** (rand() * 60 - 30));

    const x = Float32Array.from(edges);
    const a = toF16(x), b = toF16Scalar(x);
    let bad = 0, first = null;
    for (let i = 0; i < x.length; i++) {
        if (a[i] !== b[i] && first === null) first = `${x[i]} -> ${a[i]} vs ${b[i]}`;
        if (a[i] !== b[i]) bad++;
    }
    ok(`the two paths agree over ${x.length} values`, bad === 0, `${bad} differ, first ${first}`);

    // A subarray and a plain Array must both work: pack() hands toF16() views,
    // and the tie test above hands it an Array literal.
    const view = x.subarray(1, 1000);
    ok('a subarray is converted from its own offset',
        toF16(view).join() === toF16Scalar(view).join());
    ok('a plain Array is accepted', toF16([1.5, -2.25, 1e9])[0] === toF16Scalar([1.5])[0]);
}

if (process.argv.includes('--exhaustive')) {
    console.log('\nf16: all 2^32 floats (this takes a few minutes)');
    const N = 1 << 16;
    const src = new Float32Array(N), bits = new Uint32Array(src.buffer);
    let bad = 0, first = null;
    for (let hi = 0; hi < 65536; hi++) {
        for (let lo = 0; lo < N; lo++) bits[lo] = (hi << 16) | lo;
        const a = toF16(src), b = toF16Scalar(src);
        for (let i = 0; i < N; i++) {
            if (a[i] === b[i]) continue;
            if (first === null) first = `0x${bits[i].toString(16)} -> ${a[i]} vs ${b[i]}`;
            bad++;
        }
    }
    ok('the two paths agree on every float32', bad === 0, `${bad} differ, first ${first}`);
} else {
    console.log('\n(pass --exhaustive to compare the two paths over all 2^32 floats)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
