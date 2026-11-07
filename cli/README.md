# clusterchat

Use a [ClusterChat](https://clusterchat.io) cluster from Claude Code, opencode and
other coding agents. `clusterchat connect` joins a cluster as a chat-only peer
(no GPU needed) and serves the Anthropic and OpenAI APIs on localhost, so your
agent runs on the open model your group's GPUs are serving.

```bash
npm install -g clusterchat
clusterchat connect 'https://clusterchat.io/chat#mesh=<code>&model=qwen3.5-4b'
```

Or without installing: `npx clusterchat@latest connect '<invite link>'`. Keep
the `@latest`: without it npx reuses whichever version it cached first.

Copy the invite link from the cluster's page (Invite → the command is shown
there too). **Keep it in quotes**: unquoted, the shell cuts it at `&` and you
join a different, empty cluster. `connect` prints which cluster it joined and
how many GPUs serve it, so a wrong link shows up straight away.

For the public demo, say so explicitly. The GPUs serving the demo belong to
strangers, and they see your prompts, so don't send them private code:

```bash
clusterchat connect demo
```

Needs Node 18 or newer. Options: `--port` (4747), `--host` (127.0.0.1).

## Point your agent at it

`connect` prints these lines with the cluster's model filled in.
`clusterchat setup <tool>` prints one of them again while `connect` is running.

**Claude Code**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4747 ANTHROPIC_AUTH_TOKEN=clusterchat \
  ANTHROPIC_MODEL=qwen3.5-4b ANTHROPIC_SMALL_FAST_MODEL=qwen3.5-4b claude
```

**opencode**: put the provider in `opencode.json` (in your project, or
`~/.config/opencode/opencode.json`). It makes the cluster's model the default;
`/models` switches back and forth:

```bash
npx clusterchat@latest setup opencode > opencode.json
```

Anything else that speaks the OpenAI Chat Completions API can use
`http://127.0.0.1:4747/v1`.

## What to expect

- **Context.** Claude Code's system prompt and tool definitions are about 20K
  tokens. Use a cluster created with a 32K context; a smaller one refuses the
  first request as too long. opencode needs less.
- **The first request is slow, the rest aren't.** Agents resend the whole
  conversation every time. The client remembers the last few chats it ran,
  and a request that continues one feeds only its new messages, so only the
  first request prefills the system prompt. A request that is a *prefix* of a
  kept chat reuses it too: an agent that gives up on a slow reply and opens a
  new session re-sends its first turn verbatim, and that turn is rewound to
  and continued rather than prefilled again. The cluster's model decides
  whether this is possible — a checkpoint with linear-attention layers cannot
  rewind, so there it still costs a full prefill.
- **One request at a time.** Concurrent requests queue.
- **Text and tool calls.** Images are replaced by "[image omitted]", and
  thinking is off.

## Self-hosting

Nothing to configure. The client takes the server from the invite link's
address, and the weights and TURN relay from what that server tells it, so
your own server's links work as they are, `http://localhost` included.

- **Your public demo**: `clusterchat connect demo --server https://your.host`,
  or set `CLUSTERCHAT_SERVER=https://your.host` once.
- **Modified code**: run the client from your checkout, `node cli/bin.js
  connect …` (run `npm install` in `cli/` first), or `npm link` in `cli/` for a
  `clusterchat` command. If the server and client protocol versions differ,
  the client says so instead of failing quietly.

## Adding a protocol, tool or model format

Each is one file plus a line in [`plugins.js`](plugins.js). Nothing else
changes.

- **A model's chat format** (`templates/`): `render(messages, { tools, system,
  first })` returns the prompt text, and `parser(tools)` reads a reply as it
  grows into text and tool calls. Chosen by the checkpoint manifest's
  `chat_format`. See [`templates/qwen.js`](templates/qwen.js).
- **An API** (`protocols/`): `{ name, routes: { 'POST /path': handler }, fail }`.
  A handler translates the request into the core's shape, runs
  `cluster.chat(req)`, and writes its events back in its own wire format. See
  [`protocols/openai.js`](protocols/openai.js).
- **A tool** (`harnesses/`): `{ name, label, protocol, setup(url, info) }`,
  where `setup` returns the lines that point the tool here. See
  [`harnesses/claude-code.js`](harnesses/claude-code.js).

The shape every protocol translates to is at the top of [`core.js`](core.js):

```js
// req:      { system, tools: [{ name, description, schema }], messages, maxTokens, temperature, signal }
// messages: [{ role: 'user' | 'assistant' | 'tool', text, calls?: [{ id, name, args }], callId? }]
for await (const ev of cluster.chat(req)) {
    // { type: 'start' } | { type: 'text', text } | { type: 'call', id, name, args }
    // | { type: 'end', stop: 'end' | 'length' | 'tool' | 'stopped', usage: { input, output, cached } }
}
```

Tests: `node tools/cli.test.mjs` (no GPU) checks the Qwen template against
the checkpoint's own Jinja template and every protocol against a fake cluster.
`node tools/cli.gpu.mjs` runs the client against a local cluster on a real GPU.

## License

AGPL-3.0, like the rest of [ClusterChat](https://github.com/l-wn/ClusterChat).
