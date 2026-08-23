#!/usr/bin/env node
/** Step 2 - can this Node process spawn children, and do long-running ones survive? */
'use strict';
const { spawnSync, spawn } = require('child_process');

const CMDS = [
  ['node --version', process.execPath, ['--version']],
  ['npm --version', 'npm', ['--version']],
  ['whoami', 'whoami', []],
  ['pwd', 'pwd', []],
  ['uname -a', 'uname', ['-a']],
];

console.log('Step 2 - child process execution\n' + '-'.repeat(46));
let okCount = 0;
for (const [label, cmd, args] of CMDS) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, shell: false });
  if (r.error) { console.log(`${label.padEnd(16)} FAIL  ${r.error.code || r.error.message}`); continue; }
  if (r.status !== 0) { console.log(`${label.padEnd(16)} FAIL  exit ${r.status}`); continue; }
  okCount++;
  console.log(`${label.padEnd(16)} OK    ${(r.stdout || '').trim().split('\n')[0].slice(0, 80)}`);
}

console.log(`\n${okCount}/${CMDS.length} commands succeeded.`);

// Long-running + killability
console.log('\nLong-running child test (10s process, killed at 3s)…');
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),10000)'], { stdio: 'ignore', shell: false });
const started = Date.now();
child.on('error', (e) => console.log('  FAIL  could not spawn:', e.code || e.message));
child.on('exit', (code, signal) => {
  const alive = Date.now() - started;
  if (signal === 'SIGKILL' && alive >= 2500) {
    console.log(`  OK    stayed alive ${alive}ms, then SIGKILL worked.`);
    console.log('\nLong-running child processes ARE permitted and killable.');
  } else {
    console.log(`  WARN  exited after ${alive}ms (code=${code} signal=${signal}) - it may have been killed by the host.`);
  }
});
setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
