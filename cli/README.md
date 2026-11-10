# clusterchat

Join a [ClusterChat](https://clusterchat.io) cluster from your terminal. While
connected, this computer can do either job, or both:

- **Lend its GPU**: hold part of the model and run the cluster's chats, as
  a browser tab that lends does. No browser needed.
- **Bridge to your coding agent**: serve the Anthropic and OpenAI APIs on
  localhost, so Claude Code, opencode and the like run on the cluster's open
  model. Needs no GPU.

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

Needs Node 18 or newer.

## Commands

```
clusterchat connect '<invite link>' | demo   join: the bridge is on, lending as you choose
clusterchat gpu                              what this machine could lend, without joining
clusterchat setup <tool>                     print the setup for claude-code or opencode
clusterchat status                           what a running connect is doing
clusterchat cache [clear]                    the downloaded model files kept on disk
```

`connect` options: `--lend [GB|max]`, `--no-lend`, `--no-bridge`, `--direct`,
`--port` (4747), `--host` (127.0.0.1), `--server` (for `demo`).

## Lend your GPU

Every time you connect on a machine with a usable GPU, `connect` asks how
much to lend, with last time's amount filled in, after the bridge is
already up:

```
? lend your RTX 4090 to this cluster?  19 GB · 45% of the model   ←/→ amount · enter lend · n no
```

The amount it suggests is the GPU's free memory, less 2 GB (or a tenth of the
card, if that is more) for your desktop and other programs. `clusterchat gpu`
shows the same numbers without joining. The answer is remembered for that
cluster and filled in next time. Scripts that should not be asked pass
`--lend` or `--no-lend`.

The question is the only box on the screen, and the keys line under it
shows only what works at that moment:

```
not lending    l lend      c copy the Claude Code command      q leave
asking         enter lend & accept terms      ←/→ amount      n not now
lending        ←/→ amount      s stop lending      c copy …      q leave
```

- `←/→` changes the amount. More applies at once; less than the GPU holds
  reloads part of the model, so it asks you to press `←` again.
- `s` stops lending. If your GPU holds a piece nobody else does, stopping
  (or `q`) would take the model offline for everyone else, so it asks you to
  press the key again.
- `c` copies the Claude Code command to your clipboard through the terminal
  (OSC 52: most terminals, and tmux with `set-clipboard on`, ssh included).

The GPU grows its share of the model up to the amount you set, toward the part
of the model with the fewest copies. It stops early if it holds the whole
model or the GPU is full.

Without a terminal (a script or a service), nothing is asked. Say what you
want with flags:

```bash
clusterchat connect '<invite link>' --lend 20 --no-bridge    # a machine that only lends
clusterchat connect '<invite link>' --lend max               # as much as fits, and the bridge
clusterchat connect demo --no-lend                           # agents only, never ask
```

In a terminal, `connect` is a full-screen dashboard once it has joined. It
reads top to bottom: is it running, what the cluster is doing, what this
machine is doing, how to connect, and what is happening now:

```
   ██ ██ ██   ClusterChat v0.2.0
   ██ ██ ██   your own AI, on your own computers
   ██ ██ ██   ● ready · Qwen3.5-4B · http://127.0.0.1:4747

   cluster    private · id 1561bb · 3 connected · 2 GPUs lending · model loaded
              ▲ no backup: if a GPU leaves, the model stops

   my-laptop  ● lending · holds the whole model · since 23:42
              memory  ████████████████████████████░░░░░░░░░░░░  6.3 / 9.0 GB
              served  3,412 tokens to the cluster · 41 tok/s

   connect    Claude Code  npx clusterchat@latest claude
              opencode     npx clusterchat@latest setup opencode --write
              other        Anthropic- or OpenAI-compatible API at the address above

   requests   12 replies · 4.1k tokens to your agents · 31 tok/s avg
              23:51:04  claude-code  ✓ 8.1k in (7.9k cached) → 340 out  2.1 s

   ←/→ amount    s stop lending    c copy the Claude Code command    q leave
```

- **served** is what your GPU computed for anyone in the cluster;
  **requests** is what your own agents got back.
- The `id` is a short fingerprint of the cluster, not its invite code.
- The logo's purple square lights up while you lend.
- Nothing depends on colour: bars are `█░`, states are words, so it reads
  the same with `NO_COLOR` or a monochrome terminal.

When you leave, the session's request log is printed into your terminal, so
it is still there to scroll through. Piped or in a script there is no
dashboard, just one line per event. `node tools/screen.preview.mjs` draws
every state (`--width 60`, `--light`, `NO_COLOR=1`).

- **What it needs.** A GPU that WebGPU can use, through Dawn's Node bindings
  (the [`webgpu`](https://www.npmjs.com/package/webgpu) package, the WebGPU
  implementation inside Chrome): Vulkan on Linux, D3D12 on Windows, Metal on
  macOS. It is an optional dependency. If it cannot load, `connect` says so
  and only bridges.
- **Privacy.** Your GPU's links go through the TURN relay, so the other GPUs
  don't see your address. `--direct` lets GPU-to-GPU links go straight
  through, which is faster but shows your address to them. Lending to the
  public demo means running strangers' chats.
- **Downloads.** The part of the model you hold is kept under
  `~/.cache/clusterchat` and checked against the server on every start, so a
  restart downloads nothing that has not changed. `clusterchat cache clear`
  deletes it.
- **Lending less.** A GPU cannot hand back memory it is using. Lending less
  than it holds, or stopping, leaves and rejoins the cluster, which takes a
  few seconds. Agent requests running at that moment fail and have to be sent
  again.

By lending you confirm you are 18 or over and agree to the
[terms](https://clusterchat.io/terms), [code of
conduct](https://clusterchat.io/terms#conduct) and [privacy
policy](https://clusterchat.io/privacy), as with Join on the website.

## Point your agent at it

With `connect` running, in another terminal:

**Claude Code**

```bash
npx clusterchat@latest claude
```

This starts Claude Code with every model it may pick pointed at the
cluster's: `ANTHROPIC_MODEL`, the haiku, sonnet and opus aliases, and
subagents. Its arguments pass through (`clusterchat claude --resume`).
`clusterchat setup claude-code` prints the same variables as one line, if you
would rather set them yourself.

**opencode**

```bash
npx clusterchat@latest setup opencode --write
```

This adds the cluster as a provider to `./opencode.json`, keeping the rest
of the file. It becomes the default model only if the file names none;
otherwise pick it with `/models`. A file with comments is left alone, and
the lines to add are printed instead. Without `--write`, the whole config is
printed.

Anything else that speaks the Anthropic Messages API or the OpenAI Chat
Completions API can use `http://127.0.0.1:4747` (OpenAI: `/v1`). These are
compatible APIs served on your own machine: nothing is sent to Anthropic or
OpenAI.

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

Tests: `node tools/opencode-write.test.mjs` checks the opencode.json merge.
`node tools/cli.test.mjs` (no GPU) checks the Qwen template against
the checkpoint's own Jinja template and every protocol against a fake cluster.
`node tools/vram.test.mjs` and `node tools/cache.test.mjs` check the memory
suggestion and the weight cache. `node tools/cli.gpu.mjs` runs the client
against a local cluster on a real GPU, and `node tools/cli.lend.gpu.mjs` runs
it *as* the cluster's GPU: a browser prompting through it must get the
browser worker's reply token for token, and a restart must load from the cache.

## License

AGPL-3.0, like the rest of [ClusterChat](https://github.com/l-wn/ClusterChat).
