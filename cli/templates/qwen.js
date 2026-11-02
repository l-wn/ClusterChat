// Qwen's chat format, for the Qwen3.5 and Qwen3.8 checkpoints. Renders what
// their chat_template.jinja renders with enable_thinking=false, and parses
// the tool calls that format asks the model to write:
//
//   <tool_call>
//   <function=name>
//   <parameter=key>
//   value
//   </parameter>
//   </function>
//   </tool_call>

import { QWEN_SYSTEM } from '../../web/prompt.js';
import { settled } from './settled.js';

export const format = 'qwen';
export const tools = true;

const TOOL_INTRO = '# Tools\n\nYou have access to the following functions:\n\n<tools>';
const TOOL_RULES = '\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>';
const REPLY = '<|im_start|>assistant\n<think>\n\n</think>\n\n';

// The prompt text for `msgs`, ending on an open assistant turn.
//
// `first`: `msgs` is the whole chat, so the system turn comes first.
// Otherwise `msgs` continues a chat whose context ends on the model's last
// reply, which the generator left unclosed, so the text opens by closing it.
export function render(msgs, { tools = [], system = null, first = true } = {}) {
    let out = first ? systemTurn(system ?? QWEN_SYSTEM, tools) : '<|im_end|>\n';
    // The template gives only the assistant turns after the last real user
    // message a <think> block.
    const lastQuery = msgs.findLastIndex((m) => m.role === 'user');
    msgs.forEach((m, i) => {
        if (m.role === 'user') out += `<|im_start|>user\n${m.text.trim()}<|im_end|>\n`;
        else if (m.role === 'assistant') out += assistant(m, i > lastQuery) + '<|im_end|>\n';
        else if (m.role === 'tool') {
            if (msgs[i - 1]?.role !== 'tool') out += '<|im_start|>user';
            out += `\n<tool_response>\n${m.text.trim()}\n</tool_response>`;
            if (msgs[i + 1]?.role !== 'tool') out += '<|im_end|>\n';
        } else throw new Error(`unexpected message role "${m.role}"`);
    });
    return out + REPLY;
}

function systemTurn(system, tools) {
    const text = system.trim();
    if (!tools.length) return text ? `<|im_start|>system\n${text}<|im_end|>\n` : '';
    const list = tools.map((t) => '\n' + pyJson({ type: 'function', function: {
        name: t.name, description: t.description ?? '', parameters: t.schema ?? {} } })).join('');
    return `<|im_start|>system\n${TOOL_INTRO}${list}${TOOL_RULES}${text ? '\n\n' + text : ''}<|im_end|>\n`;
}

function assistant(m, think) {
    const text = m.text.trim();
    let out = `<|im_start|>assistant\n${think ? '<think>\n\n</think>\n\n' : ''}${text}`;
    (m.calls ?? []).forEach((c, i) => {
        out += (i ? '\n' : text ? '\n\n' : '') + `<tool_call>\n<function=${c.name}>\n`;
        for (const [k, v] of Object.entries(c.args ?? {})) {
            out += `<parameter=${k}>\n${pyString(v)}\n</parameter>\n`;
        }
        out += '</function>\n</tool_call>';
    });
    return out;
}

// Jinja's `tojson` (Python's json.dumps): ", " and ": " separators.
function pyJson(v) {
    if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

// The template writes an object or list argument as JSON and anything else
// with Python's str().
function pyString(v) {
    if (v && typeof v === 'object') return pyJson(v);
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (v == null) return 'None';
    return String(v);
}

// --- Parsing a reply ---

const OPEN = '<tool_call>';

// Reads a reply as it grows. feed() takes the whole reply so far and returns
// the text that is safe to show: up to the first <tool_call>, holding back
// what settled() holds back and anything that could be the start of the tag.
// end() returns the rest of the text and the calls.
export function parser(tools = []) {
    const schemas = new Map(tools.map((t) => [t.name, t.schema?.properties ?? {}]));
    let shown = 0, reply = '';
    const visible = () => {
        const at = reply.indexOf(OPEN);
        return at >= 0 ? reply.slice(0, at) : reply;
    };
    return {
        feed(text) {
            reply = text;
            let safe = settled(visible());
            if (reply.indexOf(OPEN) < 0) {
                for (let n = Math.min(OPEN.length - 1, safe.length); n > 0; n--) {
                    if (OPEN.startsWith(safe.slice(-n))) { safe = settled(safe.slice(0, -n)); break; }
                }
            }
            const out = safe.slice(shown);
            shown = Math.max(shown, safe.length);
            return out;
        },
        end() {
            const text = visible().trimEnd().slice(shown);
            const calls = [...reply.slice(visible().length).matchAll(
                /<function=([^>\n]+)>([\s\S]*?)<\/function>/g)].map(([, name, body]) => {
                const props = schemas.get(name.trim()) ?? {};
                const args = {};
                for (const [, k, v] of body.matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
                    args[k.trim()] = typed(v, props[k.trim()]?.type);
                }
                return { name: name.trim(), args };
            });
            return { text, calls };
        },
    };
}

// A parameter's text as the type its schema gives. Strings stay as written.
function typed(v, type) {
    if (type === 'string' || type == null && !/^[\[{]/.test(v.trim())) return v;
    const t = v.trim();
    if (t === 'True' || t === 'False') return t === 'True';
    if (t === 'None') return null;
    try { return JSON.parse(t); } catch { return v; }
}
