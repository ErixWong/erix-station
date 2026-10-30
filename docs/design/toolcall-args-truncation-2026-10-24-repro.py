#!/usr/bin/env python3
"""
最小复现：api.ai.erix.vip 上 qwen3.8-flash-next 的 tool_call 参数流被上游提前掐断。

用法:
  python3 repro_toolcall_truncation.py                 # 跑内置矩阵
  python3 repro_toolcall_truncation.py --shape nested --bytes 6000 --reps 5
  python3 repro_toolcall_truncation.py --raw           # 存一份失败 SSE 原文

判据（PASS/FAIL）:
  PASS = 收到 finish_reason=tool_calls 且 args 长度 >= 期望长度的 90%
  FAIL = SSE 在 args 中途结束（无 finish_reason、无 [DONE]、无 usage），
         或 HTTP 层直接断（RemoteDisconnected / 500 http_request_failed）

不依赖任何三方库。
"""
import argparse
import json
import os
import time
import urllib.request

BASE = os.environ.get("RELAY_BASE", "https://api.ai.erix.vip/v1")
KEY = os.environ.get("RELAY_KEY", "sk-XXXX")     # ← 换成自己的 key，别把真 key 提交进 git
MODEL = os.environ.get("RELAY_MODEL", "qwen3.8-flash-next")

LINE = "line_{i} const value{i} = compute({i}); // comment"

NESTED = {                      # 形状与 pi / OpenAI 的 edit 工具一致：数组里套对象
    "name": "edit",
    "description": "Edit a file with exact text replacement",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"oldText": {"type": "string"},
                                   "newText": {"type": "string"}},
                    "required": ["oldText", "newText"],
                },
            },
        },
        "required": ["path", "edits"],
    },
}

FLAT = {                        # 形状与 write 工具一致：只有一个顶层字符串
    "name": "write",
    "description": "Write content to a file",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
    },
}


def payload(nbytes):
    out, i = [], 0
    while sum(len(x) + 1 for x in out) < nbytes:
        out.append(LINE.format(i=i))
        i += 1
    return "\n".join(out)


def request(shape, nbytes, *, stream=True, tool_choice="required", reasoning=None):
    spec = NESTED if shape == "nested" else FLAT
    key = "newText" if shape == "nested" else "content"
    body_text = payload(nbytes)
    prompt = (f"Call the {spec['name']} tool with path /tmp/x.js and ONE edit whose {key} "
              f"is exactly the text below verbatim:\n```\n{body_text}\n```")
    body = {
        "model": MODEL,
        "max_tokens": 32000,
        "tools": [{"type": "function", "function": spec}],
        "tool_choice": tool_choice,
        "messages": [{"role": "user", "content": prompt}],
    }
    if reasoning == "off":
        body["reasoning_effort"] = "none"
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return body, len(body_text)


def call(body, want, raw_dump=None):
    req = urllib.request.Request(
        f"{BASE}/chat/completions", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "content-type": "application/json"})
    t0, args, finish, err, rid = time.time(), 0, None, None, None
    lines = []
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            rid = r.headers.get("X-Oneapi-Request-Id")
            if not body.get("stream"):
                d = json.loads(r.read())
                ch = d["choices"][0]
                finish = ch.get("finish_reason")
                args = sum(len(t["function"].get("arguments") or "")
                           for t in ch["message"].get("tool_calls") or [])
            else:
                for raw in r:
                    s = raw.decode("utf8", "replace").rstrip("\n")
                    if raw_dump:
                        lines.append(s)
                    s = s.strip()
                    if not s.startswith("data:"):
                        continue
                    p = s[5:].strip()
                    if p == "[DONE]":
                        break
                    d = json.loads(p)
                    if d.get("usage"):
                        body.setdefault("_usage", d["usage"])
                    ch = d.get("choices") or []
                    if ch:
                        dc = ch[0].get("delta") or {}
                        for tc in (dc.get("tool_calls") or []):
                            args += len((tc.get("function") or {}).get("arguments") or "")
                        finish = ch[0].get("finish_reason") or finish
    except Exception as e:                       # noqa: BLE001
        err = f"{type(e).__name__}: {e}"[:120]
    if raw_dump:
        with open(raw_dump, "w", encoding="utf8") as f:
            f.write("\n".join(lines))
    ok = args >= want * 0.9 and finish == "tool_calls"
    return ok, args, finish, err, rid, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", choices=["nested", "flat", "both"], default="both")
    ap.add_argument("--bytes", type=int, default=0, help="只测这一个大小")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--no-stream", action="store_true")
    ap.add_argument("--raw", action="store_true", help="把最后一次失败的 SSE 原文写到 failed.sse")
    a = ap.parse_args()

    if not KEY or KEY == "sk-XXXX":
        raise SystemExit("先 export RELAY_KEY=sk-...  （默认值已脱敏）")

    shapes = ["nested", "flat"] if a.shape == "both" else [a.shape]
    sizes = [a.bytes] if a.bytes else [1000, 2000, 3000, 4000, 6000, 10000]
    print(f"base={BASE} model={MODEL} stream={not a.no_stream} reps={a.reps}\n")
    for shape in shapes:
        for n in sizes:
            body, want = request(shape, n, stream=not a.no_stream)
            ok_n, out, rid = 0, [], None
            for i in range(a.reps):
                raw = "failed.sse" if (a.raw and i == a.reps - 1) else None
                ok, args, finish, err, rid, dt = call(body, want, raw)
                ok_n += ok
                out.append(f"[args={args} finish={finish} err={err} {dt:.0f}s]")
            flag = "OK  " if ok_n == a.reps else ("FLAKY" if ok_n else "FAIL")
            print(f"{flag} {shape:6s} payload={want:6d}B pass {ok_n}/{a.reps}  " + " ".join(out))
            if rid:
                print(f"       last X-Oneapi-Request-Id: {rid}")


if __name__ == "__main__":
    main()
