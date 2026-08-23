'use strict';
/**
 * Hostinger Codex CLI POC - HTTP layer.
 *
 * Endpoints
 *   GET  /                    static UI
 *   GET  /api/codex/status    real Codex availability + auth check
 *   POST /api/chat            { message } -> { success, response }
 *   POST /test-codex          { prompt }  -> { success, response }   (Step 6)
 *   GET  /api/env             environment report (names only, no values)
 *   GET  /healthz             liveness
 *
 * ACCESS CONTROL
 *   Every /api/* and /test-codex route requires a shared token, because this
 *   endpoint spends real model quota. Set POC_TOKEN in the Hostinger panel. If
 *   you do not set one, a random token is generated at boot and printed to the
 *   server log ONLY - never to the browser.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const codex = require('./src/codex');
const { diagnose } = require('./src/diagnose');
const login = require('./src/login');

const app = express();
const PORT = process.env.PORT || 3000;

// Hostinger fronts Node apps with a reverse proxy; trust it for real client IPs.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ *
 * Token gate
 * ------------------------------------------------------------------ */

const GENERATED = !process.env.POC_TOKEN;
const POC_TOKEN = process.env.POC_TOKEN || crypto.randomBytes(24).toString('hex');

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireToken(req, res, next) {
  const supplied =
    req.get('x-poc-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    req.query.token;
  if (!supplied || !timingSafeEqual(supplied, POC_TOKEN)) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Supply the POC access token.', code: 'UNAUTHORIZED' });
  }
  return next();
}

/* ------------------------------------------------------------------ *
 * Very small in-memory rate limiter (per IP)
 * ------------------------------------------------------------------ */

const WINDOW_MS = 60000;
const MAX_REQ = Number(process.env.POC_RATE_LIMIT || 20);
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + WINDOW_MS; }
  rec.count++;
  hits.set(ip, rec);
  if (rec.count > MAX_REQ) {
    return res.status(429).json({
      success: false, code: 'RATE_LIMITED',
      error: `Rate limit exceeded (${MAX_REQ}/min). Try again shortly.`,
    });
  }
  return next();
}

// Keep the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, WINDOW_MS).unref();

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get('/healthz', (req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

// Lets the UI know whether it must prompt for a token, without leaking it.
app.get('/api/meta', (req, res) => {
  res.json({ tokenRequired: true, tokenIsGenerated: GENERATED });
});

app.get('/api/codex/status', requireToken, rateLimit, async (req, res) => {
  try {
    const s = await codex.checkStatus();
    res.json(s);
  } catch (e) {
    res.status(500).json({
      available: false, authenticated: false, status: 'ERROR',
      detail: 'Unexpected error while checking Codex status.',
    });
  }
});

app.post('/api/chat', requireToken, rateLimit, async (req, res) => {
  const message = req.body && req.body.message;

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, code: 'INVALID_INPUT', error: 'Field "message" must be a non-empty string.' });
  }

  // Refuse before spending a process if we already know auth is missing.
  const status = await codex.checkStatus();
  if (status.status === 'CLI_NOT_AVAILABLE') {
    return res.status(503).json({ success: false, code: 'CLI_NOT_AVAILABLE', error: 'Codex CLI is not available on this server.' });
  }
  if (!status.authenticated) {
    return res.status(503).json({ success: false, code: 'NOT_AUTHENTICATED', error: 'Codex is not authenticated' });
  }

  const result = await codex.runPrompt(message);
  if (!result.success) {
    const httpCode = result.code === 'BUSY' ? 429
      : result.code === 'TIMEOUT' ? 504
      : result.code === 'PROMPT_TOO_LONG' || result.code === 'INVALID_INPUT' ? 400
      : 502;
    return res.status(httpCode).json(result);
  }
  return res.json({ success: true, response: result.response, durationMs: result.durationMs });
});

// Step 6 endpoint, kept exactly as specified in the brief.
app.post('/test-codex', requireToken, rateLimit, async (req, res) => {
  const prompt = (req.body && (req.body.prompt || req.body.message)) || '';
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'Field "prompt" must be a non-empty string.' });
  }
  const result = await codex.runPrompt(prompt);
  if (!result.success) return res.status(502).json(result);
  return res.json({ success: true, response: result.response });
});

/* ---- Browser-driven ChatGPT sign-in (device code flow) ---- */

// Starts the flow and returns ONLY a public URL + a short-lived device code.
app.post('/api/codex/login/start', requireToken, rateLimit, async (req, res) => {
  try {
    const s = await login.startLogin();
    res.json(s);
  } catch (e) {
    res.status(500).json({ state: 'ERROR', error: 'Could not start the login flow.' });
  }
});

// Polled by the UI until the user approves on their own device.
app.get('/api/codex/login/status', requireToken, async (req, res) => {
  try {
    res.json(await login.getLoginState());
  } catch (e) {
    res.status(500).json({ state: 'ERROR', error: 'Could not read login state.' });
  }
});

app.post('/api/codex/login/cancel', requireToken, rateLimit, (req, res) => {
  try {
    res.json(login.cancelLogin());
  } catch (e) {
    res.status(500).json({ state: 'ERROR', error: 'Could not cancel the login flow.' });
  }
});

// Deep diagnosis of why Codex will not execute. Paths and permission bits only.
app.get('/api/diagnose', requireToken, rateLimit, (req, res) => {
  try {
    codex.resetBinCache();          // re-resolve after any chmod repair
    res.json(diagnose());
  } catch (e) {
    res.status(500).json({ conclusion: 'ERROR', remedy: 'Diagnostic failed: ' + (e && e.message) });
  }
});

// Environment report - variable NAMES only, never values.
app.get('/api/env', requireToken, rateLimit, (req, res) => {
  const os = require('os');
  res.json({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    cwd: process.cwd(),
    home: os.homedir(),
    tmpdir: os.tmpdir(),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    cpus: os.cpus().length,
    codexBinResolved: !!codex.resolveCodexBin(),
    scratchDir: codex.getScratchDir(),
    limits: {
      timeoutMs: codex.CONFIG.timeoutMs,
      maxPromptChars: codex.CONFIG.maxPromptChars,
      maxConcurrent: codex.CONFIG.maxConcurrent,
    },
    envVarNamesOnly: Object.keys(process.env).sort(),
  });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isBadJson = err && err.type === 'entity.parse.failed';
  res.status(isBadJson ? 400 : 500).json({
    success: false,
    error: isBadJson ? 'Malformed JSON body.' : 'Internal server error.',
  });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

const server = app.listen(PORT, () => {
  console.log(`[codex-poc] listening on port ${PORT}`);
  console.log(`[codex-poc] node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(`[codex-poc] codex binary resolved: ${codex.resolveCodexBin() ? 'yes' : 'NO'}`);
  if (GENERATED) {
    console.log('[codex-poc] ------------------------------------------------------');
    console.log(`[codex-poc] POC_TOKEN was not set. Generated for this run:`);
    console.log(`[codex-poc]   ${POC_TOKEN}`);
    console.log('[codex-poc] Paste this into the web UI to unlock it.');
    console.log('[codex-poc] Set POC_TOKEN in Hostinger to keep it stable across restarts.');
    console.log('[codex-poc] ------------------------------------------------------');
  } else {
    console.log('[codex-poc] POC_TOKEN loaded from environment (value not logged).');
  }
});

function shutdown(sig) {
  console.log(`[codex-poc] ${sig} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
