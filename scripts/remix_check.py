# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.49", "pillow>=11"]
# ///
"""Screenshots and browser checks for the remix styles (public/assets/remix/).

Serves public/ locally the way Workers Static Assets does (extensionless
paths, 404.html for misses, and a stub /image that always returns the
default cig), then drives Chromium with Playwright:

    uv run scripts/remix_check.py serve                 # http://localhost:8790
    uv run scripts/remix_check.py shots --out DIR       # every page x style x size at 2x, plus bytes.json
    uv run scripts/remix_check.py sheet --out DIR       # one contact sheet PNG from DIR's shots
    uv run scripts/remix_check.py test                  # switching, persistence, shuffle, console

Uses Playwright's Chromium (`uv run --with playwright playwright install
chromium`), or a headless shell already in the Playwright cache.
"""

import argparse
import glob
import json
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
STYLES = ["gm", "kvlt", "takeout", "tvdinner"]
PAGES = {"home": "/", "ideology": "/ideology", "projects": "/projects", "contact": "/contact", "404": "/no-such-page"}
SIZES = {"desktop": (1280, 900), "mobile": (390, 844)}


# --- Local server -------------------------------------------------------------


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/image":  # the Worker answers with a random cig's URL
            body = b"/assets/cig.jpg"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        target = PUBLIC / path.lstrip("/")
        if path != "/" and not target.exists() and (PUBLIC / f"{path.lstrip('/')}.html").exists():
            self.path = f"{path}.html"
        elif path != "/" and not target.exists():
            body = (PUBLIC / "404.html").read_bytes()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def start_server(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --- Browser ------------------------------------------------------------------


def launch(playwright):
    try:
        return playwright.chromium.launch()
    except Exception:
        cached = sorted(glob.glob(os.path.expanduser(
            "~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell")))
        if not cached:
            raise
        return playwright.chromium.launch(executable_path=cached[-1])


def new_page(browser, size: str, style: str, errors: list):
    width, height = SIZES[size]
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    if style != "gm":
        context.add_init_script(f"localStorage.setItem('remix', {json.dumps(style)})")
    page = context.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    return context, page


def settle(page):
    """Waits for the style's CSS, fonts and images, and keeps the idle screensaver away."""
    page.wait_for_function("getComputedStyle(document.body).visibility === 'visible'")
    page.evaluate("document.fonts.ready")
    page.wait_for_function("[...document.images].every(i => i.complete)")
    page.mouse.move(5, 5)
    page.wait_for_timeout(250)


def asset_bytes(urls) -> dict:
    """Size on disk of each remix asset the browser requested."""
    paths = {u.split("/assets/remix/", 1)[1].split("?", 1)[0] for u in urls}
    return {p: (PUBLIC / "assets/remix" / p).stat().st_size for p in sorted(paths) if (PUBLIC / "assets/remix" / p).is_file()}


# --- Commands -----------------------------------------------------------------


def cmd_serve(args):
    start_server(args.port)
    print(f"serving {PUBLIC} at http://localhost:{args.port}  (ctrl-c to stop)")
    threading.Event().wait()


def cmd_shots(args):
    from playwright.sync_api import sync_playwright

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    server = start_server(args.port)
    base = f"http://localhost:{args.port}"
    report = {}
    with sync_playwright() as p:
        browser = launch(p)
        for style in args.styles:
            requested = []  # remix asset URLs, across every page and size
            for size in args.sizes:
                for name in args.pages:
                    context, page = new_page(browser, size, style, [])  # `test` covers console errors
                    page.on("request", lambda r: "/assets/remix/" in r.url and requested.append(r.url))
                    page.goto(base + PAGES[name], wait_until="load")
                    settle(page)
                    page.screenshot(path=out / f"{name}-{style}-{size}.png", full_page=True)
                    context.close()
            files = asset_bytes(requested)
            report[style] = {"files": files, "bytes": sum(files.values())}
            print(f"{style:9} {report[style]['bytes']:8,d} B of remix assets  ({len(files)} files)")
        browser.close()
    server.shutdown()
    (out / "bytes.json").write_text(json.dumps(report, indent=2) + "\n")


def cmd_sheet(args):
    from PIL import Image, ImageDraw, ImageFont

    shots = Path(args.out)
    width = 360  # per cell
    font = ImageFont.load_default(size=22)
    rows = []
    for size in args.sizes:
        for name in args.pages:
            cells = []
            for style in args.styles:
                f = shots / f"{name}-{style}-{size}.png"
                if f.exists():
                    im = Image.open(f).convert("RGB")
                    im = im.resize((width, round(im.height * width / im.width)))
                    cells.append(im.crop((0, 0, width, min(im.height, args.max_height))))
                else:
                    cells.append(Image.new("RGB", (width, 60), "#333"))
            rows.append((f"{name} / {size}", cells))
    pad, label_h = 16, 34
    sheet_w = pad + len(args.styles) * (width + pad)
    sheet_h = label_h + sum(label_h + max(c.height for c in cells) + pad for _, cells in rows)
    sheet = Image.new("RGB", (sheet_w, sheet_h), "#1b1b1d")
    draw = ImageDraw.Draw(sheet)
    for i, style in enumerate(args.styles):
        draw.text((pad + i * (width + pad), 6), style, fill="#eee", font=font)
    y = label_h
    for label, cells in rows:
        draw.text((pad, y + 4), label, fill="#999", font=font)
        y += label_h
        for i, im in enumerate(cells):
            sheet.paste(im, (pad + i * (width + pad), y))
        y += max(c.height for c in cells) + pad
    path = shots / ("sheet.png" if len(args.sizes) == len(SIZES) else f"sheet-{'-'.join(args.sizes)}.png")
    sheet.save(path, optimize=True)
    print(path)


def cmd_test(args):
    from playwright.sync_api import sync_playwright

    server = start_server(args.port)
    base = f"http://localhost:{args.port}"
    failures = []

    def check(ok, what):
        print(("  ok   " if ok else "  FAIL ") + what)
        if not ok:
            failures.append(what)

    with sync_playwright() as p:
        browser = launch(p)
        errors = []
        context, page = new_page(browser, "desktop", "gm", errors)
        remix_requests = []
        page.on("request", lambda r: "/assets/remix/" in r.url and remix_requests.append(r.url))

        page.goto(base + "/")
        settle(page)
        check(page.evaluate("document.documentElement.dataset.remix") is None, "gm is the default and sets no data-remix")
        check(not remix_requests, "gm loads no remix CSS, fonts or images")
        check(page.is_visible("[data-remix-picker]"), "the homepage shows the style picker")

        for style in STYLES[1:]:
            remix_requests.clear()
            page.select_option("[data-remix-select]", style)
            page.wait_for_function(f"document.documentElement.dataset.remix === {json.dumps(style)}")
            settle(page)
            others = [s for s in STYLES[1:] if s != style]
            check(any(f"/assets/remix/{style}.css" in u for u in remix_requests), f"picking {style} loads {style}.css")
            check(not any(f"/assets/remix/{o}" in u for u in remix_requests for o in others),
                  f"picking {style} loads no other style's assets")
            check(page.evaluate("localStorage.getItem('remix')") == style, f"{style} is saved")

        page.goto(base + "/ideology")
        settle(page)
        check(page.evaluate("document.documentElement.dataset.remix") == "tvdinner", "the style follows to a subpage")
        check(not page.is_visible("[data-remix-picker]"), "subpages have no picker")
        page.reload()
        settle(page)
        check(page.evaluate("document.documentElement.dataset.remix") == "tvdinner", "the style survives a reload")
        check(page.evaluate("document.documentElement.dataset.theme") == "light", "tvdinner sets the light scheme")

        page.goto(base + "/")
        settle(page)
        seen = set()
        for _ in range(8):
            before = page.evaluate("localStorage.getItem('remix') ?? 'gm'")
            page.click("[data-remix-shuffle]")
            page.wait_for_function(f"(localStorage.getItem('remix') ?? 'gm') !== {json.dumps(before)}")
            page.wait_for_function("(document.documentElement.dataset.remix ?? 'gm') === (localStorage.getItem('remix') ?? 'gm')")
            seen.add(page.evaluate("localStorage.getItem('remix') ?? 'gm'"))
        check(len(seen) >= 2, f"remix shuffles to a different style each time (saw {sorted(seen)})")

        page.select_option("[data-remix-select]", "kvlt")
        page.wait_for_function("document.documentElement.dataset.remix === 'kvlt'")
        check(page.evaluate("document.documentElement.dataset.theme") == "dark", "kvlt sets the dark scheme for the screensaver")
        page.select_option("[data-remix-select]", "gm")
        page.wait_for_function("document.documentElement.dataset.remix === undefined")
        check(page.evaluate("localStorage.getItem('remix')") is None, "picking gm clears the saved style")
        check(page.is_visible("[data-theme-toggle]"), "gm keeps the light/dark toggle")

        page.click("#cig-button")
        page.wait_for_function("document.getElementById('cig-button').disabled === false")
        check(True, "random cig still works")

        context.close()

        # Errors a page also logs in gm (third-party scripts, the 404 status) aren't the styles'
        new_errors = []
        for name, path in PAGES.items():
            seen_in_gm = set()
            for style in STYLES:
                errors = []
                context, page = new_page(browser, "mobile", style, errors)
                page.goto(base + path)
                settle(page)
                context.close()
                if style == "gm":
                    seen_in_gm = set(errors)
                new_errors += [f"{name} {style}: {e}" for e in errors if e not in seen_in_gm]
        check(not new_errors, "no console errors from any style on any page" + (f": {new_errors}" if new_errors else ""))
        browser.close()
    server.shutdown()
    print(f"{len(failures)} failure(s)" if failures else "all checks passed")
    sys.exit(1 if failures else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["serve", "shots", "sheet", "test"])
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--out", default="remix-shots")
    parser.add_argument("--styles", nargs="+", default=STYLES, choices=STYLES)
    parser.add_argument("--pages", nargs="+", default=list(PAGES), choices=list(PAGES))
    parser.add_argument("--sizes", nargs="+", default=list(SIZES), choices=list(SIZES))
    parser.add_argument("--max-height", type=int, default=1400, help="sheet: crop each shot to this many px")
    args = parser.parse_args()
    {"serve": cmd_serve, "shots": cmd_shots, "sheet": cmd_sheet, "test": cmd_test}[args.command](args)


if __name__ == "__main__":
    main()
