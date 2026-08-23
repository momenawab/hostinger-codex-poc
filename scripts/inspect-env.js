#!/usr/bin/env node
/**
 * Step 1 — Environment inspection.
 *
 * Run this ON THE HOSTINGER SERVER to discover what the runtime actually allows.
 *   node scripts/inspect-env.js          (human readable)
 *   node scripts/inspect-env.js --json   (machine readable)
 *
 * SECURITY: environment variables are reported by NAME ONLY. Values are never
 * read, printed, or written anywhere by this script.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const asJson = process.argv.includes('--json');

function tryCmd(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 10000,
      shell: false,
    });
    if (r.error) return { ok: false, reason: r.error.code || r.error.message };
    if (r.status !== 0) {
      return { ok: false, reason: `exit ${r.status}`, stderr: (r.stderr || '').trim().slice(0, 200) };
    }
    return { ok: true, output: (r.stdout || r.stderr || '').trim().split('\n')[0].slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

function writableDir(dir) {
  try {
    const probe = path.join(dir, `.wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return { writable: true };
  } catch (e) {
    return { writable: false, reason: e.code || e.message };
  }
}

// Can we create a file and mark it executable, then run it?
// This is the key test for "can a downloaded native binary actually execute here"
// (i.e. is the filesystem mounted noexec?).
function execBitTest(dir) {
  const f = path.join(dir, `.exectest-${process.pid}.sh`);
  try {
    fs.writeFileSync(f, '#!/bin/sh\necho EXEC_OK\n', { mode: 0o755 });
    const r = spawnSync(f, [], { encoding: 'utf8', timeout: 10000, shell: false });
    fs.unlinkSync(f);
    if (r.error) return { ok: false, reason: r.error.code || r.error.message };
    return { ok: (r.stdout || '').includes('EXEC_OK'), reason: r.status !== 0 ? `exit ${r.status}` : undefined };
  } catch (e) {
    try { fs.unlinkSync(f); } catch (_) {}
    return { ok: false, reason: e.code || e.message };
  }
}

// Does a child process survive longer than a moment, and can we kill it?
function longRunningTest() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 60000)'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch (e) {
      return resolve({ ok: false, reason: e.code || e.message });
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    child.on('error', (e) => done({ ok: false, reason: e.code || e.message }));
    child.on('exit', (code, signal) => {
      // If it exited on its own before we killed it, something killed it early.
      if (!killedByUs) done({ ok: false, reason: `child exited early (code=${code} signal=${signal})` });
    });

    let killedByUs = false;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killedByUs = true;
        try { child.kill('SIGKILL'); } catch (_) {}
        done({ ok: true, note: 'child stayed alive 3s and was killable' });
      }
    }, 3000);
  });
}

async function main() {
  const report = {
    collectedAt: new Date().toISOString(),
    runtime: {
      nodeVersion: process.version,
      npmVersion: tryCmd('npm', ['--version']).output || null,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      // libc matters for native binaries. Codex ships a static musl build for
      // Linux, so glibc version should NOT be a blocker - we record it anyway.
      glibcOrMusl: process.report ? (() => {
        try { return process.report.getReport().header.glibcVersionRuntime || 'not-glibc (musl or static)'; }
        catch (_) { return 'unknown'; }
      })() : 'unknown',
      cpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
      uptimeSec: Math.round(os.uptime()),
    },
    paths: {
      cwd: process.cwd(),
      home: os.homedir(),
      tmpdir: os.tmpdir(),
      // PATH is not a secret; it is needed to explain binary resolution.
      PATH: process.env.PATH || '(unset)',
      user: (() => { try { return os.userInfo().username; } catch (e) { return 'unknown'; } })(),
    },
    tools: {
      node: tryCmd(process.execPath, ['--version']),
      npm: tryCmd('npm', ['--version']),
      npx: tryCmd('npx', ['--version']),
      sh: tryCmd('sh', ['-c', 'echo SH_OK']),
      bash: tryCmd('bash', ['-c', 'echo BASH_OK']),
      curl: tryCmd('curl', ['--version']),
      git: tryCmd('git', ['--version']),
      python3: tryCmd('python3', ['--version']),
      python: tryCmd('python', ['--version']),
      tar: tryCmd('tar', ['--version']),
    },
    filesystem: {
      cwdWritable: writableDir(process.cwd()),
      homeWritable: writableDir(os.homedir()),
      tmpWritable: writableDir(os.tmpdir()),
      execBitInHome: execBitTest(os.homedir()),
      execBitInTmp: execBitTest(os.tmpdir()),
    },
    childProcess: {
      canSpawn: null,
      longRunningAllowed: null,
    },
    // NAMES ONLY. No values. Sorted for stable diffing.
    envVarNamesOnly: Object.keys(process.env).sort(),
  };

  // Step 2 style basic spawn checks
  const basics = {
    'node --version': tryCmd(process.execPath, ['--version']),
    'npm --version': tryCmd('npm', ['--version']),
    whoami: tryCmd('whoami', []),
    pwd: tryCmd('pwd', []),
  };
  report.childProcess.canSpawn = Object.values(basics).some((b) => b.ok);
  report.childProcess.basicCommands = basics;
  report.childProcess.longRunningAllowed = await longRunningTest();

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const yn = (v) => (v ? 'YES' : 'NO');
  const L = [];
  L.push('='.repeat(64));
  L.push(' HOSTINGER / NODE ENVIRONMENT REPORT');
  L.push('='.repeat(64));
  L.push(`Collected      : ${report.collectedAt}`);
  L.push('');
  L.push('-- RUNTIME ------------------------------------------------------');
  L.push(`Node           : ${report.runtime.nodeVersion}`);
  L.push(`npm            : ${report.runtime.npmVersion || 'unavailable'}`);
  L.push(`Platform/Arch  : ${report.runtime.platform} / ${report.runtime.arch}`);
  L.push(`OS             : ${report.runtime.osType} ${report.runtime.osRelease}`);
  L.push(`libc           : ${report.runtime.glibcOrMusl}`);
  L.push(`CPUs / Mem     : ${report.runtime.cpus} cores / ${report.runtime.totalMemMB} MB total, ${report.runtime.freeMemMB} MB free`);
  L.push('');
  L.push('-- PATHS --------------------------------------------------------');
  L.push(`User           : ${report.paths.user}`);
  L.push(`CWD            : ${report.paths.cwd}`);
  L.push(`HOME           : ${report.paths.home}`);
  L.push(`TMPDIR         : ${report.paths.tmpdir}`);
  L.push(`PATH           : ${report.paths.PATH}`);
  L.push('');
  L.push('-- TOOLS --------------------------------------------------------');
  for (const [k, v] of Object.entries(report.tools)) {
    L.push(`${k.padEnd(15)}: ${v.ok ? 'OK   ' + v.output : 'MISSING (' + (v.reason || '?') + ')'}`);
  }
  L.push('');
  L.push('-- FILESYSTEM ---------------------------------------------------');
  L.push(`CWD writable   : ${yn(report.filesystem.cwdWritable.writable)} ${report.filesystem.cwdWritable.reason || ''}`);
  L.push(`HOME writable  : ${yn(report.filesystem.homeWritable.writable)} ${report.filesystem.homeWritable.reason || ''}`);
  L.push(`/tmp writable  : ${yn(report.filesystem.tmpWritable.writable)} ${report.filesystem.tmpWritable.reason || ''}`);
  L.push(`exec bit HOME  : ${yn(report.filesystem.execBitInHome.ok)} ${report.filesystem.execBitInHome.reason || ''}  <- native binaries need this`);
  L.push(`exec bit /tmp  : ${yn(report.filesystem.execBitInTmp.ok)} ${report.filesystem.execBitInTmp.reason || ''}`);
  L.push('');
  L.push('-- CHILD PROCESSES ----------------------------------------------');
  for (const [k, v] of Object.entries(report.childProcess.basicCommands)) {
    L.push(`${k.padEnd(15)}: ${v.ok ? 'OK   ' + v.output : 'FAIL (' + (v.reason || '?') + ')'}`);
  }
  L.push(`long-running   : ${yn(report.childProcess.longRunningAllowed.ok)} ${report.childProcess.longRunningAllowed.note || report.childProcess.longRunningAllowed.reason || ''}`);
  L.push('');
  L.push('-- ENV VARS (NAMES ONLY, NO VALUES) -----------------------------');
  L.push(`count          : ${report.envVarNamesOnly.length}`);
  L.push(report.envVarNamesOnly.join(', '));
  L.push('');
  L.push('Tip: `node scripts/inspect-env.js --json > env-report.json` to save it.');
  console.log(L.join('\n'));
}

main().catch((e) => {
  console.error('inspect-env failed:', e && e.message);
  process.exit(1);
});
