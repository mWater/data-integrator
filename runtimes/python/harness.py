#!/usr/bin/env python3
"""
Runtime harness: maps the job payload onto the integration entrypoint.

stdin:  JSON { mode?, definition?, code?, files?, entry?, secrets?, previousState?, webhookData?, params?, catalog? }
stdout: run mode: the JSON-serialized return value of run(ctx). Reserved for the result;
        prints and subprocess output are redirected to stderr (fd-level).
        snippet mode: whatever the code prints (returned raw to the agent).
stderr: logs and tracebacks.
exit:   0 success, 1 failure.
"""
import importlib
import importlib.util
import json
import os
import sys
import traceback
from types import SimpleNamespace

# Directory the job's source is written to; on sys.path, so packages and relative imports work
CODE_DIR = "/tmp/code"
# Module written for single-string code
CODE_PATH = "/tmp/_integration.py"


def check_path(file):
    """Rejects file paths that could escape the code directory or are not plain relative paths."""
    parts = file.split("/")
    if not file or file.startswith("/") or "\\" in file or any(p in ("", ".", "..") for p in parts):
        raise ValueError(f"harness: invalid file path {file!r}")


def write_files(files):
    """Writes the job's files under CODE_DIR."""
    os.makedirs(CODE_DIR, exist_ok=True)
    for file, source in files.items():
        check_path(file)
        target = os.path.join(CODE_DIR, file)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w") as f:
            f.write(source)


def entry_module(entry):
    """Module name of an entry path: "flood/daily.py" is flood.daily."""
    if not entry.endswith(".py"):
        raise ValueError(f"harness: entry {entry!r} is not a .py file")
    return entry[: -len(".py")].replace("/", ".")


def build_ctx(payload):
    return SimpleNamespace(
        definition=payload.get("definition") or {},
        secrets=payload.get("secrets") or {},
        previous_state=payload.get("previousState"),
        webhook_data=payload.get("webhookData"),
        params=payload.get("params") or {},
        catalog=payload.get("catalog") or {},
        in_dir="/in",
        work_dir="/work",
        out_dir="/out",
        tmp_dir="/tmp",
    )


def main():
    payload = json.load(sys.stdin)
    files = payload.get("files") or {}
    entry = payload.get("entry")
    code = payload.get("code") or (payload.get("definition") or {}).get("code")
    snippet = payload.get("mode") == "snippet"
    if not code and (snippet or entry is None):
        print("harness: no code in payload", file=sys.stderr)
        return 1
    if entry is not None and not snippet and entry not in files:
        print(f"harness: entry {entry!r} is not in files", file=sys.stderr)
        return 1

    write_files(files)
    sys.path.insert(0, CODE_DIR)
    ctx = build_ctx(payload)

    if snippet:
        exec(compile(code, "snippet.py", "exec"), {"ctx": ctx, "__name__": "__main__"})
        return 0

    # run mode: stdout is the result channel. Redirect fd 1 to stderr at the
    # OS level so subprocess output (GDAL progress and the like) physically
    # cannot reach it; the saved descriptor carries the result out.
    result_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    if entry is not None:
        module = importlib.import_module(entry_module(entry))
    else:
        with open(CODE_PATH, "w") as f:
            f.write(code)
        spec = importlib.util.spec_from_file_location("integration", CODE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    if not hasattr(module, "run"):
        print("harness: integration must define run(ctx)", file=sys.stderr)
        return 1
    result = module.run(ctx)

    try:
        serialized = json.dumps(result if result is not None else {})
    except (TypeError, ValueError) as err:
        print(f"harness: run() result is not JSON-serializable: {err}", file=sys.stderr)
        return 1
    with os.fdopen(result_fd, "w") as out:
        out.write(serialized)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.exit(1)
