#!/usr/bin/env python3
"""
Runtime harness: maps the job payload onto the integration entrypoint.

stdin:  JSON { mode?, definition?, code?, secrets?, previousState?, webhookData?, params? }
stdout: run mode: the JSON-serialized return value of run(ctx). Reserved for the result;
        user print() output is redirected to stderr.
        snippet mode: whatever the code prints (returned raw to the agent).
stderr: logs and tracebacks.
exit:   0 success, 1 failure.
"""
import importlib.util
import json
import sys
import traceback
from types import SimpleNamespace

CODE_PATH = "/tmp/_integration.py"


def build_ctx(payload):
    return SimpleNamespace(
        definition=payload.get("definition") or {},
        secrets=payload.get("secrets") or {},
        previous_state=payload.get("previousState"),
        webhook_data=payload.get("webhookData"),
        params=payload.get("params") or {},
        in_dir="/in",
        work_dir="/work",
        out_dir="/out",
    )


def main():
    payload = json.load(sys.stdin)
    code = payload.get("code") or (payload.get("definition") or {}).get("code")
    if not code:
        print("harness: no code in payload", file=sys.stderr)
        return 1

    with open(CODE_PATH, "w") as f:
        f.write(code)
    ctx = build_ctx(payload)

    if payload.get("mode") == "snippet":
        exec(compile(code, "snippet.py", "exec"), {"ctx": ctx, "__name__": "__main__"})
        return 0

    # run mode: stdout is the result channel, so user prints become stderr logs
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        spec = importlib.util.spec_from_file_location("integration", CODE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not hasattr(module, "run"):
            print("harness: integration must define run(ctx)", file=sys.stderr)
            return 1
        result = module.run(ctx)
    finally:
        sys.stdout = real_stdout

    try:
        json.dump(result if result is not None else {}, sys.stdout)
    except (TypeError, ValueError) as err:
        print(f"harness: run() result is not JSON-serializable: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.exit(1)
