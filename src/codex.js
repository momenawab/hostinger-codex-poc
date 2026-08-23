'use strict';
/**
 * Codex CLI runner.
 *
 * Safety model for this POC:
 *  - spawn() with an ARGUMENT ARRAY and shell:false. The user's text is never
 *    interpolated into a shell string, so shell injection is impossible.
 *  - The prompt is delivered over STDIN, not argv. This avoids ARG_MAX limits
 *    and keeps the prompt out of the process table (`ps`).
 *  - cwd is a dedicated, empty scratch directory - NOT this project and not any
 *    other project on the box. Codex cannot see source it was not given.
 *  - `-s read-only` forbids Codex from writing files.
 *  - `--ephemeral` stops session files being persisted to disk.
 *  - `--ignore-user-config` / `--ignore-rules` stop the server picking up a
 *    developer's personal ~/.codex/config.toml (hooks, MCP servers, custom
 *    models). Without this, output is polluted and latency explodes.
 *  - Hard wall-clock timeout with SIGTERM -> SIGKILL escalation.
 *  - stdout/stderr are capped so a runaway process cannot exhaust memory.
 *  - A concurrency gate bounds how many Codex processes can exist at once.
 *
 * No credential is ever read, logged, or returned by this module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const CONFIG = {
  timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 120000),
  statusTimeoutMs: Number(process.env.CODEX_STATUS_TIMEOUT_MS || 20000),
  maxPromptChars: Number(process.env.CODEX_MAX_PROMPT_CHARS || 4000),
  maxOutputBytes: Number(process.env.CODEX_MAX_OUTPUT_BYTES || 256 * 1024),
  maxConcurrent: Number(process.env.CODEX_MAX_CONCURRENT || 2),
  maxQueue: Number(process.env.CODEX_MAX_QUEUE || 8),
  killGraceMs: 5000,
  model: process.env.CODEX_MODEL || '',
  // Chat POC default: NO shell tool, so Codex physically cannot touch the disk.
  // Set CODEX_ALLOW_SHELL=1 only if you deliberately want an agentic Codex.
  allowShell: process.env.CODEX_ALLOW_SHELL === '1',
};

/* ------------------------------------------------------------------ *
 * Binary resolution
 * ------------------------------------------------------------------ */

let cachedBin;

/** Every native binary location the platform packages might ship. */
function nativeBinaryCandidates() {
  const root = path.join(__dirname, '..', 'node_modules', '@openai');
  const triples = [
    'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
    'x86_64-apple-darwin', 'aarch64-apple-darwin',
  ];
  const pkgs = ['codex-linux-x64', 'codex-linux-arm64', 'codex-darwin-x64', 'codex-darwin-arm64', 'codex'];
  const out = [];
  for (const pkg of pkgs) {
    for (const t of triples) out.push(path.join(root, pkg, 'vendor', t, 'bin', 'codex'));
  }
  return out;
}

/**
 * Restore the executable bit on the native binary.
 *
 * npm normally sets it, but an extracted/restored tree can lose it and the
 * result is a confusing EACCES at spawn time. Cheap to re-apply, so we do it
 * before anything tries to run Codex.
 */
function ensureNativeExecutable() {
  for (const p of nativeBinaryCandidates()) {
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    const mode = st.mode & 0o777;
    if (mode & 0o111) return { path: p, fixed: false, mode: mode.toString(8) };
    try {
      fs.chmodSync(p, 0o755);
      return { path: p, fixed: true, mode: (fs.statSync(p).mode & 0o777).toString(8) };
    } catch (e) {
      return { path: p, fixed: false, mode: mode.toString(8), error: e.code || e.message };
    }
  }
  return null;
}

function candidateBins() {
  const exe = process.platform === 'win32' ? '.cmd' : '';
  const out = [];
  if (process.env.CODEX_BIN) out.push({ cmd: process.env.CODEX_BIN, prefix: [], probe: process.env.CODEX_BIN });

  // PREFERRED: run the JS launcher through node. This needs NO executable bit
  // on the shim itself, which is exactly what fails (EACCES) on hosts that
  // strip the bit or mount the app directory noexec.
  const shim = path.join(__dirname, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  out.push({ cmd: process.execPath, prefix: [shim], probe: shim });

  // Fallback: the .bin shim, which DOES require the executable bit.
  const dotbin = path.join(__dirname, '..', 'node_modules', '.bin', 'codex' + exe);
  out.push({ cmd: dotbin, prefix: [], probe: dotbin });

  return out;
}

function resolveCodexBin() {
  if (cachedBin !== undefined) return cachedBin;
  ensureNativeExecutable();

  for (const c of candidateBins()) {
    try {
      if (fs.existsSync(c.probe)) { cachedBin = { cmd: c.cmd, prefix: c.prefix }; return cachedBin; }
    } catch (_) { /* keep looking */ }
  }

  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
    encoding: 'utf8', timeout: 5000, shell: false,
  });
  if (probe.status === 0 && (probe.stdout || '').trim()) {
    cachedBin = { cmd: (probe.stdout || '').trim().split('\n')[0], prefix: [] };
    return cachedBin;
  }
  cachedBin = null;
  return cachedBin;
}

function resetBinCache() { cachedBin = undefined; }

/* ------------------------------------------------------------------ *
 * Scratch sandbox directory
 * ------------------------------------------------------------------ */

let scratchDir;
function getScratchDir() {
  if (scratchDir) return scratchDir;
  const base = process.env.CODEX_SCRATCH_DIR || path.join(os.tmpdir(), 'codex-poc-scratch');
  fs.mkdirSync(base, { recursive: true });
  // A marker so it is obvious this dir is disposable and holds nothing real.
  try {
    fs.writeFileSync(
      path.join(base, 'README.txt'),
      'Disposable scratch dir for the Codex POC. Codex runs here with a read-only\n' +
      'sandbox so it cannot reach any real project on this server.\n'
    );
  } catch (_) { /* non-fatal */ }
  scratchDir = base;
  return scratchDir;
}

/* ------------------------------------------------------------------ *
 * Concurrency gate
 * ------------------------------------------------------------------ */

let active = 0;
const waiters = [];

function acquire() {
  if (active < CONFIG.maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  if (waiters.length >= CONFIG.maxQueue) {
    const err = new Error('Server is busy. Too many Codex requests are already queued.');
    err.code = 'BUSY';
    return Promise.reject(err);
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) return next();
  active = Math.max(0, active - 1);
}

/* ------------------------------------------------------------------ *
 * Core spawn helper
 * ------------------------------------------------------------------ */

function runProcess({ args, stdin, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const bin = resolveCodexBin();
    if (!bin) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', reason: 'CLI_NOT_AVAILABLE' });
    }

    let child;
    try {
      child = spawn(bin.cmd, [...bin.prefix, ...args], {
        cwd: cwd || getScratchDir(),
        shell: false, // never a shell - no injection surface
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(),
        detached: process.platform !== 'win32', // own process group, so we can kill descendants
      });
    } catch (e) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', reason: 'SPAWN_FAILED', error: e.code || e.message });
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const cap = (buf, chunk) => {
      if (buf.length >= CONFIG.maxOutputBytes) { truncated = true; return buf; }
      const merged = Buffer.concat([buf, chunk]);
      if (merged.length > CONFIG.maxOutputBytes) {
        truncated = true;
        return merged.subarray(0, CONFIG.maxOutputBytes);
      }
      return merged;
    };

    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });

    const killTree = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (_) {
        try { child.kill(signal); } catch (__) { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // Escalate if it ignores SIGTERM.
      setTimeout(() => { if (!settled) killTree('SIGKILL'); }, CONFIG.killGraceMs);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (e) => finish({
      ok: false, code: null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
      reason: 'SPAWN_FAILED', error: e.code || e.message,
    }));

    child.on('close', (code, signal) => finish({
      ok: code === 0 && !timedOut,
      code,
      signal,
      timedOut,
      truncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      reason: timedOut ? 'TIMEOUT' : (code === 0 ? 'OK' : 'NONZERO_EXIT'),
    }));

    // Feed the prompt over stdin, then close it so Codex starts work.
    if (child.stdin) {
      child.stdin.on('error', () => { /* child may exit before we finish writing */ });
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Environment handed to the Codex child.
 * We pass through only what the CLI needs. Credentials are NOT constructed or
 * inspected here - if OPENAI_API_KEY exists in the parent env it is forwarded
 * verbatim and never read by this code.
 */
function buildChildEnv() {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG || 'C.UTF-8',
    // Keep Codex's own state/auth location explicit and stable.
    CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    // Non-interactive hints.
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  // Forward auth-bearing vars verbatim WITHOUT reading or logging their values.
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) env[k] = process.env[k];
  }
  return env;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function isAvailable() {
  return resolveCodexBin() !== null;
}

function versionInfo() {
  const bin = resolveCodexBin();
  if (!bin) return null;
  const r = spawnSync(bin.cmd, [...bin.prefix, '--version'], {
    encoding: 'utf8', timeout: 15000, shell: false, env: buildChildEnv(), cwd: getScratchDir(),
  });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim().split('\n')[0] || null;
}

/**
 * Real authentication check via the official mechanism: `codex login status`.
 * We never print or return the credential itself - only a coarse state and,
 * where the CLI tells us, WHICH KIND of auth is in use (ChatGPT vs API key).
 */
async function checkStatus() {
  if (!isAvailable()) {
    return {
      available: false,
      authenticated: false,
      status: 'CLI_NOT_AVAILABLE',
      detail: 'The Codex CLI binary could not be found. Run `npm install` in the app directory.',
      version: null,
      authMethod: null,
    };
  }

  const version = versionInfo();

  const res = await runProcess({
    args: ['login', 'status'],
    stdin: '',
    timeoutMs: CONFIG.statusTimeoutMs,
  });

  const blob = `${res.stdout}\n${res.stderr}`;
  // Redact anything token-shaped before this string is used for any purpose.
  const safe = redact(blob).trim();
  const lower = safe.toLowerCase();

  if (res.reason === 'TIMEOUT') {
    return {
      available: true, authenticated: false, status: 'ERROR', version, authMethod: null,
      detail: 'Timed out while checking Codex login status.',
    };
  }
  if (res.reason === 'SPAWN_FAILED') {
    return {
      available: false, authenticated: false, status: 'CLI_NOT_AVAILABLE', version, authMethod: null,
      detail: `Codex binary could not be executed (${res.error || 'unknown'}).`,
    };
  }

  const loggedIn = res.code === 0 && /logged in/.test(lower) && !/not logged in/.test(lower);

  if (loggedIn) {
    let authMethod = 'unknown';
    if (/chatgpt/.test(lower)) authMethod = 'ChatGPT subscription (OAuth)';
    else if (/api key/.test(lower)) authMethod = 'API key';
    return {
      available: true,
      authenticated: true,
      status: 'AUTHENTICATED',
      version,
      authMethod,
      detail: 'Codex CLI reports an active login.',
    };
  }

  if (/not logged in/.test(lower) || res.code !== 0) {
    return {
      available: true,
      authenticated: false,
      status: 'NOT_AUTHENTICATED',
      version,
      authMethod: null,
      detail: 'Codex CLI has no stored credentials on this server. See README for the headless login options.',
    };
  }

  return {
    available: true, authenticated: false, status: 'ERROR', version, authMethod: null,
    detail: 'Could not interpret the Codex login status output.',
  };
}

/**
 * Send one prompt to Codex and return its final message.
 */
async function runPrompt(prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { success: false, error: 'Message must be a non-empty string.', code: 'INVALID_INPUT' };
  }
  const trimmed = prompt.trim();
  if (trimmed.length > CONFIG.maxPromptChars) {
    return {
      success: false,
      code: 'PROMPT_TOO_LONG',
      error: `Message too long (${trimmed.length} chars). Limit is ${CONFIG.maxPromptChars}.`,
    };
  }

  if (!isAvailable()) {
    return { success: false, code: 'CLI_NOT_AVAILABLE', error: 'Codex CLI is not installed on this server.' };
  }

  try {
    await acquire();
  } catch (e) {
    return { success: false, code: 'BUSY', error: e.message };
  }

  const outFile = path.join(
    getScratchDir(),
    `last-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );

  try {
    const args = [
      'exec',
      '--skip-git-repo-check',   // we deliberately run outside any git repo
      '--ephemeral',             // do not persist session files
      '--ignore-user-config',    // ignore ~/.codex/config.toml (hooks, MCP, custom models)
      '--ignore-rules',          // ignore user/project execpolicy rules
      '-s', 'read-only',         // Codex may not write anything
      '-C', getScratchDir(),     // working root = empty scratch dir
      '--color', 'never',
      '-o', outFile,             // final assistant message lands here, cleanly
    ];
    // Tool hardening. VERIFIED BEHAVIOUR: `-s read-only` only blocks WRITES -
    // a read-only Codex can still `cat` any file the Unix user can read, which
    // on shared hosting includes every other site owned by that user. Removing
    // the shell/exec tools is what actually contains it for a chat workload.
    if (!CONFIG.allowShell) {
      args.push(
        '--disable', 'shell_tool',
        '--disable', 'unified_exec',
        '--disable', 'browser_use',
        '--disable', 'computer_use',
        '--disable', 'plugins',
        '--disable', 'hooks'
      );
    }
    if (CONFIG.model) args.push('-m', CONFIG.model);
    args.push('-');              // read the prompt from stdin

    const started = Date.now();
    const res = await runProcess({
      args,
      stdin: trimmed,
      timeoutMs: opts.timeoutMs || CONFIG.timeoutMs,
    });
    const durationMs = Date.now() - started;

    if (res.reason === 'TIMEOUT') {
      return {
        success: false, code: 'TIMEOUT', durationMs,
        error: `Codex exceeded the ${(opts.timeoutMs || CONFIG.timeoutMs) / 1000}s time limit and was terminated.`,
      };
    }
    if (res.reason === 'SPAWN_FAILED') {
      return { success: false, code: 'SPAWN_FAILED', durationMs, error: `Could not start Codex (${res.error || 'unknown'}).` };
    }

    // Preferred: the clean final-message file.
    let answer = '';
    try {
      if (fs.existsSync(outFile)) answer = fs.readFileSync(outFile, 'utf8').trim();
    } catch (_) { /* fall through to stdout parsing */ }

    if (!answer) answer = extractFinalMessage(res.stdout);

    if (!res.ok) {
      const errText = redact((res.stderr || res.stdout || '').trim()) || 'Codex exited with an error.';
      const authish = /not logged in|unauthor|401|authentication|credential/i.test(errText);
      return {
        success: false,
        code: authish ? 'NOT_AUTHENTICATED' : 'CODEX_ERROR',
        durationMs,
        error: authish ? 'Codex is not authenticated on this server.' : truncate(errText, 800),
      };
    }

    if (!answer) {
      return { success: false, code: 'EMPTY_RESPONSE', durationMs, error: 'Codex returned no text.' };
    }

    return { success: true, response: redact(answer), durationMs, truncated: !!res.truncated };
  } finally {
    try { fs.unlinkSync(outFile); } catch (_) { /* already gone */ }
    release();
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Fallback parser for `codex exec` human output. The transcript looks like:
 *   codex
 *   <assistant text>
 *   tokens used
 *   1234
 * We take the block after the LAST bare "codex" line.
 */
function extractFinalMessage(stdout) {
  if (!stdout) return '';
  const lines = stdout.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'codex') { start = i + 1; break; }
  }
  if (start === -1) return '';
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === 'tokens used') break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

/**
 * Defence in depth: strip anything that looks like a key or bearer token before
 * text is returned to a browser or written to a log.
 */
function redact(s) {
  if (!s) return '';
  return String(s)
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[REDACTED]')
    .replace(/\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,})\b/g, '[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1[REDACTED]');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = {
  CONFIG,
  isAvailable,
  versionInfo,
  checkStatus,
  runPrompt,
  getScratchDir,
  resolveCodexBin,
  resetBinCache,
  ensureNativeExecutable,
  nativeBinaryCandidates,
  buildChildEnv,
  _internal: { extractFinalMessage, redact },
};
