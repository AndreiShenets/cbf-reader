"""Build a portable, offline CBZ reader; no book or image list is embedded."""

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="Replace the existing generated reader without creating backups")
    parser.add_argument("--output", type=Path, default=ROOT / "cbf-reader.html")
    args = parser.parse_args()
    template = (ROOT / "src" / "reader.template.html").read_text(encoding="utf-8")
    html = template
    vendor = ROOT / "vendor"
    html = html.replace("__ZIP_JS__", (vendor / "zip-native.min.js").read_text(encoding="utf-8"))
    html = html.replace("__READER_JS__", (ROOT / "src" / "reader.js").read_text(encoding="utf-8"))
    html = html.replace("__ZIP_LICENSE__", (vendor / "LICENSE").read_text(encoding="utf-8").replace("--", "—"))
    destination = args.output
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not args.update:
        raise FileExistsError(f"Will not overwrite existing reader without --update: {destination}")
    destination.write_text(html, encoding="utf-8", newline="\n")
    print(f"Created {destination}: standalone universal CBZ reader; no book loaded at startup.")


if __name__ == "__main__":
    main()
