#!/usr/bin/env python3
import json
import os
import stat
import sys

root, relative = sys.argv[1:3]
root = os.path.realpath(root)
if os.path.isabs(relative) or ".." in relative.split("/"):
    raise ValueError("Choose a file inside the selected checkout")
path = os.path.join(root, relative)
if os.path.commonpath([root, os.path.realpath(os.path.dirname(path))]) != root:
    raise ValueError("The file's parent resolves outside the checkout")
before = os.lstat(path)
kind = "symlink" if stat.S_ISLNK(before.st_mode) else "file"
if kind == "symlink":
    content = os.fsencode(os.readlink(path))
elif stat.S_ISREG(before.st_mode):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("The file changed while opening the preview")
        content = stream.read(262145)
else:
    raise ValueError("This path is not a regular file or symbolic link")
after = os.lstat(path)
changed = (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns, before.st_size) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns, after.st_size)
valid = True
try:
    text = content[:262144].decode("utf-8")
except UnicodeDecodeError:
    text = content[:262144].decode("utf-8", errors="replace")
    valid = False
binary = b"\0" in content
if binary:
    text = "Binary file; " + str(before.st_size) + " bytes.\nFirst bytes: " + content[:32].hex(" ")
elif kind == "symlink":
    text = "Symbolic link → " + text
print(json.dumps({"version": 1, "text": text, "binary": binary, "complete": len(content) <= 262144 and not changed and (valid or binary), "size": before.st_size, "kind": kind, "end": "cc-git-graph-file-v1"}, ensure_ascii=True))
