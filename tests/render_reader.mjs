// Native Node/WebSocket CDP harness: real animation frames, no virtual clock/server.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const [url, profile, archiveFile, imageFile] = process.argv.slice(2);
const candidates = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const executable = candidates.find(candidate => candidate && existsSync(candidate));
if (!executable) throw new Error('Set BROWSER_PATH to a Chrome, Edge, or Chromium executable.');
const edge = spawn(executable, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const exited = new Promise(resolve => edge.once('exit', resolve));

let socket;
const deadline = setTimeout(() => { edge.kill(); process.exit(1); }, 45000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    edge.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    edge.on('exit', code => reject(new Error(`Edge exited: ${code}; ${stderr}`)));
    edge.on('error', reject);
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const loaded = new Promise(resolve => {
    const listener = message => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
        listeners.delete(listener);
        resolve();
      }
    };
    listeners.add(listener);
  });
  await send('Page.navigate', { url }, sessionId);
  await loaded;
  const expression = url.includes('_reader-smoke-test.html')
    ? `new Promise(resolve => {
        if (document.body.dataset.smoke) return resolve(document.documentElement.outerHTML);
        const observer = new MutationObserver(() => {
          if (document.body.dataset.smoke) { observer.disconnect(); resolve(document.documentElement.outerHTML); }
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-smoke'] });
      })`
    : 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.documentElement.outerHTML))))';
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  if (archiveFile) {
    const beforeOpen = await send('Runtime.evaluate', {
      expression: 'source === null && images.length === 0 && chapters.length === 0 && !document.querySelector("#pages img")',
      returnByValue: true,
    }, sessionId);
    if (!beforeOpen.result.value) throw new Error('A book was loaded before file selection.');
    const { root } = await send('DOM.getDocument', {}, sessionId);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#cbz-file' }, sessionId);
    await send('DOM.setFileInputFiles', { nodeId, files: [archiveFile] }, sessionId);
    const archiveTest = await send('Runtime.evaluate', {
      expression: `(async () => {
        await new Promise(resolve => {
          if (!$('open-cbz').disabled) return resolve();
          const observer = new MutationObserver(() => {
            if (!$('open-cbz').disabled) { observer.disconnect(); resolve(); }
          });
          observer.observe($('open-cbz'), { attributes: true, attributeFilter: ['disabled'] });
        });
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        assert(source instanceof CbzSource, 'file picker did not open the archive: ' + $('notice-text').textContent);
        assert(chapters.length > 0, 'the selected archive has no chapters');
        await showChapter(0, {page: 0, offset: 0});
        await images[0].decode();
        const firstDimensions = [images[0].naturalWidth, images[0].naturalHeight];
        assert(firstDimensions[0] > 0 && firstDimensions[1] > 0, 'image did not decode');
        const firstCachedImages = [...source.cache.keys()].reduce((count, index) => count + chapters[index].pages.length, 0);
        assert(firstCachedImages < 100, 'whole archive was decompressed');
        let targetedImage = null;
        const requestedImage = ${JSON.stringify(imageFile || null)};
        if (requestedImage) {
          const chapterIndex = chapters.findIndex(chapter => chapter.pages.some(page => page.filename === requestedImage));
          assert(chapterIndex >= 0, 'requested image was not found in the archive');
          const pageIndex = chapters[chapterIndex].pages.findIndex(page => page.filename === requestedImage);
          const urls = await source.prepare(chapterIndex);
          const image = new Image();
          image.src = urls[pageIndex];
          await image.decode();
          targetedImage = {filename: requestedImage, width: image.naturalWidth, height: image.naturalHeight};
          image.removeAttribute('src');
        }
        const middle = Math.floor(chapters.length / 2);
        const targetPage = Math.min(2, chapters[middle].pages.length - 1);
        await showChapter(middle, {page: targetPage, offset: 0.25});
        assert(current === middle && bookmarkNow().page === targetPage, 'random archive chapter navigation failed');
        assert(source.cache.size <= 3, 'old archive resources not released');
        await showChapter(chapters.length - 1, {page: 0, offset: 0});
        await images[0].decode();
        assert(current === chapters.length - 1 && images.length === chapters[current].pages.length, 'last archive chapter failed');
        const report = {ok: true, actualFilePicker: true, chapters: chapters.length,
          totalImages: chapters.reduce((count, chapter) => count + chapter.pages.length, 0),
          firstCachedImages, cacheAfterNavigation: source.cache.size,
          firstDimensions, lastChapter: chapters[current].number, targetedImage};
        const previousSource = source;
        await closeBook();
        assert(previousSource.closed && previousSource.cache.size === 0 && source === null, 'closing did not release archive');
        return report;
      })()`, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (archiveTest.exceptionDetails) throw new Error(JSON.stringify(archiveTest.exceptionDetails));
    process.stdout.write(JSON.stringify(archiveTest.result.value));
  } else process.stdout.write(result.result.value);
  await send('Browser.close');
  await exited;
} finally {
  clearTimeout(deadline);
  socket?.close();
  edge.kill();
}
