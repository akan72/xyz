# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11"]
# ///
"""Generate candidate images for the remix styles on hayek's Qwen-Image endpoints.

Talks to the two deployed Modal endpoints (~/projects/hayek: qwen-image =
Qwen-Image-2512 text-to-image, qwen-image-edit = Qwen-Image-Edit-2511) over
HTTP with a Modal proxy-auth token. Nothing is deployed from here, so there
is nothing to tear down: both endpoints scale to zero on their own.

    uv run modal_assets/generate.py plan                  # jobs + cost estimate, no requests
    uv run modal_assets/generate.py run [--assets ...]    # generate what isn't cached yet
    uv run modal_assets/generate.py grid --asset ID       # numbered sheet of candidates for judging
    uv run modal_assets/generate.py keep --asset ID --picks 3 17 5 --notes "..."
    uv run modal_assets/generate.py contact               # HTML contact sheets of the kept picks
    uv run modal_assets/generate.py spend                 # running total from the ledger

Every result is written as soon as it arrives to
out/<asset>/<variant>-<prompt hash>/<mode>-s<seed>.png with a JSON sidecar,
and `run` skips files that exist, so an interrupted or preempted batch
resumes where it stopped and editing a prompt starts a fresh directory.

Credentials: MODAL_KEY / MODAL_SECRET from the environment or --env-file
(default ~/projects/hayek/v1-custom/.env, the file wargames uses). They are
only sent as request headers, never printed or written. --mock draws
placeholder images locally instead, to exercise the pipeline for free.
"""

import argparse
import base64
import hashlib
import html
import io
import json
import os
import random
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assets import ASSETS, Asset  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out"  # gitignored: candidates, ledger, grids, contact sheets
LEDGER = OUT / "ledger.jsonl"
MOCK_OUT = HERE / "out-mock"  # --mock results, kept apart so they never count as cached real ones

GENERATE_URL = os.environ.get("IMAGE_GENERATE_URL") or "https://akan72--qwen-image-qwenimage-api.modal.run/v1/images/generations"
EDIT_URL = os.environ.get("IMAGE_EDIT_URL") or "https://akan72--qwen-image-edit-qwenimageedit-api.modal.run/v1/images/edits"
DEFAULT_ENV_FILE = Path.home() / "projects/hayek/v1-custom/.env"

# Cost model. Both endpoints run one H100 per container, serve one request at
# a time, and keep a container warm for 5 minutes after its last request.
GPU_PER_HOUR = 3.95  # Modal's H100 rate
OVERHEAD = 1.15  # CPU and memory are billed alongside the GPU
PER_SECOND = GPU_PER_HOUR * OVERHEAD / 3600
SCALEDOWN_S = 300  # idle tail billed per container after each batch
GUESS_S = {"full": 45.0, "lightning": 8.0, "edit": 45.0}  # per image until the ledger has real timings
IN_FLIGHT = 4  # requests at once = at most this many H100s (the endpoints set no max_containers)
BUDGET = 50.0  # USD; raise with --budget (the plan allows up to $200)
TIMEOUT_S = 900  # a cold start plus a 50-step 1664x928 image stays well under this
RETRIES = 3  # preempted or restarting containers fail a request; try again


# --- Jobs ---------------------------------------------------------------------


def prompt_hash(asset: Asset, prompt: str) -> str:
    key = json.dumps([prompt, asset.negative, asset.size, asset.image, asset.steps, asset.cfg])
    return hashlib.sha256(key.encode()).hexdigest()[:6]


def jobs_for(asset: Asset, mode: str) -> list[dict]:
    jobs = []
    for variant, prompt in asset.variants.items():
        folder = OUT / asset.id / f"{variant}-{prompt_hash(asset, prompt)}"
        for seed in range(asset.seeds):
            m = "edit" if asset.kind == "edit" else mode
            jobs.append({"asset": asset.id, "variant": variant, "prompt": prompt, "seed": seed, "mode": m,
                         "path": folder / f"{m}-s{seed}.png"})
    return jobs


def select(names: list[str] | None) -> list[Asset]:
    if not names:
        return list(ASSETS.values())
    chosen = []
    for name in names:  # an asset id, or a style name for all of its assets
        matches = [a for a in ASSETS.values() if a.id == name or a.style == name]
        if not matches:
            sys.exit(f"error: no asset or style named {name!r} (see modal_assets/assets.py)")
        chosen += [a for a in matches if a not in chosen]
    return chosen


# --- Ledger and cost ----------------------------------------------------------


def ledger() -> list[dict]:
    if not LEDGER.exists():
        return []
    return [json.loads(line) for line in LEDGER.read_text().splitlines() if line.strip()]


def spent() -> float:
    return sum(e.get("usd", 0.0) for e in ledger() if e.get("type") == "batch")


def seconds_per_image(mode: str) -> float:
    timings = [e["seconds"] for e in ledger() if e.get("type") == "image" and e.get("mode") == mode and not e.get("mock")]
    return statistics.median(timings) if timings else GUESS_S[mode]


def endpoint(job: dict) -> str:
    return "edit" if job["mode"] == "edit" else "generate"


def estimate(jobs: list[dict], in_flight: int) -> float:
    """Busy seconds from past timings, plus each endpoint's idle tail after the batch."""
    busy = sum(seconds_per_image(j["mode"]) for j in jobs)
    return (busy + idle_tail(jobs, in_flight)) * PER_SECOND


def idle_tail(jobs: list[dict], in_flight: int) -> float:
    per_endpoint = {}
    for job in jobs:
        per_endpoint[endpoint(job)] = per_endpoint.get(endpoint(job), 0) + 1
    return sum(min(in_flight, n) for n in per_endpoint.values()) * SCALEDOWN_S


def record(entry: dict, lock=threading.Lock()):
    with lock:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER.open("a") as f:
            f.write(json.dumps(entry) + "\n")


# --- Requests -----------------------------------------------------------------


def credentials(env_file: Path | None) -> dict:
    found = {k: os.environ.get(k) for k in ("MODAL_KEY", "MODAL_SECRET")}
    path = env_file or (DEFAULT_ENV_FILE if DEFAULT_ENV_FILE.exists() else None)
    if path and not all(found.values()):
        for line in Path(path).expanduser().read_text().splitlines():
            key, sep, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            if sep and key in found and not found[key]:
                found[key] = value.strip().strip("'\"")
    if not all(found.values()):
        sys.exit("error: MODAL_KEY and MODAL_SECRET are required: export them, or pass --env-file "
                 f"(default {DEFAULT_ENV_FILE}, which doesn't exist on this machine)")
    return {"Modal-Key": found["MODAL_KEY"], "Modal-Secret": found["MODAL_SECRET"]}


def payload(asset: Asset, job: dict) -> tuple[str, dict]:
    body = {"prompt": job["prompt"], "negative_prompt": asset.negative, "seed": job["seed"], "n": 1}
    if asset.kind == "edit":
        body["image"] = base64.b64encode((REPO / asset.image).read_bytes()).decode()
        body["steps"] = asset.steps or 40
        body["true_cfg_scale"] = asset.cfg
        return EDIT_URL, body
    body.update(width=asset.size[0], height=asset.size[1], true_cfg_scale=asset.cfg)
    if job["mode"] == "lightning":
        body["lightning"] = True
    else:
        body["steps"] = asset.steps or 50
    return GENERATE_URL, body


def post(url: str, body: dict, headers: dict) -> bytes:
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **headers})
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as r:
                return base64.b64decode(json.load(r)["data"][0]["b64_json"])
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"error: {url.split('/')[2]} answered HTTP {e.code}: check MODAL_KEY / MODAL_SECRET")
            if e.code < 500 or attempt == RETRIES:
                raise RuntimeError(f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == RETRIES:
                raise RuntimeError(f"request failed after {RETRIES + 1} attempts: {e}")
        time.sleep(10 * (attempt + 1))
    raise AssertionError("unreachable")


def mock_png(asset: Asset, job: dict) -> bytes:
    from PIL import Image, ImageDraw

    size = asset.size if asset.kind == "generate" else (768, 960)
    rng = random.Random(f"{job['path']}")
    im = Image.new("RGB", size, tuple(rng.randrange(40, 220) for _ in range(3)))
    draw = ImageDraw.Draw(im)
    for _ in range(12):
        x, y = rng.randrange(size[0]), rng.randrange(size[1])
        draw.ellipse((x, y, x + rng.randrange(40, 300), y + rng.randrange(40, 300)),
                     fill=tuple(rng.randrange(256) for _ in range(3)))
    draw.text((20, 20), f"MOCK {job['asset']} {job['variant']} s{job['seed']}", fill="white")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def run_job(asset: Asset, job: dict, headers: dict | None) -> float:
    start = time.monotonic()
    if headers is None:
        png, host = mock_png(asset, job), "mock"
    else:
        url, body = payload(asset, job)
        png, host = post(url, body, headers), url.split("/")[2]
    seconds = time.monotonic() - start
    job["path"].parent.mkdir(parents=True, exist_ok=True)
    job["path"].write_bytes(png)
    sidecar = {k: v for k, v in job.items() if k != "path"}
    sidecar.update(negative=asset.negative, size=asset.size, image=asset.image, seconds=round(seconds, 1), endpoint=host)
    job["path"].with_suffix(".json").write_text(json.dumps(sidecar, indent=2) + "\n")
    record({"type": "image", "asset": job["asset"], "mode": job["mode"], "seconds": round(seconds, 1),
            "file": str(job["path"].relative_to(OUT)), "mock": headers is None})
    return seconds


# --- Commands -----------------------------------------------------------------


def pending(assets: list[Asset], mode: str) -> list[tuple[Asset, dict]]:
    return [(a, j) for a in assets for j in jobs_for(a, mode) if not j["path"].exists()]


def cmd_plan(args):
    assets = select(args.assets)
    for asset in assets:
        jobs = jobs_for(asset, args.mode)
        todo = [j for j in jobs if not j["path"].exists()]
        busy = sum(seconds_per_image(j["mode"]) for j in todo) * PER_SECOND
        print(f"{asset.id:22} {asset.kind:8} {len(asset.variants)} variant(s) x {asset.seeds} seeds = {len(jobs):3d}"
              f"  ({len(todo)} to generate, ~${busy:.2f} busy)")
    todo = [j for _, j in pending(assets, args.mode)]
    print(f"\n{len(todo)} images to generate in one batch: ~${estimate(todo, args.in_flight):.2f} incl. idle tails "
          f"({args.in_flight} in flight); spent so far ~${spent():.2f} of ${args.budget:.2f}")


def cmd_run(args):
    headers = None if args.mock else credentials(args.env_file)
    work = pending(select(args.assets), args.mode)
    if not work:
        print("everything selected is already generated")
        return
    jobs = [j for _, j in work]
    cost = 0.0 if args.mock else estimate(jobs, args.in_flight)
    if spent() + cost > args.budget:
        sys.exit(f"stop: this batch (~${cost:.2f}) would bring spend to ~${spent() + cost:.2f}, over the "
                 f"${args.budget:.2f} budget (raise --budget to continue)")
    print(f"generating {len(jobs)} images across {len({a.id for a, _ in work})} asset(s), "
          f"{args.in_flight} in flight ({'mock' if args.mock else f'estimate ~${cost:.2f}'})", flush=True)
    start, busy, done, failed = time.monotonic(), 0.0, [], []
    with ThreadPoolExecutor(max_workers=args.in_flight) as pool:
        futures = {pool.submit(run_job, asset, job, headers): job for asset, job in work}
        for i, future in enumerate(as_completed(futures), 1):
            job = futures[future]
            try:
                seconds = future.result()
                busy += seconds
                done.append(job)
                print(f"  [{i}/{len(jobs)}] {job['asset']} {job['variant']} s{job['seed']}  {seconds:5.1f}s", flush=True)
            except Exception as e:  # keep the rest of the batch going; a rerun retries it
                failed.append(job)
                print(f"  [{i}/{len(jobs)}] {job['asset']} {job['variant']} s{job['seed']}  FAILED: {e}", flush=True)
            if not args.mock and i % 10 == 0:
                print(f"  ... ~${spent() + busy * PER_SECOND:.2f} spent so far incl. this batch's busy time", flush=True)
    usd = 0.0 if args.mock else (busy + idle_tail(done or jobs, args.in_flight)) * PER_SECOND
    record({"type": "batch", "assets": sorted({j["asset"] for j in jobs}), "images": len(done), "failed": len(failed),
            "busy_s": round(busy, 1), "wall_s": round(time.monotonic() - start, 1), "usd": round(usd, 4), "mock": args.mock})
    print(f"batch ~${usd:.2f} ({busy:.0f}s busy + idle tails); running total ~${spent():.2f} of ${args.budget:.2f}"
          + (f"; {len(failed)} failed, rerun to retry them" if failed else ""), flush=True)


def candidates(asset_id: str) -> list[Path]:
    return sorted((OUT / asset_id).glob("*/*.png"))


def cmd_grid(args):
    from PIL import Image, ImageDraw, ImageFont

    files = candidates(args.asset)
    if not files:
        sys.exit(f"no candidates for {args.asset}")
    cell, cols = args.cell, args.cols
    font = ImageFont.load_default(size=max(14, cell // 12))
    rows = -(-len(files) // cols)
    sheet = Image.new("RGB", (cols * cell, rows * cell), "#777")
    index = {}
    for n, f in enumerate(files, 1):
        im = Image.open(f).convert("RGB")
        im.thumbnail((cell - 6, cell - 6))
        x, y = (n - 1) % cols * cell, (n - 1) // cols * cell
        sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        ImageDraw.Draw(sheet).text((x + 6, y + 4), str(n), fill="#ff2a6d", font=font, stroke_width=3, stroke_fill="white")
        index[n] = str(f.relative_to(OUT))
    path = OUT / args.asset / "grid.jpg"
    sheet.save(path, quality=88)
    (OUT / args.asset / "grid.json").write_text(json.dumps(index, indent=2) + "\n")
    print(path)


def cmd_keep(args):
    index = json.loads((OUT / args.asset / "grid.json").read_text())
    picks = [{"rank": r, "number": n, "file": index[str(n)]} for r, n in enumerate(args.picks, 1)]
    (OUT / args.asset / "top.json").write_text(json.dumps({"asset": args.asset, "notes": args.notes, "picks": picks}, indent=2) + "\n")
    print(f"kept {len(picks)} for {args.asset}")


def cmd_contact(args):
    sheets = OUT / "contact"
    sheets.mkdir(parents=True, exist_ok=True)
    links = []
    for asset in select(args.assets):
        top = OUT / asset.id / "top.json"
        if not top.exists():
            continue
        kept = json.loads(top.read_text())
        cards = []
        for letter, pick in zip("ABCDEFGHIJ", kept["picks"]):
            meta = json.loads((OUT / pick["file"]).with_suffix(".json").read_text())
            cards.append(f"""<figure><a href="../{html.escape(pick['file'])}"><img src="../{html.escape(pick['file'])}" loading="lazy"></a>
<figcaption><b>{letter}</b> · {html.escape(meta['variant'])} · seed {meta['seed']} · {meta['mode']}</figcaption></figure>""")
        prompts = "".join(f"<li><b>{html.escape(v)}</b>: {html.escape(p)}</li>" for v, p in asset.variants.items())
        page = f"""<!doctype html><meta charset="utf-8"><title>{asset.id} — pick a winner</title>
<style>body{{font:15px/1.5 system-ui;margin:24px;background:#f4f4f4;color:#111}}main{{max-width:1500px;margin:auto}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}}
figure{{margin:0;background:#fff;padding:8px;border-radius:6px}}img{{width:100%;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}}
figcaption{{font-size:13px;color:#444}}b{{color:#111}}.use{{background:#fff;padding:12px 16px;border-radius:6px}}</style>
<main><p><a href="index.html">all assets</a></p><h1>{asset.id}</h1><div class="use"><p><b>Use:</b> {html.escape(asset.use)}</p>
<p><b>Judge's notes:</b> {html.escape(kept.get('notes') or '')}</p><details><summary>Prompts</summary><ul>{prompts}</ul>
<p><b>Negative:</b> {html.escape(asset.negative)}</p></details></div>
<p>Ranked best first. Reply with the letter you want (or "none").</p><div class="grid">{''.join(cards)}</div></main>"""
        (sheets / f"{asset.id}.html").write_text(page)
        links.append(f'<li><a href="{asset.id}.html">{asset.id}</a> — {html.escape(asset.use)}</li>')
    (sheets / "index.html").write_text(f"""<!doctype html><meta charset="utf-8"><title>Remix asset contact sheets</title>
<style>body{{font:15px/1.6 system-ui;margin:24px;max-width:900px}}</style><h1>Remix asset contact sheets</h1><ul>{''.join(links)}</ul>""")
    print(sheets / "index.html")


def cmd_spend(args):
    batches = [e for e in ledger() if e.get("type") == "batch" and not e.get("mock")]
    for e in batches:
        print(f"{', '.join(e['assets'])[:60]:60} {e['images']:4d} images  {e['busy_s']:7.0f}s busy  ~${e['usd']:.2f}")
    print(f"total ~${spent():.2f} of ${args.budget:.2f}  (estimate: GPU ${GPU_PER_HOUR}/h x {OVERHEAD} overhead, "
          f"{SCALEDOWN_S}s idle tail per container per batch)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["plan", "run", "grid", "keep", "contact", "spend"])
    parser.add_argument("--assets", nargs="+", help="asset ids or style names (default: all)")
    parser.add_argument("--asset", help="grid/keep: one asset id")
    parser.add_argument("--mode", choices=["full", "lightning"], default="full",
                        help="full = 50 steps; lightning = the 4-step LoRA, for scouting prompts")
    parser.add_argument("--in-flight", type=int, default=IN_FLIGHT)
    parser.add_argument("--budget", type=float, default=BUDGET)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--mock", action="store_true", help="draw placeholders locally instead of calling the endpoints")
    parser.add_argument("--cell", type=int, default=256, help="grid: px per candidate")
    parser.add_argument("--cols", type=int, default=6)
    parser.add_argument("--picks", type=int, nargs="+", help="keep: grid numbers, best first")
    parser.add_argument("--notes", default="")
    args = parser.parse_args()
    if args.mock:
        global OUT, LEDGER
        OUT, LEDGER = MOCK_OUT, MOCK_OUT / "ledger.jsonl"
    if args.command in ("grid", "keep") and not args.asset:
        parser.error(f"{args.command} needs --asset")
    if args.command == "keep" and not args.picks:
        parser.error("keep needs --picks")
    {"plan": cmd_plan, "run": cmd_run, "grid": cmd_grid, "keep": cmd_keep, "contact": cmd_contact,
     "spend": cmd_spend}[args.command](args)


if __name__ == "__main__":
    main()
