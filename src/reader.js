'use strict';

// Archive access stays behind this interface. Only the active chapter and its
// immediate neighbours are decompressed; the multi-GB ZIP itself stays on disk.
class CbzSource {
  static async open(file) {
    const reader = new zip.ZipReader(new zip.BlobReader(file), { useWebWorkers: false });
    try {
      const entries = (await reader.getEntries()).filter(entry =>
        !entry.directory && /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(entry.filename)
        && !entry.filename.split('/').some(part => part.startsWith('.'))
        && !entry.filename.startsWith('__MACOSX/')
      );
      if (!entries.length) throw new Error('This archive contains no supported images.');
      if (entries.length > 50000) throw new Error('This archive contains more than 50,000 images.');
      if (entries.some(entry => entry.encrypted)) throw new Error('Password-protected archives are not supported.');
      if (entries.some(entry => entry.uncompressedSize > 128 * 1024 * 1024)) throw new Error('An image in this archive exceeds 128 MB.');
      const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      entries.sort((a, b) => order.compare(a.filename, b.filename) || a.filename.localeCompare(b.filename));
      const chapters = [];
      for (const entry of entries) {
        const match = entry.filename.match(/_ch(\d+(?:\.\d+)?)_p\d+/i);
        const folder = entry.filename.includes('/') ? entry.filename.slice(0, entry.filename.lastIndexOf('/')) : '';
        const group = match ? `chapter:${match[1]}` : `folder:${folder}`;
        let chapter = chapters[chapters.length - 1];
        // Real chapter folders/names are kept. Flat archives are divided into
        // short reading segments instead of decompressing thousands of pages.
        if (!chapter || chapter.group !== group || chapter.pages.length >= (match ? 60 : 30)) {
          const number = match ? match[1] : folder || String(chapters.length + 1);
          chapter = { number, group, pages: [] };
          chapters.push(chapter);
        }
        chapter.pages.push({ filename: entry.filename, entry });
      }
      return new CbzSource(file, reader, chapters);
    } catch (error) {
      await reader.close();
      throw error;
    }
  }

  constructor(file, reader, chapters) {
    this.id = `cbz:${file.name}:${file.size}:${file.lastModified}`;
    this.title = file.name.replace(/\.(cbz|zip)$/i, '');
    this.reader = reader;
    this.chapters = chapters;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  prepare(index) {
    if (this.closed) return Promise.reject(new Error('This archive is closed.'));
    if (this.cache.has(index)) return this.cache.get(index);
    const work = this.queue.then(async () => {
      const resources = [];
      try {
        for (const page of this.chapters[index].pages) {
          if (this.closed) throw new Error('This archive is closed.');
          const blob = await page.entry.getData(new zip.BlobWriter(), { checkSignature: true, useWebWorkers: false });
          const url = URL.createObjectURL(blob);
          resources.push(url);
          if (!page.width) {
            const dimensions = await imageDimensions(blob, url);
            page.width = dimensions.width;
            page.height = dimensions.height;
          }
        }
        return resources;
      } catch (error) {
        resources.forEach(url => URL.revokeObjectURL(url));
        this.cache.delete(index);
        throw error;
      }
    });
    this.cache.set(index, work);
    this.queue = work.catch(() => {});
    return work;
  }

  release(index) {
    const resources = this.cache.get(index);
    this.cache.delete(index);
    resources?.then(urls => urls.forEach(url => URL.revokeObjectURL(url)), () => {});
  }

  async close() {
    this.closed = true;
    await this.queue;
    for (const index of this.cache.keys()) this.release(index);
    await this.reader.close();
  }
}

async function imageDimensions(blob, url) {
  // JPEG headers can be read without decoding a huge, tall webtoon into pixels.
  const bytes = new Uint8Array(await blob.slice(0, 262144).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 0xff) continue;
      while (bytes[offset] === 0xff) offset++;
      const code = bytes[offset++];
      if (code === 0x01 || code >= 0xd0 && code <= 0xd9) continue;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(code)) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      const length = view.getUint16(offset);
      if (length < 2) break;
      offset += length;
    }
  }
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const image = new Image();
  image.src = url;
  await image.decode();
  const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
  image.removeAttribute('src');
  if (!dimensions.width || !dimensions.height) throw new Error('Cannot determine the image dimensions.');
  return dimensions;
}

const $ = id => document.getElementById(id);
const key = 'comic-reader-v1';
// Migration only: these old settings never select or load a book.
const legacyKey = 'solo-leveling-local-reader-v1';
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
let source = null;
let chapters = [];
let storageWorks = true;
let state = { chapter: 0, bookmarks: {}, width: 820, light: false, infinite: true };
function readStorage(storageKey) {
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); }
  catch { storageWorks = false; return null; }
}
const storedState = readStorage(key) || readStorage(legacyKey);
if (storedState && typeof storedState === 'object') {
  for (const setting of ['width', 'light', 'infinite']) {
    if (setting in storedState) state[setting] = storedState[setting];
  }
}
state.width = clamp(Number(state.width) || 820, 480, 1400);
let current = 0;
let images = [];
let restoring = false;
let headerHidden = false;
let headerHovered = false;
let pointerAtTop = false;
let previousScroll = 0;
let restoreVersion = 0;
let navigationVersion = 0;
let openingVersion = 0;
let saveTimer;
let scrollScheduled = false;
let appending = false;
let appendTask = null;
const sections = new Map();

function persist() {
  try {
    localStorage.setItem(key, JSON.stringify({ width: state.width, light: state.light, infinite: state.infinite }));
    if (source) localStorage.setItem(`${key}:${source.id}`, JSON.stringify({ chapter: current, bookmarks: state.bookmarks }));
  } catch { storageWorks = false; }
  $('saving').textContent = source ? (storageWorks ? 'Position saved automatically' : 'Your browser blocked position saving') : '';
}

function notify(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = false;
}

function address() {
  const parameters = new URLSearchParams(location.hash.slice(1));
  if (!source || !parameters.has('chapter') || parameters.get('book') !== source.id) return null;
  const index = Number(parameters.get('chapter'));
  if (!Number.isInteger(index) || index < 0 || index >= chapters.length) return null;
  return { index, bookmark: { page: Math.max(0, Number(parameters.get('page')) || 0), offset: clamp(Number(parameters.get('offset')) || 0, 0, 1) } };
}

function updateAddress(bookmark) {
  const parameters = new URLSearchParams({ chapter: current, page: bookmark.page, offset: bookmark.offset.toFixed(5) });
  parameters.set('book', source.id);
  try { history.replaceState(null, '', '#' + parameters); } catch { /* file:// history restrictions */ }
}

function setHeaderVisible(visible) {
  headerHidden = !visible;
  document.body.classList.toggle('header-hidden', headerHidden);
}
function headerHeight() { return headerHidden ? 0 : $('toolbar').offsetHeight; }
function viewportTop() { return scrollY + headerHeight(); }

function findChapter() {
  const top = viewportTop() + 1;
  let found = sections.keys().next().value;
  for (const [index, section] of sections) {
    if (section.node.offsetTop > top) break;
    found = index;
  }
  return found ?? current;
}

function bookmarkNow() {
  if (!images.length) return { page: 0, offset: 0 };
  const top = viewportTop();
  let low = 0;
  let high = images.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (images[middle].offsetTop <= top) low = middle;
    else high = middle - 1;
  }
  const image = images[low];
  return { page: low, offset: clamp((top - image.offsetTop) / Math.max(1, image.offsetHeight), 0, 1) };
}

function capture() {
  if (!source || restoring || !images.length) return;
  const bookmark = bookmarkNow();
  state.chapter = current;
  state.bookmarks[current] = bookmark;
  updateAddress(bookmark);
  persist();
}

function navigation() {
  $('chapter').value = String(current);
  $('previous').disabled = current === 0;
  $('next').disabled = current === chapters.length - 1;
  const last = Math.max(...sections.keys(), current);
  $('continue').disabled = last === chapters.length - 1;
  $('continue').textContent = last === chapters.length - 1 ? 'End of book' : 'Next chapter →';
  document.title = `Chapter ${chapters[current].number} — ${source.title}`;
  document.body.dataset.chapter = String(current);
}

function updateProgress() {
  if (!images.length || restoring) return;
  const index = findChapter();
  if (index !== current) {
    capture();
    current = index;
    images = sections.get(index).images;
    navigation();
  }
  const bookmark = bookmarkNow();
  const first = images[0].offsetTop;
  const last = images[images.length - 1];
  const end = last.offsetTop + last.offsetHeight;
  const percent = Math.round(clamp((viewportTop() - first) / Math.max(1, end - first - innerHeight + headerHeight()), 0, 1) * 100);
  $('progress').value = percent;
  $('position').textContent = `Chapter ${current + 1}/${chapters.length} · Image ${bookmark.page + 1}/${images.length} · ${percent}%`;
  document.body.dataset.page = String(bookmark.page);
  refreshNearby();
  maybeAppend();
}

async function restore(bookmark) {
  if (!images.length) return;
  const version = ++restoreVersion;
  restoring = true;
  const page = clamp(Math.trunc(Number(bookmark?.page) || 0), 0, images.length - 1);
  const offset = clamp(Number(bookmark?.offset) || 0, 0, 1);
  if (page || offset) setHeaderVisible(false);
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (version !== restoreVersion) return;
  if (page === 0 && offset === 0) scrollTo(0, Math.max(0, sections.get(current).node.offsetTop - $('toolbar').offsetHeight));
  else scrollTo(0, images[page].offsetTop + images[page].offsetHeight * offset - headerHeight());
  previousScroll = scrollY;
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (version !== restoreVersion) return;
  restoring = false;
  updateProgress();
  capture();
}

function addSection(index, urls) {
  const chapter = chapters[index];
  const node = document.createElement('section');
  node.dataset.chapter = index;
  const title = document.createElement('h2');
  title.className = 'chapter-title';
  if (!sections.size) title.id = 'chapter-title';
  title.textContent = `Chapter ${chapter.number}`;
  node.append(title);
  const elements = chapter.pages.map((page, pageIndex) => {
    const image = document.createElement('img');
    image.width = page.width;
    image.height = page.height;
    image.alt = `Chapter ${chapter.number}, image ${pageIndex + 1}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = urls[pageIndex];
    image.addEventListener('error', () => {
      // Released archive pages intentionally have no src until scrolled back.
      if (image.hasAttribute('src')) {
        image.classList.add('failed');
        notify(`Cannot display ${page.filename}.`);
      }
    });
    node.append(image);
    return image;
  });
  $('pages').append(node);
  sections.set(index, { node, images: elements, loaded: true });
}

async function showChapter(index, bookmark) {
  if (!source) return;
  capture();
  clearTimeout(saveTimer);
  const version = ++navigationVersion;
  const activeSource = source;
  index = clamp(Math.trunc(Number(index) || 0), 0, chapters.length - 1);
  try {
    const urls = await activeSource.prepare(index);
    if (version !== navigationVersion || source !== activeSource) return;
    restoreVersion++;
    appending = false;
    appendTask = null;
    $('pages').replaceChildren();
    sections.clear();
    current = index;
    addSection(index, urls);
    images = sections.get(index).images;
    setHeaderVisible(true);
    navigation();
    document.body.dataset.ready = 'true';
    await restore(bookmark ?? state.bookmarks[index] ?? { page: 0, offset: 0 });
  } catch (error) {
    if (error.name !== 'AbortError' && version === navigationVersion && source === activeSource) notify(`Cannot open chapter: ${error.message}`);
  }
}

function appendNext() {
  if (appendTask) return appendTask;
  const task = performAppend();
  appendTask = task;
  task.finally(() => { if (appendTask === task) appendTask = null; });
  return task;
}

async function performAppend() {
  if (appending || !sections.size) return;
  const index = Math.max(...sections.keys()) + 1;
  if (index >= chapters.length) return;
  appending = true;
  const version = navigationVersion;
  const activeSource = source;
  try {
    const urls = await activeSource.prepare(index);
    if (version !== navigationVersion || source !== activeSource) return;
    addSection(index, urls);
    navigation();
  } catch (error) {
    if (version === navigationVersion && source === activeSource) {
      if (error.name === 'AbortError') return;
      notify(`Cannot load the next chapter: ${error.message}`);
      state.infinite = false;
      $('infinite').checked = false;
      persist();
    }
  } finally {
    if (version === navigationVersion && source === activeSource) appending = false;
  }
}

function maybeAppend() {
  if (!state.infinite || restoring || !sections.size) return;
  const last = sections.get(Math.max(...sections.keys())).node;
  if (last.getBoundingClientRect().bottom - innerHeight < innerHeight * 1.5) appendNext();
}

function refreshNearby() {
  if (!source) return;
  const activeSource = source;
  const version = navigationVersion;
  for (const [index, section] of sections) {
    if (Math.abs(index - current) <= 1) {
      if (!section.loaded) {
        section.loaded = true;
        activeSource.prepare(index).then(urls => {
          if (version !== navigationVersion || source !== activeSource) return;
          section.images.forEach((image, i) => { image.src = urls[i]; });
        }).catch(error => {
          section.loaded = false;
          if (error.name !== 'AbortError' && source === activeSource) notify(error.message);
        });
      }
    } else if (section.loaded) {
      section.loaded = false;
      section.images.forEach(image => image.removeAttribute('src'));
      activeSource.release(index);
    }
  }
  // Chapter navigation can leave cached entries without rendered sections.
  for (const index of activeSource.cache.keys()) {
    if (Math.abs(index - current) > 1) activeSource.release(index);
  }
}

async function useSource(nextSource) {
  capture();
  const previousSource = source;
  navigationVersion++;
  restoreVersion++;
  restoring = false;
  appending = false;
  appendTask = null;
  sections.clear();
  images = [];
  $('pages').replaceChildren();
  source = nextSource;
  document.body.dataset.source = source.id;
  chapters = source.chapters;
  const saved = readStorage(`${key}:${source.id}`) || readStorage(`${legacyKey}:${source.id}`);
  state.chapter = Number(saved?.chapter) || 0;
  state.bookmarks = saved?.bookmarks && typeof saved.bookmarks === 'object' ? saved.bookmarks : {};
  $('book-title').textContent = source.title;
  $('book-title').title = source.title;
  $('close-book').hidden = false;
  $('empty-state').hidden = true;
  document.querySelector('footer').hidden = false;
  $('notice').hidden = true;
  $('chapter').replaceChildren();
  $('chapter').disabled = false;
  chapters.forEach((chapter, index) => $('chapter').add(new Option(`Chapter ${chapter.number} · ${index + 1}/${chapters.length}`, String(index))));
  if (previousSource && previousSource !== source) previousSource.close();
  const target = address();
  await showChapter(target ? target.index : state.chapter, target?.bookmark);
}

async function closeBook() {
  capture();
  openingVersion++;
  navigationVersion++;
  restoreVersion++;
  const previousSource = source;
  source = null;
  chapters = [];
  images = [];
  sections.clear();
  $('pages').replaceChildren();
  current = 0;
  state.chapter = 0;
  state.bookmarks = {};
  restoring = false;
  appending = false;
  appendTask = null;
  clearTimeout(saveTimer);
  resetFilePicker();
  $('book-title').textContent = 'Comic Reader';
  $('book-title').removeAttribute('title');
  document.title = 'Comic Reader';
  $('close-book').hidden = true;
  $('empty-state').hidden = false;
  document.querySelector('footer').hidden = true;
  $('chapter').replaceChildren(new Option('No book open'));
  $('chapter').disabled = true;
  $('previous').disabled = true;
  $('next').disabled = true;
  $('progress').value = 0;
  $('position').textContent = 'No book open';
  $('saving').textContent = '';
  $('notice').hidden = true;
  document.body.dataset.source = '';
  document.body.dataset.ready = 'true';
  delete document.body.dataset.chapter;
  delete document.body.dataset.page;
  setHeaderVisible(true);
  scrollTo(0, 0);
  previousScroll = 0;
  if (previousSource) await previousSource.close();
}

async function openArchive(file) {
  if (!file) return;
  const version = ++openingVersion;
  $('open-cbz').disabled = true;
  $('open-cbz').textContent = 'Opening…';
  $('open-start').disabled = true;
  let archive;
  try {
    archive = await CbzSource.open(file);
    const saved = readStorage(`${key}:${archive.id}`) || readStorage(`${legacyKey}:${archive.id}`);
    await archive.prepare(clamp(Math.trunc(Number(saved?.chapter) || 0), 0, archive.chapters.length - 1));
    if (version !== openingVersion) { await archive.close(); return; }
    await useSource(archive);
  } catch (error) {
    if (archive && archive !== source) await archive.close();
    if (version === openingVersion && error.name !== 'AbortError') notify(`Cannot open CBZ: ${error.message}`);
  } finally {
    if (version === openingVersion) {
      resetFilePicker();
    }
  }
}

function resetFilePicker() {
  $('open-cbz').disabled = false;
  $('open-cbz').textContent = 'Open CBZ';
  $('open-start').disabled = false;
  $('cbz-file').value = '';
}

function appearance() {
  document.documentElement.classList.toggle('light', Boolean(state.light));
  document.documentElement.style.setProperty('--reader-width', `${state.width}px`);
  $('width').value = state.width;
  $('width-label').textContent = `${state.width} px`;
  $('infinite').checked = Boolean(state.infinite);
  $('theme').textContent = state.light ? 'Dark theme' : 'Light theme';
  $('theme').setAttribute('aria-label', state.light ? 'Switch to dark theme' : 'Switch to light theme');
}

$('previous').addEventListener('click', () => showChapter(current - 1));
$('next').addEventListener('click', () => showChapter(current + 1));
$('continue').addEventListener('click', () => state.infinite ? appendNext() : showChapter(current + 1));
$('chapter').addEventListener('change', event => showChapter(event.target.value));
$('open-cbz').addEventListener('click', () => $('cbz-file').click());
$('open-start').addEventListener('click', () => $('cbz-file').click());
$('cbz-file').addEventListener('change', event => openArchive(event.target.files[0]));
$('close-book').addEventListener('click', closeBook);
$('close-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('infinite').addEventListener('change', async event => {
  capture();
  const bookmark = bookmarkNow();
  state.infinite = event.target.checked;
  persist();
  if (state.infinite) maybeAppend();
  else if (source) await showChapter(current, bookmark);
});
$('width').addEventListener('input', event => {
  const bookmark = bookmarkNow();
  state.width = Number(event.target.value);
  appearance();
  if (source) restore(bookmark);
  else persist();
});
$('theme').addEventListener('click', () => { state.light = !state.light; appearance(); persist(); });
$('show-header').addEventListener('mouseenter', () => setHeaderVisible(true));
$('show-header').addEventListener('focus', () => setHeaderVisible(true));
$('show-header').addEventListener('click', () => setHeaderVisible(true));
$('toolbar').addEventListener('mouseenter', () => { headerHovered = true; setHeaderVisible(true); });
$('toolbar').addEventListener('mouseleave', () => { headerHovered = false; });
document.addEventListener('mousemove', event => {
  pointerAtTop = event.clientY <= 20;
  if (pointerAtTop) setHeaderVisible(true);
}, { passive: true });
$('toolbar').addEventListener('focusin', () => setHeaderVisible(true));
addEventListener('scroll', () => {
  if (restoring || !source) return;
  const movement = scrollY - previousScroll;
  if (scrollY < 40 || movement < -6) setHeaderVisible(true);
  else if (scrollY > 80 && movement > 6 && !headerHovered && !pointerAtTop) setHeaderVisible(false);
  if (Math.abs(movement) > 6) previousScroll = scrollY;
  if (!scrollScheduled) {
    scrollScheduled = true;
    requestAnimationFrame(() => { scrollScheduled = false; updateProgress(); });
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(capture, 300);
}, { passive: true });
addEventListener('resize', () => { if (!restoring && images.length) restore(state.bookmarks[current] ?? bookmarkNow()); });
addEventListener('pagehide', capture);
document.addEventListener('visibilitychange', () => { if (document.hidden) capture(); });
addEventListener('hashchange', () => { const target = address(); if (target) showChapter(target.index, target.bookmark); });
addEventListener('keydown', async event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) return;
  if (event.key === 'Escape') { setHeaderVisible(true); return; }
  if (!event.shiftKey && event.key === 'ArrowRight' && current < chapters.length - 1) {
    event.preventDefault(); await showChapter(current + 1);
  } else if (!event.shiftKey && event.key === 'ArrowLeft' && current > 0) {
    event.preventDefault(); await showChapter(current - 1);
  } else if (!event.shiftKey && event.code === 'Space' && images.length) {
    const last = images[images.length - 1];
    const atEnd = last.getBoundingClientRect().bottom <= innerHeight + 4;
    if (atEnd && current < chapters.length - 1) {
      event.preventDefault();
      if (state.infinite) {
        if (!sections.has(current + 1)) await appendNext();
        const nextSection = sections.get(current + 1);
        if (nextSection) { scrollTo(0, nextSection.node.offsetTop); setHeaderVisible(false); updateProgress(); capture(); }
      } else await showChapter(current + 1, { page: 0, offset: 0 });
    }
  }
});
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-height', `${$('toolbar').offsetHeight}px`);
}).observe($('toolbar'));
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
appearance();
document.body.dataset.ready = 'true';
