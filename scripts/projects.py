"""The projects listed on /projects.

To add a project, add a Project to PROJECTS below. sitegen.py renders the list
into public/projects.html, where the page has <!-- sitegen:projects -->, so the
page's HTML never needs editing. Bad data fails before the site builds:

- `ty check` (CI and the pre-commit hook) rejects missing fields, wrong types
  and anything that isn't one of the three year shapes.
- Loading this module raises on impossible values, such as a range that ends
  before it starts.
"""

from __future__ import annotations

import html
import textwrap
from dataclasses import dataclass

FIRST_YEAR = 2000  # sanity bounds for any year below
LAST_YEAR = 2100


def _check_year(year: int) -> None:
    if not FIRST_YEAR <= year <= LAST_YEAR:
        raise ValueError(f"year {year} is outside {FIRST_YEAR}-{LAST_YEAR}")


@dataclass(frozen=True)
class Since:
    """Started in `start` and still being worked on: "(2020-Present)"."""

    start: int

    def __post_init__(self) -> None:
        _check_year(self.start)

    def label(self) -> str:
        return f"({self.start}-Present)"


@dataclass(frozen=True)
class Range:
    """Worked on from `start` until `end`: "(2020-2023)"."""

    start: int
    end: int

    def __post_init__(self) -> None:
        _check_year(self.start)
        _check_year(self.end)
        if self.start >= self.end:
            raise ValueError(f"Range({self.start}, {self.end}): the start year must come before the end year; use Single for one year")

    def label(self) -> str:
        return f"({self.start}-{self.end})"


@dataclass(frozen=True)
class Single:
    """Worked on within one year: "(2025)"."""

    year: int

    def __post_init__(self) -> None:
        _check_year(self.year)

    def label(self) -> str:
        return f"({self.year})"


Years = Since | Range | Single


@dataclass(frozen=True)
class Project:
    name: str
    url: str
    years: Years
    # One or two sentences. Trusted HTML: inline links are fine, and `&`, `<`
    # and `>` must be written as entities.
    about: str
    # Shown below the description, joined with " · ", e.g. ("Rust", "workers-rs").
    stack: tuple[str, ...]
    # Optional HTML shown between the link and the description (istheldown's
    # live figure). Trusted, like `about`.
    media: str = ""

    def __post_init__(self) -> None:
        if not self.name.strip() or not self.about.strip():
            raise ValueError(f"{self.name!r}: name and about can't be empty")
        if not self.url.startswith("https://"):
            raise ValueError(f"{self.name}: url must start with https://")
        if not self.stack or not all(s.strip() for s in self.stack):
            raise ValueError(f"{self.name}: list at least one stack entry, with no empty entries")


# The live figure for istheldown: filled in by public/assets/subway-vis.js, and
# hidden unless the istheldown feed answers.
SUBWAY_FIGURE = """\
<p hidden><small id="subway-vis-caption"></small></p>
<div class="figs" hidden>
    <div class="fig"><canvas id="subway-vis" aria-label="Generative figure driven by one subway line's live train positions"></canvas></div>
    <div class="fig map"><canvas id="subway-map" width="520" height="650" aria-label="Map of every subway train right now, with the chosen line highlighted"></canvas></div>
</div>"""

PROJECTS: tuple[Project, ...] = (
    Project(
        name="dotfiles",
        url="https://github.com/akan72/dotfiles",
        years=Since(2020),
        about="My dotfiles! Easily installable config for my dev setup.",
        stack=("Lua", "shell", "Neovim", "tmux", "Ghostty", "Coding Agent Configs"),
    ),
    Project(
        name="xyz",
        url="https://github.com/akan72/xyz",
        years=Since(2023),
        about="The code for this site. Mostly-static site written in Rust, compiled to WASM, and run on Cloudflare Workers, because why not?",
        stack=("Rust", "workers-rs", "Cloudflare Workers, R2"),
    ),
    Project(
        name="mingus",
        url="https://alexkan.xyz/mingus/",
        years=Single(2026),
        about="Interactive viz of my music taste over time since 2014. Ingests a Spotify streaming history export, and clusters artist by genre.",
        stack=("Python", "polars", "Modal", "WebGL"),
    ),
    Project(
        name="istheldown.com",
        url="https://istheldown.com",
        years=Single(2026),
        media=SUBWAY_FIGURE,
        about="A real-time map of transit across the NYC area. Includes live positions and alerts for the subway, buses, LIRR (and more!) from official sources. My attempt at vampire attacking isthelrunning.com.",
        stack=("Typescript", "Cloudflare Workers, Durable Objects, and R2", "MapLibre GL"),
    ),
    Project(
        name="cig_scraper",
        url="https://github.com/akan72/cig_scraper",
        years=Single(2025),
        about='Ingests all <a href="https://opensea.io/collection/cigawrettepacks" target="_blank">Cigawrette Packs</a> NFT images from IPFS and writes to an R2 bucket. Scale horizontally with Modal to ingest them more quickly. This is what powers the random-cig button on the homepage.',
        stack=("Python", "Modal", "Cloudflare R2"),
    ),
)


def render_project(project: Project, indent: str = " " * 12) -> str:
    """One project as a list item, indented to sit inside the page's <ul>."""
    inner = indent + " " * 4
    lines = [
        f'{indent}<li> <a href="{html.escape(project.url)}" target="_blank">{html.escape(project.name)}</a>'
        f' <span class="years">{project.years.label()}</span>'
    ]
    if project.media:
        lines.append(textwrap.indent(project.media, inner))
    lines.append(f"{inner}<p>{project.about}</p>")
    stack = " &middot; ".join(html.escape(s) for s in project.stack)
    lines.append(f'{inner}<p class="meta">{stack}</p>')
    lines.append(f"{indent}</li>")
    return "\n".join(lines)


def render(projects: tuple[Project, ...] = PROJECTS) -> str:
    return "\n".join(render_project(p) for p in projects)
