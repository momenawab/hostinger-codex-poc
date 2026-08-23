'use strict';
/**
 * Pinpoints WHY Codex will not execute.
 *
 * EACCES at spawn time has several distinct causes that need different fixes:
 *   1. the executable bit was stripped        -> chmod +x (we do it automatically)
 *   2. the filesystem is mounted noexec       -> copy the binary somewhere executable
 *   3. the wrong platform package installed   -> reinstall on the target OS
 *   4. the binary never installed at all      -> npm install / optional deps skipped
 *
 * This module distinguishes them and, where it safely can, repairs the problem.
 * It reports paths and permission bits only - never credentials.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const codex = require('./codex');

/** Can we mark a file +x in this directory AND actually run it? */
function execTest(dir) {
  const f = path.join(dir, `.exectest-${process.pid}-${Date.now()}.sh`);
  try {
    fs.writeFileSync(f, '#!/bin/sh\necho EXEC_OK\n', { mode: 0o755 });
    try { fs.chmodSync(f, 0o755); } catch (_) {}
    const r = spawnSync(f, [], { encoding: 'utf8', timeout: 10000, shell: false });
    const ok = !r.error && (r.stdout || '').includes('EXEC_OK');
    fs.unlinkSync(f);
    return { ok, reason: r.error ? (r.error.code || r.error.message) : undefined };
  } catch (e) {
    try { fs.unlinkSync(f); } catch (_) {}
    return { ok: false, reason: e.code || e.message };
  }
}

function statInfo(p) {
  try {
    const st = fs.lstatSync(p);
    const out = {
      exists: true,
      isSymlink: st.isSymbolicLink(),
      mode: (st.mode & 0o777).toString(8),
      executable: !!(st.mode & 0o111),
      sizeMB: +(st.size / 1048576).toFixed(1),
    };
    if (out.isSymlink) {
      try { out.target = fs.readlinkSync(p); } catch (_) {}
      try {
        const rst = fs.statSync(p);
        out.targetMode = (rst.mode & 0o777).toString(8);
        out.targetExecutable = !!(rst.mode & 0o111);
        out.targetSizeMB = +(rst.size / 1048576).toFixed(1);
      } catch (e) { out.targetError = e.code || e.message; }
    }
    return out;
  } catch (e) {
    return { exists: false, reason: e.code || e.message };
  }
}

function diagnose() {
  const appDir = path.join(__dirname, '..');
  const openaiDir = path.join(appDir, 'node_modules', '@openai');
  const shim = path.join(openaiDir, 'codex', 'bin', 'codex.js');
  const dotbin = path.join(appDir, 'node_modules', '.bin', 'codex');

  const report = {
    checkedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    appDir,
    installedPlatformPackages: (() => {
      try { return fs.readdirSync(openaiDir); } catch (e) { return []; }
    })(),
    shim: statInfo(shim),
    dotbin: statInfo(dotbin),
    nativeBinaries: [],
    execPermissions: {
      appDir: execTest(appDir),
      tmpdir: execTest(os.tmpdir()),
      home: execTest(os.homedir()),
    },
    chmodAttempt: null,
    runAttempts: {},
    conclusion: null,
    remedy: null,
  };

  for (const p of codex.nativeBinaryCandidates()) {
    const info = statInfo(p);
    if (info.exists) report.nativeBinaries.push(Object.assign({ path: p }, info));
  }

  report.chmodAttempt = codex.ensureNativeExecutable();

  // Attempt 1: run the launcher through node (needs no exec bit on the shim).
  if (report.shim.exists) {
    const r = spawnSync(process.execPath, [shim, '--version'], {
      encoding: 'utf8', timeout: 20000, shell: false,
      env: codex.buildChildEnv(), cwd: os.tmpdir(),
    });
    report.runAttempts.viaNode = r.error
      ? { ok: false, reason: r.error.code || r.error.message }
      : { ok: r.status === 0, status: r.status, out: (r.stdout || r.stderr || '').trim().slice(0, 300) };
  }

  // Attempt 2: run the native binary directly.
  const native = report.nativeBinaries[0];
  if (native) {
    const r = spawnSync(native.path, ['--version'], {
      encoding: 'utf8', timeout: 20000, shell: false,
      env: codex.buildChildEnv(), cwd: os.tmpdir(),
    });
    report.runAttempts.native = r.error
      ? { ok: false, reason: r.error.code || r.error.message }
      : { ok: r.status === 0, status: r.status, out: (r.stdout || r.stderr || '').trim().slice(0, 300) };
  }

  // ---- Interpret -----------------------------------------------------------
  const linuxPkgPresent = report.installedPlatformPackages.some((n) => /linux/.test(n));
  const anyNative = report.nativeBinaries.length > 0;
  const viaNodeOk = report.runAttempts.viaNode && report.runAttempts.viaNode.ok;
  const nativeOk = report.runAttempts.native && report.runAttempts.native.ok;

  if (viaNodeOk || nativeOk) {
    report.conclusion = 'WORKING';
    report.remedy = 'Codex executes correctly now. Restart the app and re-check status.';
  } else if (!anyNative) {
    report.conclusion = 'BINARY_NOT_INSTALLED';
    report.remedy = process.platform === 'linux' && !linuxPkgPresent
      ? 'The Linux platform package is missing. npm skipped optionalDependencies, or install ran on a different OS. Run: npm install --include=optional @openai/codex'
      : 'No native Codex binary found. Run npm install in the app directory.';
  } else if (report.execPermissions.appDir.ok === false && report.execPermissions.tmpdir.ok === true) {
    report.conclusion = 'NOEXEC_APP_DIR';
    report.remedy =
      'The application directory is mounted noexec, so no binary can run from it. ' +
      'Copy the Codex binary to an executable location and point CODEX_BIN at it. ' +
      'See the "noexec" section of the README.';
  } else if (report.execPermissions.appDir.ok === false && report.execPermissions.tmpdir.ok === false) {
    report.conclusion = 'NOEXEC_EVERYWHERE';
    report.remedy =
      'This account cannot execute any binary it writes, anywhere tested. Codex CLI cannot run ' +
      'on this hosting plan. Use the OpenAI HTTP API directly instead of the CLI.';
  } else {
    const reason =
      (report.runAttempts.viaNode && report.runAttempts.viaNode.reason) ||
      (report.runAttempts.native && report.runAttempts.native.reason) || 'unknown';
    if (/ENOEXEC|Exec format/i.test(String(reason))) {
      report.conclusion = 'WRONG_ARCHITECTURE';
      report.remedy = 'The installed binary is for a different OS/CPU. Delete node_modules and run npm install ON THE SERVER.';
    } else {
      report.conclusion = 'EXEC_FAILED';
      report.remedy = `Codex could not be executed (${reason}). Check the paths and permission bits above.`;
    }
  }

  return report;
}

module.exports = { diagnose };
