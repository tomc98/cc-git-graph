#!/usr/bin/env python3
"""Return a complete JSON envelope around a bounded, read-only Git response."""
import json
import os
import selectors
import subprocess
import sys
import tempfile
import time


def main():
    request = json.loads(sys.stdin.read(65537))
    args = request["args"]
    allowed = {"rev-parse", "rev-list", "for-each-ref", "log", "show", "status", "diff", "diff-tree", "cat-file", "worktree", "stash", "ls-files", "config", "symbolic-ref", "check-ref-format", "hash-object"}
    if not args or args[0] not in allowed:
        raise ValueError("Unsupported read command")
    # Secondary allowlists keep this transport read-only even with a malformed caller.
    if args[0] == "worktree" and args[1:2] != ["list"]:
        raise ValueError("Only worktree list is a read")
    if args[0] == "stash" and args[1:2] not in (["list"], ["show"]):
        raise ValueError("Only stash list/show are reads")
    if args[0] == "config" and args[1:2] not in (["--get"], ["--get-regexp"], ["--list"]):
        raise ValueError("Only configuration reads are allowed")
    if args[0] == "hash-object" and "-w" in args:
        raise ValueError("Object writes are not reads")
    options = args[:args.index("--")] if "--" in args else args
    if any(a.startswith("--output") or a == "--ext-diff" or a == "--textconv" for a in options):
        raise ValueError("External helpers and output files are not read previews")
    if args[0] == "symbolic-ref" and ("--delete" in args or len([a for a in args[1:] if not a.startswith("-")]) != 1):
        raise ValueError("Only symbolic-ref reads are allowed")
    limit = min(262144, max(1, int(request.get("limit", 262144))))
    timeout = min(15, max(1, float(request.get("timeout", 15))))
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", GIT_PAGER="cat", LC_ALL="C")
    command = ["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", *args]
    payload = request.get("stdin", "").encode("utf-8")
    input_file = tempfile.TemporaryFile()
    input_file.write(payload)
    input_file.seek(0)
    try:
        proc = subprocess.Popen(command, cwd=request["cwd"], env=env, stdin=input_file, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    finally:
        input_file.close()
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
    retained = {"stdout": bytearray(), "stderr": bytearray()}
    counts = {"stdout": 0, "stderr": 0}
    timed_out = False
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                timed_out = True
                proc.kill()
                break
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name = key.data
                counts[name] += len(chunk)
                room = (limit if name == "stdout" else 16384) - len(retained[name])
                retained[name].extend(chunk[:max(0, room)])
        proc.wait(timeout=max(0.1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        proc.wait()
    finally:
        selector.close()
        proc.stdout.close()
        proc.stderr.close()
    result = {"version": 1, "request": request["request"], "exitCode": proc.returncode, "timedOut": timed_out}
    for name, content in retained.items():
        valid = True
        try:
            value = content.decode("utf-8")
        except UnicodeDecodeError:
            value = content.decode("utf-8", errors="replace")
            valid = False
        result[name] = value
        result[name + "Bytes"] = len(content)
        result[name + "TotalBytes"] = counts[name]
        result[name + "Complete"] = not timed_out and len(content) == counts[name]
        result[name + "ValidUtf8"] = valid
    result["end"] = "cc-git-graph-read-v1"
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
