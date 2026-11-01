// Build a portable offline reader. No book data, dependencies, or backups.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));

function main() {
  const { values } = parseArgs({
    options: {
      update: { type: 'boolean', default: false },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node build.mjs [--update] [--output PATH]');
    console.log('--update replaces the existing generated reader without creating backups.');
    return;
  }
  const read = path => readFileSync(resolve(root, path), 'utf8').replace(/\r\n?/g, '\n');
  let html = read('src/reader.template.html');
  const parts = {
    __ZIP_JS__: read('vendor/zip-native.min.js'),
    __READER_JS__: read('src/reader.js'),
    __ZIP_LICENSE__: read('vendor/LICENSE').replaceAll('--', '—'),
  };
  for (const [marker, content] of Object.entries(parts)) {
    // A function replacement keeps literal $&, $`, and $' in bundled JavaScript.
    html = html.replaceAll(marker, () => content);
  }
  const destination = values.output ? resolve(values.output) : resolve(root, 'cbf-reader.html');
  if (existsSync(destination) && !values.update) {
    throw new Error(`Will not overwrite existing reader without --update: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, html, 'utf8');
  console.log(`Created ${destination}: standalone universal CBZ reader; no book loaded at startup.`);
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
