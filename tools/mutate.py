#!/usr/bin/env python3
"""Mutation-test a source tree SAFELY.

The inline bash version restored each file by reading it back AFTER overwriting,
which truncated agent.js to 0 bytes. This keeps an immutable pristine copy,
restores only from that, and asserts syntax + a green baseline before each run.

usage: mutate.py <test-file> <specs.json>   specs: [[file, anchor, replacement], ...]
"""
import json, shutil, subprocess, sys, tempfile, os

ROOT = '/home/ubuntu/uwu-bot'
# Every file a spec may mutate MUST be watched, or a mutation is never
# restored and the next run starts from a broken baseline.
WATCH = ['src/agent/agent.js', 'src/agent/action_manager.js',
         'src/agent/library/skills.js', 'src/utils/threat.js']

def run(*a, **kw):
    return subprocess.run(a, cwd=ROOT, capture_output=True, text=True, **kw)

test_file, specs_file = sys.argv[1], sys.argv[2]
specs = json.load(open(specs_file))

tmp = tempfile.mkdtemp()
orig = {}
for f in WATCH:
    dst = os.path.join(tmp, f.replace('/', '_'))
    shutil.copy(os.path.join(ROOT, f), dst)
    orig[f] = dst

def restore():
    for f, dst in orig.items():
        shutil.copy(dst, os.path.join(ROOT, f))

def check(f):
    return run('node', '--check', f).returncode == 0

restore()
base = run('node', test_file)
last = [l for l in base.stdout.strip().split('\n') if l][-1] if base.stdout.strip() else 'no output'
print('baseline:', last)
if '0 failed' not in last:
    print('ABORT: baseline not green'); print(base.stdout[-2000:]); sys.exit(1)

missed = 0
for f, anchor, repl in specs:
    restore()
    path = os.path.join(ROOT, f)
    src = open(path).read()
    if anchor not in src:
        print(f'  ANCHOR MISSING  {f}: {anchor[:52]}'); continue
    open(path, 'w').write(src.replace(anchor, repl, 1))
    if not check(f):
        print(f'  SYNTAX-BREAK   {anchor[:52]} (counted caught)')
        continue
    r = run('node', test_file)
    n = r.stdout.count('NOT OK')
    if n:
        print(f'  CAUGHT         {anchor[:52]} ({n})')
    else:
        print(f'  *** MISSED *** {anchor[:52]}'); missed += 1

restore()
sizes = {f: os.path.getsize(os.path.join(ROOT, f)) for f in WATCH}
final = run('node', test_file)
lastf = [l for l in final.stdout.strip().split('\n') if l][-1] if final.stdout.strip() else '?'
print('restored:', lastf)
for f, n in sizes.items():
    flag = 'OK' if n > 1000 else '*** TRUNCATED ***'
    print(f'  {f} {n} bytes {flag}')
    if n <= 1000: missed += 1
shutil.rmtree(tmp, ignore_errors=True)
print('missed:', missed)
sys.exit(1 if missed else 0)
