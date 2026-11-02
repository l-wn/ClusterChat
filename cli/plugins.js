// Every plug-in, by kind. Adding one is a new file and a line here.
//
//   templates  a model's chat format: render(msgs, opts) and parser(tools),
//              picked by the manifest's chat_format (templates/qwen.js)
//   protocols  an HTTP API: { name, routes: { 'POST /path': handler }, fail },
//              handler(req, res, cluster, body), fail(res, err) for an error
//              before the reply started (protocols/openai.js)
//   harnesses  a coding tool: { name, label, protocol, setup(url, info) }
//              returning the lines that point it here; optionally `agent`, a
//              User-Agent pattern, and brief(url, info, setup), a shorter setup
//              for connect's screen, where `setup` is the command that
//              prints the full one (harnesses/opencode.js)

import * as qwen from './templates/qwen.js';
import * as chatml from './templates/chatml.js';
import anthropic from './protocols/anthropic.js';
import openai from './protocols/openai.js';
import claudeCode from './harnesses/claude-code.js';
import opencode from './harnesses/opencode.js';

export const templates = [qwen, chatml];
export const protocols = [anthropic, openai];
export const harnesses = [claudeCode, opencode];
