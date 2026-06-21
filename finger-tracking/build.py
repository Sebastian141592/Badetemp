#!/usr/bin/env python3
"""
Build the self-contained finger-tracking/index.html from the modular source.

It reads index.template.html and inlines css/style.css and the js/ modules,
embedding the icons + web manifest as data URIs, producing a single portable
index.html that works on its own. Edit the sources (index.template.html, css/,
js/), then run:

    python3 build.py
"""
import re, base64, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent

MP_IMPORT = (
    'import { HandLandmarker, FilesetResolver } from '
    '"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";'
)

# Inlining order matters: dependencies before dependents.
JS_MODULES = ["euro.js", "gestures.js", "bridge.js", "game.js", "app.js"]


def strip_module(src: str) -> str:
    src = re.sub(r'(?m)^\s*import\s+.*from\s+["\']\./.*\n', "", src)        # local imports
    src = re.sub(r'(?m)^\s*import\s+.*from\s+["\']https://.*\n', "", src)   # cdn import (re-added once)
    src = re.sub(r"(?m)^export\s+", "", src)                                # export keyword
    return src.strip()


def data_uri_png(path: pathlib.Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def main() -> None:
    html = (ROOT / "index.template.html").read_text()
    css = (ROOT / "css" / "style.css").read_text()

    combined = "\n\n".join(
        [MP_IMPORT] + [strip_module((ROOT / "js" / m).read_text()) for m in JS_MODULES]
    )

    icon192 = data_uri_png(ROOT / "icons" / "icon-192.png")
    icon512 = data_uri_png(ROOT / "icons" / "icon-512.png")
    manifest = {
        "name": "Finger-Tracking", "short_name": "Finger",
        "description": "Presis fingersporing via kameraet for å styre med gester.",
        "start_url": "index.html", "scope": "./", "display": "standalone",
        "orientation": "any", "background_color": "#0b1020", "theme_color": "#0b1020",
        "icons": [
            {"src": icon192, "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": icon512, "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }
    manifest_uri = "data:application/manifest+json;base64," + \
        base64.b64encode(json.dumps(manifest).encode()).decode()

    replacements = {
        '<link rel="manifest" href="manifest.webmanifest" />':
            f'<link rel="manifest" href="{manifest_uri}" />',
        '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />':
            f'<link rel="apple-touch-icon" href="{icon192}" />',
        '<link rel="stylesheet" href="css/style.css" />':
            f"<style>\n{css}\n  </style>",
        '<script type="module" src="js/app.js"></script>':
            f'<script type="module">\n{combined}\n  </script>',
    }

    for needle, value in replacements.items():
        assert needle in html, f"template is missing expected tag: {needle}"
        html = html.replace(needle, value)

    (ROOT / "index.html").write_text(html)
    print(f"Built index.html ({len(html)} bytes)")


if __name__ == "__main__":
    main()
