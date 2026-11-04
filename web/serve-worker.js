// The serving worker's entry point.
//
// Everything of substance is in web/serve-host.js. This file is only the
// global wiring, kept separate for the reason web/dev/harness.html gives for
// the same split: tools/parse.test.mjs imports every browser module under bare
// Node to check that it evaluates, so a module must not touch its host's
// globals at import time. The calls below are optional-chained, so importing
// this file under Node is a no-op rather than a throw.
//
// `{ type: 'module' }` (web/serve-client.js) so the relative imports under
// here resolve as they do in the page: there is no bundler for the site and
// that is deliberate (tools/build-site.mjs).

import { install } from './serve-host.js';

const host = install((msg, transfer) => globalThis.postMessage?.(msg, transfer ?? []));

globalThis.addEventListener?.('message', (e) => { host.handle(e.data); });
