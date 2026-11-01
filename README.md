# CBF Reader

A portable, offline comic reader for CBZ and ZIP files. Open a single HTML file in your browser—no installation or web server required.

## Read

1. Download [`cbf-reader.html`](https://github.com/AndreiShenets/cbf-reader/raw/refs/heads/main/cbf-reader.html).
2. Open it in a modern browser, then click **Open CBZ** and select a comic.

The reader starts empty. It does not scan folders, automatically open a book, or upload files. You can move the HTML file anywhere; it does not depend on neighbouring images or source files.

## Features

- Vertical scrolling, adjustable page width, and light/dark themes.
- Optional **Continuous** mode that appends the next chapter.
- **Space** scrolls normally and advances at chapter boundaries; **← / →** switch chapters.
- The toolbar hides while scrolling down. Hover at the top edge, scroll upward, or press **Escape** to reveal it.
- Separate saved reading positions for each archive. Reselect the file after reopening the reader to resume.
- Natural filename ordering; chapter folders are preserved, and large flat archives use short reading segments.
- ZIP64 support and common image formats: JPEG, PNG, WebP, GIF, BMP, and AVIF, subject to browser support.

Password-protected archives, CBR/RAR files, and individual images larger than 128 MB are not supported.

## Memory and privacy

Archives are accessed on demand rather than copied wholesale into JavaScript memory. The current and neighbouring chapters are cached. Distant chapters have their image sources cleared and blob URLs revoked; scrolling back reloads them from the selected file. **Close book** releases the archive's image resources. Browser memory reclamation is controlled by the browser, so this is not a fixed total-RAM guarantee.

Reading positions and display preferences are stored locally in the browser. Clearing browser storage removes them; moving the HTML file or switching browsers may create a separate storage location. Reading positions do not contain comic images.

## Build

Requires Python 3.10 or newer. No Python packages or network access are needed.

```sh
python build.py --update
```

This rebuilds `cbf-reader.html` from `src/` and the vendored ZIP library. An existing output is backed up in `_download/`, which is ignored by Git. Use `--output PATH` to write elsewhere.

## Test

Requires Python 3.10 or newer, Node.js 22 or newer, and Chrome, Edge, or Chromium.

```sh
node --check src/reader.js
python tests/test_reader_browser.py
```

The tests use synthetic comics and an isolated browser profile. They cover empty startup, English labels, reading controls, bookmarks, local file selection, ZIP64, and image-resource cleanup. No private comic files are needed.

Set `BROWSER_PATH` if the browser is not installed in a standard location. Optionally test an existing local archive without adding it to the repository:

```sh
python tests/test_reader_browser.py --archive "path/to/comic.cbz"
```

To check whether a particular archive entry can be decoded by the browser, add `--image "chapter/page.png"`.

## Third-party software

The bundled **zip.js 2.24.0** library is distributed under the **BSD 3-Clause License**. Its license is retained in [`vendor/LICENSE`](vendor/LICENSE) and embedded in the generated HTML. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

No separate license has been selected for this project's original code. A public repository alone does not grant reuse rights. Comic content is not included and has its own copyright.
