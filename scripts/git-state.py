#!/usr/bin/env python3
"""Read or verify the repository state bound to a reviewed Git action."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


def snapshot(request):
    cwd = request["cwd"]
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", LC_ALL="C")
    deadline = time.monotonic() + 20

    def git(*args, allow=(0,)):
        command_deadline = min(deadline, time.monotonic() + 8)
        proc = subprocess.Popen(["git", "--no-pager", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", cwd, *args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, error = bytearray(), bytearray()
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ, (output, 4 * 1024 * 1024))
        selector.register(proc.stderr, selectors.EVENT_READ, (error, 16384))
        try:
            while selector.get_map():
                if time.monotonic() >= command_deadline:
                    raise RuntimeError("Repository state read timed out")
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buffer, limit = key.data
                    if len(buffer) + len(chunk) > limit:
                        raise RuntimeError("Repository state exceeds the action preview limit")
                    buffer.extend(chunk)
            proc.wait(timeout=max(0.1, command_deadline - time.monotonic()))
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            selector.close()
            proc.stdout.close()
            proc.stderr.close()
        if proc.returncode not in allow:
            raise RuntimeError(error.decode("utf-8", "replace")[:4096])
        return bytes(output)

    def line(raw):
        if not raw.endswith(b"\n"):
            raise RuntimeError("Incomplete repository identity")
        return raw[:-1].decode("utf-8")

    git_dir = os.path.realpath(line(git("rev-parse", "--absolute-git-dir")))
    bare = git("rev-parse", "--is-bare-repository") == b"true\n"
    root = git_dir if bare else os.path.realpath(line(git("rev-parse", "--show-toplevel")))
    head = git("rev-parse", "--verify", "HEAD", allow=(0, 128)).decode().strip() or None
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD", allow=(0, 1)).decode().rstrip("\n") or None
    refs = git("for-each-ref", "--format=%(refname)%00%(objectname)%00")
    stash = git("reflog", "show", "--format=%H", "refs/stash", allow=(0, 128))
    config = git("config", "--local", "-z", "--get-regexp", r"^(remote|branch)\.", allow=(0, 1))
    worktrees = git("worktree", "list", "--porcelain", "-z")
    raw_status = b"" if bare else git("status", "--porcelain=v2", "-z", "--untracked-files=all")
    records = raw_status.split(b"\0")
    paths = []
    conflicts = []
    i = 0
    while i < len(records):
        record = records[i]
        i += 1
        if not record:
            continue
        kind = record[:1]
        if kind == b"?":
            path = record[2:]
        elif kind in (b"1", b"2", b"u"):
            path = record.split(b" ", {b"1": 8, b"2": 9, b"u": 10}[kind])[-1]
            if kind == b"2":
                paths.append(records[i])
                i += 1
            if kind == b"u":
                conflicts.append(path.decode("utf-8"))
        else:
            raise RuntimeError("Unsupported status record")
        paths.append(path)
    operation = None
    operation_data = []
    for marker, name in [("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"), ("sequencer", "sequencer")]:
        path = Path(git_dir, marker)
        if path.exists():
            operation = operation or name
            stat = path.stat()
            content = "directory"
            if path.is_file():
                with path.open() as stream:
                    content = stream.read(8192)
            operation_data.append([marker, stat.st_mtime_ns, content])
    scope = request.get("scope", "all")
    selected = request.get("paths", [])
    if scope == "paths":
        paths = [p.encode("utf-8") for p in selected]
        raw_status = git("status", "--porcelain=v2", "-z", "--untracked-files=all", "--", *selected)
    stats = []
    if scope != "refs":
        for path in sorted(set(paths)):
            absolute = os.path.join(os.fsencode(root), path)
            try:
                stat = os.lstat(absolute)
                link = os.readlink(absolute).decode("utf-8") if os.path.islink(absolute) else None
                stats.append([path.decode("utf-8"), stat.st_mode, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, link])
            except FileNotFoundError:
                stats.append([path.decode("utf-8"), "missing"])
        index = git("ls-files", "--stage", "-z", *( ["--", *selected] if scope == "paths" else []))
    else:
        raw_status = b""
        index = b""
    data = [root, git_dir, head, branch, refs.hex(), stash.hex(), config.hex(), worktrees.hex(), raw_status.hex(), index.hex(), stats, operation_data]
    digest = hashlib.sha256(json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
    return {"version": 1, "root": root, "gitDir": git_dir, "head": head, "branch": branch, "bare": bare, "dirtyCount": len(set(paths)), "conflicts": conflicts, "operation": operation, "digest": digest, "end": "cc-git-graph-state-v1"}


def main():
    request = json.loads(sys.argv[2])
    state = snapshot(request)
    if sys.argv[1] == "verify":
        expected = request["expected"]
        if state["root"] != expected["root"] or state["gitDir"] != expected["gitDir"]:
            print("CCGG_TARGET_CHANGED: The checkout changed. Preview the action again.")
            return 72
        if state["digest"] != expected["digest"]:
            print("CCGG_STALE: Repository state changed after the preview. Preview the action again.")
            return 73
        print("CCGG_PRECHECK_OK")
    else:
        print(json.dumps(state, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("CCGG_STATE_ERROR: " + str(error)[:4096], file=sys.stderr)
        sys.exit(70)
