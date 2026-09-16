#!/usr/bin/env python3
"""Read one bounded page of NUL-delimited Git name/status records."""
import hashlib
import json
import os
import re
import selectors
import subprocess
import sys
import time


def main():
    request = json.loads(sys.stdin.read(65537))
    args = request["args"]
    if len(args) > 2 or any(arg != "--cached" and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", arg) for arg in args):
        raise ValueError("Invalid file comparison endpoints")
    offset = request.get("offset", 0)
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("Invalid file page offset")
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", GIT_PAGER="cat", LC_ALL="C")
    command = ["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", *args, "--"]
    proc = subprocess.Popen(command, cwd=request["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
    pending = bytearray()
    error = bytearray()
    fields = []
    expected_fields = 0
    files = []
    retained = 0
    seen = 0
    digest = hashlib.sha256()
    has_more = False
    deadline = time.monotonic() + 15
    try:
        while selector.get_map() and not has_more:
            if time.monotonic() >= deadline:
                raise RuntimeError("Changed-file page timed out; retry or narrow the comparison")
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == "stderr":
                    error.extend(chunk[:max(0, 16384 - len(error))])
                    continue
                pending.extend(chunk)
                while b"\0" in pending:
                    end = pending.index(0)
                    field = bytes(pending[:end])
                    del pending[:end + 1]
                    if not fields:
                        if not re.fullmatch(rb"[ADMTUXB]|[RC][0-9]{1,3}", field):
                            raise RuntimeError("Unknown changed-file status")
                        expected_fields = 3 if field[:1] in (b"R", b"C") else 2
                    fields.append(field)
                    if sum(map(len, fields)) > 65536:
                        raise RuntimeError("A changed-file record exceeds the supported size")
                    if len(fields) != expected_fields:
                        continue
                    raw = b"\0".join(fields) + b"\0"
                    if seen == offset and request.get("prefix") and digest.hexdigest() != request["prefix"]:
                        raise RuntimeError("The changed-file list moved between pages; refresh this comparison")
                    if seen >= offset:
                        if len(files) >= 200 or retained + len(raw) > 196608:
                            has_more = True
                            break
                        values = [field.decode("utf-8") for field in fields]
                        if any(not field for field in values):
                            raise RuntimeError("Missing changed-file path")
                        item = {"status": values[0], "path": values[-1]}
                        if len(values) == 3:
                            item["oldPath"] = values[1]
                        files.append(item)
                        retained += len(raw)
                    digest.update(raw)
                    seen += 1
                    fields = []
                if len(pending) > 65536:
                    raise RuntimeError("A changed-file field exceeds the supported size")
                if has_more:
                    break
        if has_more:
            proc.kill()
        else:
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            if proc.returncode:
                raise RuntimeError(error.decode("utf-8", "replace"))
            if pending or fields:
                raise RuntimeError("Incomplete changed-file record")
            if seen < offset or seen == offset and request.get("prefix") and digest.hexdigest() != request["prefix"]:
                raise RuntimeError("The changed-file list moved between pages; refresh this comparison")
        result = {"version": 1, "files": files, "offset": offset, "nextOffset": offset + len(files), "hasMore": has_more, "prefix": digest.hexdigest(), "end": "cc-git-graph-files-v1"}
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        selector.close()
        proc.stdout.close()
        proc.stderr.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error)[:4096], file=sys.stderr)
        sys.exit(1)
