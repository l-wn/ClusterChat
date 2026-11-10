// opencode, through the OpenAI protocol: a provider in opencode.json (in the
// project, or ~/.config/opencode/opencode.json), made the default model.
// The output limit is a quarter of the context, since opencode keeps that
// much free for the reply.
export default {
    name: 'opencode',
    label: 'opencode',
    protocol: 'openai',
    agent: /opencode|ai-sdk/i,
    // The config is long, so connect's screen shows how to write it:
    // `setup opencode --write` merges it into ./opencode.json (bin.js).
    brief: ({ run }) => run('setup opencode --write'),
    setup: (url, info) => JSON.stringify(config(url, info), null, 2),
};

function config(url, info) {
    return {
        $schema: 'https://opencode.ai/config.json',
        model: `clusterchat/${info.id}`,
        provider: {
            clusterchat: {
                npm: '@ai-sdk/openai-compatible',
                name: 'ClusterChat',
                options: { baseURL: `${url}/v1` },
                models: { [info.id]: { name: info.model, limit: { context: info.ctx, output: Math.min(4096, Math.floor(info.ctx / 4)) } } },
            },
        },
    };
}

// `clusterchat setup opencode --write`: the clusterchat provider merged
// into an opencode.json's text (null for no file), keeping everything else
// in it. The cluster becomes the default model only if the file names none.
// Returns { json, created, setModel }, or null when the text is not plain
// JSON (opencode also reads JSONC), which is then left for a person to edit.
export function mergeConfig(text, url, info) {
    const fresh = config(url, info);
    if (text == null) return { json: fresh, created: true, setModel: true };
    let cur;
    try { cur = JSON.parse(text); } catch { return null; }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    const setModel = !cur.model;
    const json = { $schema: fresh.$schema, ...cur,
        provider: { ...(cur.provider ?? {}), clusterchat: fresh.provider.clusterchat },
        ...(setModel && { model: fresh.model }) };
    return { json, created: false, setModel };
}

export const providerSnippet = (url, info) => JSON.stringify({ clusterchat: config(url, info).provider.clusterchat }, null, 2);
