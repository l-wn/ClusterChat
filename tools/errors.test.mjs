// Tests web/errors.js: raw errors map to the right problem, the chat sentence
// never contains the raw text, and ContextFullError survives both the
// re-export through web/engine.js and the trip across the worker boundary.
//
//   node tools/errors.test.mjs

import { PROBLEMS, classify, message, ContextFullError } from '../web/errors.js';
import { packError, unpackError } from '../web/serve-protocol.js';
import { ContextFullError as Reexported } from '../web/engine.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    if (got === want) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const vulkanOom = new Error('client.bin: GPU ran out of memory uploading its tensors (vkAllocateMemory failed ' +
    'with VK_ERROR_OUT_OF_DEVICE_MEMORY\n - While calling [Device].CreateBuffer([BufferDescriptor]).\n' +
    '    at CheckVkOOMThenSuccessImpl (../../third_party/dawn/src/dawn/native/vulkan/VulkanError.cpp:119)\n)');

console.log('\nclassify');
eq('a Vulkan out-of-memory is the GPU being full', classify(vulkanOom), 'GPU_FULL');
eq('no WebGPU', classify(new Error('This browser has no WebGPU, so this tab can chat but not lend')), 'NO_WEBGPU');
eq('a computer with no room', classify(new Error('no session free for another right now; try again in a moment')), 'BUSY');
eq('a backed-up link', classify(new Error('the link to peer 4 is backed up; try again in a moment')), 'BUSY');
eq("the cluster's reply limit", classify("the cluster's limit of 8 replies at once"), 'REPLY_LIMIT');
eq('a full context', classify(new Error('this prompt needs 900 tokens and only 12 are left in the 4096-token context')), 'CHAT_FULL');
eq('anything else falls back', classify(new Error('something odd')), 'REPLY_FAILED');
eq('with the fallback given', classify(new Error('something odd'), ''), '');

console.log('\nmessages');
const codes = Object.values(PROBLEMS).map((p) => p.code);
eq('every code is unique', new Set(codes).size, codes.length);
for (const [key, p] of Object.entries(PROBLEMS)) {
    const m = message(key);
    if (!m.endsWith(`(${p.code})`) || /[<>{}]|Error|at \w+ \(/.test(m)) eq(`${key} reads as a plain sentence`, m, 'plain');
}
eq('every message ends in its code and has no raw text', true, true);
eq('an unknown key reads as a failed reply', message('NOPE'), message('REPLY_FAILED'));

// web/engine.js re-exports ContextFullError so every existing import of it
// from there keeps working, and constructs one in #prepare(). A bare
// `export … from` would satisfy the first and break the second, since it binds
// nothing locally — which showed up only as a context-full turn being
// classified as some other failure.
console.log('\nContextFullError');
eq('engine.js re-exports the same class', Reexported, ContextFullError);
eq('and can still construct one', new Reexported(900, 12, 4096) instanceof ContextFullError, true);
eq('whose message says both numbers',
   new ContextFullError(900, 12, 4096).message,
   'this prompt needs 900 tokens and only 12 are left in the 4096-token context');

// The serving peer runs in a worker, so every error the page sees has been
// through structuredClone, which keeps `name` and `message` but drops the
// subclass and every own property. Both carry meaning: web/peer.js and
// web/dev/harness.js test `instanceof` to tell a full context from a failure,
// and route.js sets `busy` on a peer's capacity refusal.
console.log('\nacross the worker boundary');
const roundTrip = (err) => unpackError(structuredClone(packError(err)));

const full = roundTrip(new ContextFullError(900, 12, 4096));
eq('a full context arrives as a ContextFullError', full instanceof ContextFullError, true);
eq('with its message intact', full.message,
   'this prompt needs 900 tokens and only 12 are left in the 4096-token context');
eq('and classifies as a full chat', classify(full), 'CHAT_FULL');
eq('keeping the numbers the page shows', `${full.needed}/${full.room}`, '900/12');

const busy = roundTrip(Object.assign(new Error('no session free for another right now'), { busy: true }));
eq('a capacity refusal keeps its busy flag', busy.busy, true);
eq('and is not a ContextFullError', busy instanceof ContextFullError, false);

const cancelled = roundTrip(Object.assign(new Error('rebuild cancelled'), { cancelled: true }));
eq('a cancelled rebuild keeps its flag', cancelled.cancelled, true);

const plain = roundTrip(new TypeError('something odd'));
eq('any other error keeps its name', plain.name, 'TypeError');
eq('and its message', plain.message, 'something odd');
eq('nothing survives of an absent error but a sentence',
   roundTrip(null).message, 'unknown failure');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
