// Claude Code, through the Anthropic protocol. The token is required by
// Claude Code and ignored here.
//
// Every model Claude Code might pick is pointed at the cluster's: the main
// one, the aliases (haiku runs its background work), and subagents. The
// names are Claude Code's (code.claude.com/docs/en/model-config);
// ANTHROPIC_SMALL_FAST_MODEL is kept for versions from before
// ANTHROPIC_DEFAULT_HAIKU_MODEL replaced it.
export function claudeEnv(url, info) {
    const m = info.id;
    return {
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_AUTH_TOKEN: 'clusterchat',
        ANTHROPIC_MODEL: m,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
        ANTHROPIC_DEFAULT_SONNET_MODEL: m,
        ANTHROPIC_DEFAULT_OPUS_MODEL: m,
        CLAUDE_CODE_SUBAGENT_MODEL: m,
        ANTHROPIC_SMALL_FAST_MODEL: m,
    };
}

export default {
    name: 'claude-code',
    label: 'Claude Code',
    protocol: 'anthropic',
    agent: /claude-cli|claude-code/i,      // its User-Agent, for the request log
    // On connect's screen: the launcher, which sets all of the above.
    brief: ({ run }) => run('claude'),
    // `clusterchat setup claude-code`: the same, as one line to paste.
    setup: (url, info) => `${Object.entries(claudeEnv(url, info)).map(([k, v]) => `${k}=${v}`).join(' ')} claude`,
};
