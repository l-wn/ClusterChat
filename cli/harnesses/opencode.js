// opencode, through the OpenAI protocol: a provider in opencode.json (in the
// project, or ~/.config/opencode/opencode.json), made the default model.
// The output limit is a quarter of the context, since opencode keeps that
// much free for the reply.
export default {
    name: 'opencode',
    label: 'opencode',
    protocol: 'openai',
    agent: /opencode|ai-sdk/i,
    // The config is long, so connect's screen shows how to write it instead.
    brief: (url, info, setup) => `${setup} > opencode.json`,
    setup: (url, info) => JSON.stringify({
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
    }, null, 2),
};
