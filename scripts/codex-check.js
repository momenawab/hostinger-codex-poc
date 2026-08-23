#!/usr/bin/env node
/** Steps 3-5 - is Codex installed, authenticated, and can it answer? */
'use strict';
const codex = require('../src/codex');

(async () => {
  console.log('Step 3 - Codex CLI availability\n' + '-'.repeat(46));
  const bin = codex.resolveCodexBin();
  if (!bin) {
    console.log('Codex CLI: NOT FOUND');
    console.log('Install it locally with:  npm install @openai/codex');
    process.exit(1);
  }
  console.log('Resolved binary :', bin.cmd, bin.prefix.join(' '));
  console.log('codex --version :', codex.versionInfo() || 'failed');
  console.log('scratch dir     :', codex.getScratchDir());

  console.log('\nStep 4 - Authentication\n' + '-'.repeat(46));
  const s = await codex.checkStatus();
  console.log('status      :', s.status);
  console.log('available   :', s.available);
  console.log('authenticated:', s.authenticated);
  console.log('authMethod  :', s.authMethod || '(none)');
  console.log('detail      :', s.detail);

  if (!s.authenticated) {
    console.log('\nNot authenticated - skipping Step 5.');
    console.log('Headless login options are documented in README.md.');
    process.exit(2);
  }

  console.log('\nStep 5 - Minimal execution test\n' + '-'.repeat(46));
  const prompt = process.argv[2] || 'Reply with exactly: CODEX_HOSTINGER_TEST_OK';
  console.log('prompt :', prompt);
  const r = await codex.runPrompt(prompt);
  if (!r.success) {
    console.log('RESULT : FAILED  [' + r.code + '] ' + r.error);
    process.exit(3);
  }
  console.log('took   :', (r.durationMs / 1000).toFixed(1) + 's');
  console.log('response:');
  console.log('  ' + r.response.split('\n').join('\n  '));
  const pass = r.response.includes('CODEX_HOSTINGER_TEST_OK');
  console.log('\nVERDICT :', pass ? 'PASS - end-to-end chain works.' : 'Response received (marker not found).');
})().catch((e) => { console.error('check failed:', e && e.message); process.exit(1); });
