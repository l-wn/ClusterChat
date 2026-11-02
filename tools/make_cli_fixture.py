# Reference prompts for cli/templates/qwen.js, rendered by the checkpoint's own
# chat_template.jinja through transformers, with enable_thinking=False.
# tools/cli.test.mjs checks the JS renders the same text.
#
#   .venv/bin/python tools/make_cli_fixture.py weights/qwen3.5-4b-q8/tokenizer
import json, sys
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained(sys.argv[1])

READ = {"name": "read", "description": "Read a file.",
        "schema": {"type": "object", "properties": {"path": {"type": "string"},
                   "lines": {"type": "integer"}}, "required": ["path"]}}
EDIT = {"name": "edit", "description": "Edit a file.",
        "schema": {"type": "object", "properties": {"path": {"type": "string"},
                   "opts": {"type": "object"}, "all": {"type": "boolean"}}}}

CASES = [
    {"system": "Be brief.", "tools": [], "msgs": [{"role": "user", "text": "Hi there"}]},
    {"system": "Be brief.", "tools": [], "msgs": [
        {"role": "user", "text": "Hi"}, {"role": "assistant", "text": "Hello!"},
        {"role": "user", "text": "  How are you?  "}]},
    {"system": "You code.", "tools": [READ, EDIT], "msgs": [{"role": "user", "text": "Open a.js"}]},
    {"system": "", "tools": [READ], "msgs": [{"role": "user", "text": "Open a.js"}]},
    {"system": "You code.", "tools": [READ, EDIT], "msgs": [
        {"role": "user", "text": "Fix a.js"},
        {"role": "assistant", "text": "Reading it first.", "calls": [
            {"name": "read", "args": {"path": "a.js", "lines": 40}},
            {"name": "edit", "args": {"path": "a.js", "opts": {"x": [1, 2]}, "all": True}}]},
        {"role": "tool", "text": "const a = 1;"},
        {"role": "tool", "text": "ok"}]},
    {"system": "You code.", "tools": [READ], "msgs": [
        {"role": "user", "text": "Read b"},
        {"role": "assistant", "text": "", "calls": [{"name": "read", "args": {"path": "b"}}]},
        {"role": "tool", "text": "B"},
        {"role": "assistant", "text": "It says B."},
        {"role": "user", "text": "Thanks"}]},
]

def hf(c):
    out = [{"role": "system", "content": c["system"]}] if c["system"] else []
    for m in c["msgs"]:
        h = {"role": m["role"], "content": m["text"]}
        if m.get("calls"):
            h["tool_calls"] = [{"type": "function", "function": {"name": x["name"], "arguments": x["args"]}}
                               for x in m["calls"]]
        out.append(h)
    return out

tools = lambda c: [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                    "parameters": t["schema"]}} for t in c["tools"]] or None
for c in CASES:
    c["prompt"] = tok.apply_chat_template(hf(c), tools=tools(c), tokenize=False,
                                          add_generation_prompt=True, enable_thinking=False)
json.dump(CASES, open("tools/fixtures/qwen-chat.json", "w"), indent=1, ensure_ascii=False)
print(f"wrote {len(CASES)} cases")
