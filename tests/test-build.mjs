import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../build.mjs', import.meta.url)));
const temporaryRoot = existsSync('C:\\Temp\\opencode') ? 'C:\\Temp\\opencode' : tmpdir();
const runBuild = (...args) => spawnSync(process.execPath, [join(root, 'build.mjs'), ...args], { encoding: 'utf8' });

test('update replaces the output without creating backup files', () => {
  const folder = mkdtempSync(join(temporaryRoot, 'cbf-reader-build-'));
  try {
    const output = join(folder, 'reader.html');
    writeFileSync(output, 'old output');

    const result = runBuild('--update', '--output', output);

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /<title>Comic Reader<\/title>/);
    assert.deepEqual(readdirSync(folder), ['reader.html']);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('existing output requires the update flag', () => {
  const folder = mkdtempSync(join(temporaryRoot, 'cbf-reader-build-'));
  try {
    const output = join(folder, 'reader.html');
    writeFileSync(output, 'keep this');

    const result = runBuild('--output', output);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /without --update/);
    assert.equal(readFileSync(output, 'utf8'), 'keep this');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('builder runs from another working directory and reproduces the committed HTML', () => {
  const folder = mkdtempSync(join(temporaryRoot, 'cbf-reader-build-'));
  try {
    const result = spawnSync(process.execPath, [join(root, 'build.mjs'), '--output', 'reader.html'], {
      cwd: folder, encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(folder, 'reader.html')), readFileSync(join(root, 'cbf-reader.html')));
    assert.ok(!readFileSync(join(folder, 'reader.html'), 'utf8').includes('\r'));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
