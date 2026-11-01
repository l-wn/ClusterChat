// One transcript message, shared by peer.js and chat.js. Returns the element
// and setters for its parts. The caller appends it. A model reply's body is
// rendered as markdown (web/markdown.js); every other body is plain text.

import { renderMarkdown } from './markdown.js';

// The one highlighted phrase in a meta line: this tab's own GPU ran part of
// that reply. Marking it here rather than at the call site keeps a reply
// replayed from storage looking like one just written, and keeps the meta
// setter taking plain text.
const YOURS = 'yours included';

function setMeta(el, v) {
    const at = v.indexOf(YOURS);
    if (at < 0) { el.textContent = v; return; }
    const mark = document.createElement('span');
    mark.className = 'yours';
    mark.textContent = YOURS;
    el.replaceChildren(v.slice(0, at), mark, v.slice(at + YOURS.length));
}

export function makeMessage(who, text = '', cls = '') {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.innerHTML = `<div class="who"></div><div class="body"></div><div class="meta"></div>`;
    el.querySelector('.who').textContent = who;
    const body = el.querySelector('.body');
    const md = /\bmodel\b/.test(cls);
    if (md) body.classList.add('md');
    let shown = null;
    const setBody = (v) => {
        if (v === shown) return;
        shown = v;
        if (md) body.innerHTML = renderMarkdown(v);
        else body.textContent = v;
    };
    setBody(text);
    return {
        el,
        set body(v) { setBody(v); },
        set meta(v) { setMeta(el.querySelector('.meta'), v); },
        // The longer timing line, shown when hovering the meta line.
        set detail(v) {
            const meta = el.querySelector('.meta');
            if (v) meta.title = v; else meta.removeAttribute('title');
        },
        // The reasoning block, collapsed. With thinking on, the opening
        // <think> is part of the prompt, so the reply starts inside it.
        set reasoning(v) {
            let box = el.querySelector('.think');
            if (!box) {
                box = document.createElement('details');
                box.className = 'think';
                box.innerHTML = '<summary></summary><div></div>';
                el.insertBefore(box, body);
            }
            box.querySelector('summary').textContent = `Reasoning (${v.length} characters)`;
            box.querySelector('div').textContent = v;
        },
    };
}
