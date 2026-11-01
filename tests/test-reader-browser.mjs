// Run the browser checks using synthetic comics; no private files are required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const zip = createRequire(import.meta.url)('../vendor/zip-native.min.js');
zip.configure({ useWebWorkers: false });

// Original synthetic fixture: a 100×180 solid-colour PNG, not comic content.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAAC0CAIAAADtvh4sAAABK0lEQVR4nO3QUQkAIBTAQMMawogvlhX8G8LBAoxb+4weW/nBR8GCBSsPFixYebBgwcqDBQtWHixYsPJgwYKVBwsWrDxYsGDlwYIFKw8WLFh5sGDByoMFC1YeLFiw8mDBgpUHCxasPFiwYOXBggUrDxYsWHmwYMHKgwULVh4sWLDyYMGClQcLFqw8WLBg5cGCBSsPFixYebBgwcqDBQtWHixYsPJgwYKVBwsWrDxYsGDlwYIFKw8WLFh5sGDByoMFC1YeLFiw8mDBgpUHCxasPFiwYOXBggUrDxYsWHmwYMHKgwULVh4sWLDyYMGClQcLFqw8WLBg5cGCBSsPFixYebBgwcqDBQtWHixYsPJgwYKVBwsWrDxYsGDlwYIFKw8WLFh5sGDByoM171gX4QZh/vqKLV0AAAAASUVORK5CYII=',
  'base64',
);

async function fixtureZip(names, zip64 = false) {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false, zip64 });
  for (const name of names) {
    await writer.add(name, new zip.Uint8ArrayReader(png), { useWebWorkers: false, zip64 });
  }
  await writer.add('ComicInfo.xml', new zip.TextReader('<ComicInfo />'));
  await writer.add('__MACOSX/._cover.png', new zip.TextReader('not an image'));
  return Buffer.from(await writer.close());
}

function render(url, profile, archive, image) {
  const args = [join(here, 'render_reader.mjs'), url, profile];
  if (archive) {
    args.push(archive);
    if (image) args.push(image);
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function unescapeAttribute(value) {
  const entities = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
  return value.replace(/&(quot|amp|lt|gt|apos|#\d+|#x[\da-f]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()];
    return String.fromCodePoint(entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });
}

async function runTests(folder, archive, image) {
  const profile = join(folder, 'browser-profile');
  const readerFile = join(folder, 'cbf-reader.html');
  const source = readFileSync(join(project, 'cbf-reader.html'), 'utf8');
  writeFileSync(readerFile, source);
  const testFile = join(folder, '_reader-smoke-test.html');
  const standardFixture = await fixtureZip(['10/1.png', '2/10.png', '2/2.png', '2/1.png']);
  let smoke = readFileSync(join(here, 'reader-tests.js'), 'utf8');
  smoke = smoke.replace('__CBZ_FIXTURE__', standardFixture.toString('base64'));
  smoke = smoke.replace('__FLAT_FIXTURE__', (await fixtureZip(Array.from({ length: 95 }, (_, index) => `${95 - index}.png`))).toString('base64'));
  smoke = smoke.replace('__ZIP64_FIXTURE__', (await fixtureZip(['1.png'], true)).toString('base64'));
  writeFileSync(testFile, source.replace('</body>', () => `<script>${smoke}</script></body>`));
  try {
    const dom = render(pathToFileURL(testFile).href, profile);
    const match = dom.match(/data-smoke="([^"]+)"/);
    assert.ok(match, 'Browser smoke test did not finish.');
    const report = JSON.parse(unescapeAttribute(match[1]));
    console.log(JSON.stringify(report, null, 2));
    assert.ok(report.ok, JSON.stringify(report));
  } finally { rmSync(testFile, { force: true }); }

  const url = pathToFileURL(readerFile).href;
  for (const location of [`${url}#chapter=202&page=3&offset=0.4`, url]) {
    const dom = render(location, profile);
    assert.ok(dom.includes('<title>Comic Reader</title>') && !dom.includes('<img '));
    assert.ok(!dom.includes('data-chapter="202"'));
  }
  console.log('PASS: reload stays empty, including stale links and saved reading positions.');
  if (!archive) {
    archive = join(folder, 'file-picker-test.cbz');
    writeFileSync(archive, standardFixture);
  }
  const report = JSON.parse(render(url, profile, archive, image));
  assert.ok(report.ok, JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const { values } = parseArgs({
    options: { archive: { type: 'string' }, image: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: node tests/test-reader-browser.mjs [--archive PATH] [--image chapter/page.png]');
    return;
  }
  if (values.image && !values.archive) throw new Error('--image requires --archive');
  const temporaryRoot = existsSync('C:\\Temp\\opencode') ? 'C:\\Temp\\opencode' : tmpdir();
  const folder = mkdtempSync(join(temporaryRoot, 'cbf-reader-tests-'));
  try { await runTests(folder, values.archive ? resolve(values.archive) : undefined, values.image); }
  finally { rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
