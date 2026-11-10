// Bundle the client and the web/ code it uses into dist/clusterchat.js, so
// the package works without the rest of the repo.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
await build({
    entryPoints: [new URL('./bin.js', import.meta.url).pathname],
    outfile: new URL('./dist/clusterchat.js', import.meta.url).pathname,
    bundle: true, platform: 'node', format: 'esm', target: 'node18',
    external: ['node-datachannel', 'ws', 'webgpu'],
    define: { __VERSION__: JSON.stringify(version) },
    legalComments: 'none',
});
console.log(`built dist/clusterchat.js ${version}`);
