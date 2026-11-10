// Tests `clusterchat setup opencode --write`'s merge (cli/harnesses/opencode.js):
// a new file is the whole config, an existing one keeps everything it had,
// and a file that is not plain JSON is left alone.
//
//   node tools/opencode-write.test.mjs

import { mergeConfig } from '../cli/harnesses/opencode.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}: got ${g}, want ${w}`); }
};
const url = 'http://127.0.0.1:4747', info = { id: 'qwen3.5-4b', model: 'Qwen/Qwen3.5-4B', ctx: 32768 };

const fresh = mergeConfig(null, url, info);
eq('no file: created', fresh.created, true);
eq('no file: the cluster is the default model', fresh.json.model, 'clusterchat/qwen3.5-4b');
eq('no file: the provider points at the bridge', fresh.json.provider.clusterchat.options.baseURL, `${url}/v1`);

const mine = JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-x', theme: 'tokyonight',
    provider: { anthropic: { options: { apiKey: '{env:KEY}' } }, clusterchat: { name: 'old' } } });
const merged = mergeConfig(mine, url, info);
eq('existing: not created', merged.created, false);
eq('existing: its default model is kept', merged.json.model, 'anthropic/claude-x');
eq('existing: setModel says so', merged.setModel, false);
eq('existing: other keys are kept', merged.json.theme, 'tokyonight');
eq('existing: other providers are kept', merged.json.provider.anthropic, { options: { apiKey: '{env:KEY}' } });
eq('existing: an old clusterchat entry is replaced', merged.json.provider.clusterchat.name, 'ClusterChat');

const noModel = mergeConfig('{"theme":"x"}', url, info);
eq('a file with no model: the cluster becomes it', [noModel.setModel, noModel.json.model], [true, 'clusterchat/qwen3.5-4b']);

eq('JSONC with comments: left alone', mergeConfig('{\n  // mine\n  "theme": "x"\n}', url, info), null);
eq('not an object: left alone', mergeConfig('[1,2]', url, info), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
