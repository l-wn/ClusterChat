// Claude Code, through the Anthropic protocol. The token is required by
// Claude Code and ignored here.
export default {
    name: 'claude-code',
    label: 'Claude Code',
    protocol: 'anthropic',
    agent: /claude-cli|claude-code/i,      // its User-Agent, for the request log
    setup: (url, info) => [
        `ANTHROPIC_BASE_URL=${url} ANTHROPIC_AUTH_TOKEN=clusterchat \\`,
        `  ANTHROPIC_MODEL=${info.id} ANTHROPIC_SMALL_FAST_MODEL=${info.id} claude`,
    ].join('\n'),
};
