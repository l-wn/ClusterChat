// ChatML without tools, for checkpoints like the tiny test model.

import { SYSTEM } from '../../web/prompt.js';
import { settled } from './settled.js';

export const format = 'chatml';
export const tools = false;

// The assistant-turn opener every render() ends on. A context that stops here
// is ready to generate, so cli/core.js feeds just this to regenerate a reply
// it already has the prompt for.
export const open = '<|im_start|>assistant\n';

export function render(msgs, { system = null, first = true } = {}) {
    let out = first ? `<|im_start|>system\n${(system ?? SYSTEM).trim()}<|im_end|>\n` : '<|im_end|>\n';
    for (const m of msgs) {
        if (m.role !== 'user' && m.role !== 'assistant') {
            throw new Error(`this model's format (chatml) has no "${m.role}" messages`);
        }
        out += `<|im_start|>${m.role}\n${m.text.trim()}<|im_end|>\n`;
    }
    return out + open;
}

export function parser() {
    let shown = 0, reply = '';
    return {
        feed(text) {
            reply = text;
            const safe = settled(text);
            const out = safe.slice(shown);
            shown = Math.max(shown, safe.length);
            return out;
        },
        end: () => ({ text: reply.trimEnd().slice(shown), calls: [] }),
    };
}
