'use strict';
/**
 * Browser-driven ChatGPT sign-in using Codex's official DEVICE CODE flow.
 *
 * Why this flow: the normal `codex login` opens a browser and waits on a
 * loopback callback, which cannot work on a headless server. `--device-auth` is
 * built for exactly this case - the server prints a URL and a short code, and
 * the human approves on whatever device they like.
 *
 * What crosses the wire to the browser: a public URL and a short-lived,
 * single-use device code. That is ALL. The resulting credential is written by
 * the Codex CLI itself into $CODEX_HOME and is never read, logged, or returned
 * by this module.
 *
 * Only one login may be in flight at a time.
 */

const { spawn } = require('child_process');
const codex = require('./codex');

const CODE_TTL_MS = 15 * 60 * 1000;   // matches the CLI's stated 15-minute expiry

let session = null;

// Built from a char code so no raw control byte lives in this source file.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const stripAnsi = (s) => String(s || '').replace(ANSI, '');

function parseDeviceOutput(text) {
  const clean = stripAnsi(text);
  const url = (clean.match(/https:\/\/\S*auth\.openai\.com\S*/) || [])[0] || null;
  const code = (clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/) || [])[1] || null;
  return { url, code };
}

/**
 * Turn raw CLI output into something a human can act on.
 * Device-code auth is an account-level opt-in that is OFF by default, so this
 * is the single most likely first-run failure.
 */
function friendlyError(raw) {
  const t = String(raw || '');
  if (/device code authorization/i.test(t)) {
    return {
      message: 'Device code sign-in is disabled on your ChatGPT account. '
        + 'Open ChatGPT then Settings then Security, enable device code authorization, and try again.',
      action: 'ENABLE_DEVICE_CODE',
    };
  }
  if (/rate.?limit|too many/i.test(t)) {
    return { message: 'OpenAI rate-limited the sign-in attempt. Wait a minute and retry.', action: null };
  }
  if (/network|dns|connect|timed? out/i.test(t)) {
    return {
      message: 'Could not reach OpenAI from this server. Outbound HTTPS may be blocked by the host firewall.',
      action: 'NETWORK',
    };
  }
  return { message: t.trim().slice(-300) || 'Sign-in failed.', action: null };
}

function publicState() {
  if (!session) return { state: 'IDLE' };
  return {
    state: session.state,
    url: session.url,
    code: session.code,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    error: session.error || null,
    action: session.action || null,
  };
}

function killChild() {
  if (!session || !session.child) return;
  try {
    if (process.platform !== 'win32' && session.child.pid) process.kill(-session.child.pid, 'SIGKILL');
    else session.child.kill('SIGKILL');
  } catch (_) { /* already gone */ }
}

function cancelLogin() {
  if (session && session.state === 'PENDING') {
    killChild();
    session.state = 'CANCELLED';
  }
  const s = publicState();
  session = null;
  return s;
}

/**
 * Start the device-code flow. Resolves as soon as the URL + code are parsed;
 * the child keeps running in the background waiting for approval.
 */
function startLogin() {
  return new Promise((resolve) => {
    if (session && session.state === 'PENDING' && Date.now() < session.expiresAt) {
      return resolve(publicState());   // reuse the in-flight code
    }
    if (session) cancelLogin();

    const bin = codex.resolveCodexBin();
    if (!bin) {
      return resolve({ state: 'ERROR', error: 'Codex CLI is not available on this server.' });
    }

    let child;
    try {
      child = spawn(bin.cmd, [...bin.prefix, 'login', '--device-auth'], {
        env: codex.buildChildEnv(),
        cwd: codex.getScratchDir(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return resolve({ state: 'ERROR', error: 'Could not start Codex login (' + (e.code || e.message) + ').' });
    }

    const now = Date.now();
    session = {
      child, state: 'PENDING', url: null, code: null, error: null,
      startedAt: now, expiresAt: now + CODE_TTL_MS, buf: '',
    };

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(parseTimer);
      resolve(publicState());
    };

    const onData = (d) => {
      if (!session) return;
      // Cap the buffer: this output is small, and we never want it unbounded.
      if (session.buf.length < 16384) session.buf += d.toString('utf8');
      const parsed = parseDeviceOutput(session.buf);
      if (parsed.url) session.url = parsed.url;
      if (parsed.code) session.code = parsed.code;
      if (session.url && session.code) settle();
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => {
      if (session) { session.state = 'ERROR'; session.error = e.code || e.message; }
      settle();
    });

    child.on('close', (exitCode) => {
      if (!session) return;
      if (exitCode === 0) {
        session.state = 'SUCCESS';
      } else if (session.state === 'PENDING') {
        session.state = 'FAILED';
        // Never surface raw CLI output verbatim - it is redacted first, then
        // mapped to actionable guidance where we recognise the cause.
        const safe = codex._internal.redact(stripAnsi(session.buf));
        const friendly = friendlyError(safe);
        session.error = friendly.message || ('Login exited with code ' + exitCode + '.');
        session.action = friendly.action;
      }
      session.child = null;
      settle();
    });

    // Give it a moment to emit the URL + code.
    const parseTimer = setTimeout(() => {
      if (session && session.state === 'PENDING' && !(session.url && session.code)) {
        session.state = 'ERROR';
        session.error = 'Codex did not return a device code in time.';
        killChild();
      }
      settle();
    }, 30000);

    // Hard stop once the code can no longer be valid.
    setTimeout(() => {
      if (session && session.state === 'PENDING') {
        killChild();
        session.state = 'EXPIRED';
      }
    }, CODE_TTL_MS + 30000).unref();
  });
}

/** Current flow state, cross-checked against real CLI auth state. */
async function getLoginState() {
  const s = publicState();
  if (s.state === 'PENDING' && s.expiresAt && Date.now() > s.expiresAt) {
    cancelLogin();
    return { state: 'EXPIRED', error: 'The device code expired. Start again.' };
  }
  // Authoritative check: ask the CLI, do not trust our own bookkeeping.
  if (s.state === 'SUCCESS' || s.state === 'PENDING') {
    const status = await codex.checkStatus();
    if (status.authenticated) {
      session = null;
      return { state: 'SUCCESS', authMethod: status.authMethod };
    }
  }
  return s;
}

module.exports = { startLogin, getLoginState, cancelLogin, parseDeviceOutput, friendlyError };
