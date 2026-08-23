#!/usr/bin/env node
/** Why won't Codex run here? Run this on the server. */
'use strict';
const { diagnose } = require('../src/diagnose');
const r = diagnose();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}
console.log('='.repeat(64));
console.log(' CODEX EXECUTION DIAGNOSIS');
console.log('='.repeat(64));
console.log('platform          :', r.platform, '| node', r.node);
console.log('app dir           :', r.appDir);
console.log('@openai packages  :', r.installedPlatformPackages.join(', ') || '(none)');
console.log('\n-- launcher shim -------------------------------------------------');
console.log(JSON.stringify(r.shim, null, 2));
console.log('\n-- .bin/codex ----------------------------------------------------');
console.log(JSON.stringify(r.dotbin, null, 2));
console.log('\n-- native binaries -----------------------------------------------');
if (!r.nativeBinaries.length) console.log('  NONE FOUND');
for (const b of r.nativeBinaries) {
  console.log(`  ${b.path}\n    mode=${b.mode} executable=${b.executable} sizeMB=${b.sizeMB}`);
}
console.log('\n-- chmod repair --------------------------------------------------');
console.log(r.chmodAttempt ? JSON.stringify(r.chmodAttempt) : '  (no native binary to repair)');
console.log('\n-- can this account execute files it writes? ---------------------');
for (const [k, v] of Object.entries(r.execPermissions)) {
  console.log(`  ${k.padEnd(8)}: ${v.ok ? 'YES' : 'NO  (' + (v.reason || '?') + ')'}`);
}
console.log('\n-- run attempts --------------------------------------------------');
for (const [k, v] of Object.entries(r.runAttempts)) {
  console.log(`  ${k.padEnd(8)}: ${v.ok ? 'OK  ' + (v.out || '') : 'FAIL (' + (v.reason || 'status ' + v.status) + ')'}`);
}
console.log('\n' + '='.repeat(64));
console.log(' CONCLUSION:', r.conclusion);
console.log(' REMEDY    :', r.remedy);
console.log('='.repeat(64));
