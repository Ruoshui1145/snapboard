// Harness sandbox workaround (development/verification only).
// In the confined sandbox, child_process spawn/exec with PIPED stdio throws
// `spawn EPERM` SYNCHRONOUSLY (it does not deliver the error to the callback).
// Vite's dev server calls `exec("net use")` once for UNC path mapping — that
// call is best-effort and safe to degrade. We neutralize any *synchronous*
// spawn-EPERM raised by exec/execFile (async) and execSync/execFileSync (sync)
// so the dev server can boot. We deliberately DO NOT touch spawn()/spawnSync(),
// because every spawn site in the dev-server path uses stdio 'inherit' (which
// the sandbox allows), and forced-stdio rewrites would break stream consumers.
'use strict';

const cp = require('child_process');
const { ChildProcess } = cp;
const { PassThrough } = require('stream');

function isSpawnDenied(e) {
  return !!e && (e.code === 'EPERM' || e.errno === -4048);
}

function makeStubChild(e) {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = undefined;
  child.__stubError = e;
  // Absorb the 'error' event we emit in deliverError so it is never unhandled.
  child.on('error', () => {});
  return child;
}

function deliverError(child, e, cb) {
  process.nextTick(() => {
    // Emit 'error' on the child (Node's exec/execFile callers attach to this),
    // then invoke the user callback the way Node would.
    child.emit('error', e);
    if (cb) cb(e, '', '');
  });
}

// Wrap the async variants that default to piped stdio (exec, execFile).
for (const name of ['exec', 'execFile']) {
  const orig = cp[name];
  cp[name] = function (...args) {
    try {
      return orig.apply(this, args);
    } catch (e) {
      if (!isSpawnDenied(e)) throw e;
      const cb = [...args].reverse().find((a) => typeof a === 'function');
      const child = makeStubChild(e);
      deliverError(child, e, cb);
      return child;
    }
  };
}

// Wrap the sync variants that default to piped stdio (execSync, execFileSync).
// On spawn-EPERM, return an empty string so the caller's `.toString().trim()`
// yields '' rather than crashing the process.
for (const name of ['execSync', 'execFileSync']) {
  const orig = cp[name];
  cp[name] = function (...args) {
    try {
      return orig.apply(this, args);
    } catch (e) {
      if (!isSpawnDenied(e)) throw e;
      return '';
    }
  };
}
