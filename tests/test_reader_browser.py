"""Test the universal file:// reader in Edge, including the real multi-GB CBZ."""

import base64
import argparse
import io
import json
import re
import struct
import subprocess
import tempfile
import zipfile
import zlib
from html import unescape
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


def render(url, profile, archive=None, image=None):
    command = ["node", str(Path(__file__).with_name("render_reader.mjs")), url, str(profile)]
    if archive:
        command.append(str(archive))
        if image:
            command.append(image)
    result = subprocess.run(command, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    return result.stdout.decode("utf-8")


def fixture_zip(names, force_zip64=False):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", 100, 180, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress((b"\0" + b"\x64\x78\xc8" * 100) * 180))
    png += chunk(b"IEND", b"")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            if force_zip64:
                with archive.open(name, "w", force_zip64=True) as entry:
                    entry.write(png)
            else:
                archive.writestr(name, png)
        archive.writestr("ComicInfo.xml", "<ComicInfo />")
        archive.writestr("__MACOSX/._cover.png", b"not an image")
    return base64.b64encode(output.getvalue()).decode("ascii")


def run_tests(folder, archive=None, image=None):
    profile = folder / "browser-profile"
    reader_file = folder / "cbf-reader.html"
    source = (PROJECT / "cbf-reader.html").read_text(encoding="utf-8")
    reader_file.write_text(source, encoding="utf-8")
    test_file = folder / "_reader-smoke-test.html"
    if test_file.exists():
        raise FileExistsError(test_file)
    try:
        smoke = Path(__file__).with_name("reader-tests.js").read_text(encoding="utf-8")
        smoke = smoke.replace("__CBZ_FIXTURE__", fixture_zip(["10/1.png", "2/10.png", "2/2.png", "2/1.png"]))
        smoke = smoke.replace("__FLAT_FIXTURE__", fixture_zip([f"{number}.png" for number in range(95, 0, -1)]))
        smoke = smoke.replace("__ZIP64_FIXTURE__", fixture_zip(["1.png"], force_zip64=True))
        test_file.write_text(source.replace("</body>", "<script>" + smoke + "</script></body>"), encoding="utf-8")
        dom = render(test_file.as_uri(), profile)
        match = re.search(r'data-smoke="([^"]+)"', dom)
        if not match:
            raise AssertionError("Browser smoke test did not finish.")
        report = json.loads(unescape(match.group(1)))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        assert report["ok"], report
    finally:
        test_file.unlink(missing_ok=True)

    url = reader_file.as_uri()
    for location in [url + "#chapter=202&page=3&offset=0.4", url]:
        dom = render(location, profile)
        assert '<title>Comic Reader</title>' in dom and '<img ' not in dom
        assert 'data-chapter="202"' not in dom
    print("PASS: reload stays empty, including stale links and saved reading positions.")
    if archive is None:
        archive = folder / "file-picker-test.cbz"
        archive.write_bytes(base64.b64decode(fixture_zip(["10/1.png", "2/10.png", "2/2.png", "2/1.png"])))
    report = json.loads(render(url, profile, archive, image))
    assert report["ok"], report
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Optionally test the real file picker with a private CBZ")
    parser.add_argument("--image", help="Also decode this exact archive entry, for example chapter/page.png")
    args = parser.parse_args()
    if args.image and not args.archive:
        parser.error("--image requires --archive")
    approved_temp = Path(r"C:\Temp\opencode")
    with tempfile.TemporaryDirectory(
        prefix="cbf-reader-tests-",
        dir=approved_temp if approved_temp.exists() else None,
        ignore_cleanup_errors=True,
    ) as folder:
        run_tests(Path(folder), args.archive.resolve() if args.archive else None, args.image)


if __name__ == "__main__":
    main()
