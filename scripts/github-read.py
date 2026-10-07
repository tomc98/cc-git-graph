#!/usr/bin/env python3
"""Bound GitHub reads and acquire selected objects in a separate bare cache."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile


def run(args, cwd=None, timeout=60):
    env = dict(os.environ, GH_PROMPT_DISABLED='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=err, timeout=timeout)
        out.seek(0)
        data = out.read(1048577)
        err.seek(0)
        error = err.read(8192).decode('utf-8', errors='replace')
    if child.returncode:
        raise ValueError(error or 'GitHub read failed. Check gh auth status and repository access.')
    if len(data) > 1048576:
        raise ValueError('GitHub response exceeds the page limit. Narrow the selection.')
    return data.decode('utf-8')


def main():
    request = json.loads(sys.stdin.read(65537))
    mode = request['mode']
    if mode == 'api':
        endpoint = request['endpoint']
        if not re.fullmatch(r'repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^\s\x00-\x1f]*)?', endpoint):
            raise ValueError('Invalid GitHub endpoint')
        value = json.loads(run(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', endpoint, '--jq', '(' + request.get('query', '.') + ') | tojson']))
    elif mode == 'objects':
        owner, name = request['owner'], request['name']
        if not all(re.fullmatch(r'[A-Za-z0-9_.-]+', s) and s not in ('.', '..') for s in (owner, name)):
            raise ValueError('Invalid repository')
        shas = request['shas']
        if not shas or len(shas) > 8 or not all(re.fullmatch(r'[0-9a-f]{40}', s) for s in shas):
            raise ValueError('Invalid selected object identifiers')
        cache = os.path.join(request['cache'], owner.lower(), name.lower() + '.git')
        os.makedirs(cache, mode=0o700, exist_ok=True)
        if not os.path.isfile(os.path.join(cache, 'HEAD')):
            run(['git', 'init', '--bare', cache])
        remote = 'https://github.com/' + owner + '/' + name + '.git'
        for sha in dict.fromkeys(shas):
            exists = subprocess.run(['git', '-C', cache, 'cat-file', '-e', sha + '^{commit}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if not exists:
                run(['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.hooksPath=/dev/null', '-C', cache,
                     'fetch', '--no-tags', '--no-write-fetch-head', '--depth=1', remote, sha + ':refs/cc-git-graph/' + sha], timeout=120)
        value = cache
    elif mode == 'anchor':
        if 'paths' in request:
            value = next((path for path in request['paths'] if 'diff-' + hashlib.sha256(path.encode('utf-8')).hexdigest() == request['anchor']), None)
        else:
            value = 'diff-' + hashlib.sha256(request['path'].encode('utf-8')).hexdigest()
    else:
        raise ValueError('Unsupported operation')
    print(json.dumps({'version': 1, 'value': value, 'end': 'cc-git-graph-github-v1'}, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
