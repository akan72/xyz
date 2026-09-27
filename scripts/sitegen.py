#!/usr/bin/env python3
"""Build dist/ from public/ and generate the site's machine-readable files.

Runs as part of the wrangler build (see wrangler.toml). Copies public/ to
dist/, then adds files derived from the HTML pages:

    sitemap.xml    every page with the date of its last git commit
    sitemap.html   the same list for humans, served at /sitemap
    llms.txt       an index of the site for LLMs (https://llmstxt.org)
    llms-full.txt  the Markdown of every page in one file
    <page>.md      a Markdown copy of each page: /ideology -> /ideology.md,
                   / -> /index.md. The Worker also serves these to requests
                   sent with `Accept: text/markdown`.
    _headers       points each Markdown copy's canonical URL at its page

Each page in dist/ also gets <link rel="canonical">, <link rel="alternate"
type="text/markdown"> (its Markdown copy) and <link rel="describedby">
(llms.txt, per llms.txt v2) unless it already has them.

Every page needs a <title> and a <meta name="description">; the build fails
without them. Pages marked <meta name="robots" content="noindex"> are left
out. Output depends only on public/ and git history, so the same commit
always builds the same files.

Usage: python3 scripts/sitegen.py
"""

from __future__ import annotations

import html
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urljoin, urlsplit
from xml.sax.saxutils import escape as xml_escape

SITE_URL = "https://alexkan.xyz"
SITE_NAME = "alexkan.xyz"

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
DIST = ROOT / "dist"

# Written to the root of dist/; public/ must not contain files with these names
GENERATED = ("llms.txt", "llms-full.txt", "sitemap.xml", "sitemap.html")


class SiteError(Exception):
    def __init__(self, problems):
        super().__init__("\n".join(problems))
        self.problems = list(problems)


# --- URLs -------------------------------------------------------------------


def page_path(source: PurePosixPath) -> str:
    """URL path Workers Static Assets serves an HTML file at.

    Matches the default html_handling ("auto-trailing-slash"), which
    redirects /about.html to /about and /notes/index.html to /notes/.
    """
    if source.name == "index.html":
        parent = source.parent.as_posix()
        return "/" if parent == "." else f"/{parent}/"
    return "/" + source.with_suffix("").as_posix()


def markdown_path(path: str) -> str:
    """Path of a page's Markdown copy. Keep in sync with markdown_path in src/lib.rs."""
    return f"{path}index.md" if path.endswith("/") else f"{path}.md"


# --- HTML parsing -----------------------------------------------------------

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

# Opening one of these closes an unclosed sibling (hand-written HTML often skips </li> and </p>)
IMPLIED_END = {
    "li": {"li"},
    "p": {"p"},
    "dt": {"dt", "dd"},
    "dd": {"dt", "dd"},
    "tr": {"tr"},
    "td": {"td", "th"},
    "th": {"td", "th"},
}
# ...searching up to the enclosing list or table (a <p> only closes a <p> directly above it)
IMPLIED_SCOPE = {
    "li": {"ul", "ol"},
    "dt": {"dl"},
    "dd": {"dl"},
    "tr": {"table", "thead", "tbody", "tfoot"},
    "td": {"tr", "table"},
    "th": {"tr", "table"},
}


class Element:
    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = {name: value or "" for name, value in attrs}
        self.children = []

    def iter(self):
        for child in self.children:
            if isinstance(child, Element):
                yield child
                yield from child.iter()

    def find(self, tag):
        return next((el for el in self.iter() if el.tag == tag), None)

    def text(self):
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("#document", [])
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        closes, scope = IMPLIED_END.get(tag, ()), IMPLIED_SCOPE.get(tag)
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag in closes:
                del self.stack[i:]
                break
            if scope is None or self.stack[i].tag in scope:
                break
        el = Element(tag, attrs)
        self.stack[-1].children.append(el)
        if tag not in VOID_TAGS:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Element(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_html(text: str) -> Element:
    builder = TreeBuilder()
    builder.feed(text)
    builder.close()
    return builder.root


def meta_content(doc: Element, name: str) -> str:
    for el in doc.iter():
        if el.tag == "meta" and el.attrs.get("name", "").lower() == name:
            return " ".join(el.attrs.get("content", "").split())
    return ""


def link_href(doc: Element, rel: str, type_: str | None = None) -> str | None:
    for el in doc.iter():
        if el.tag != "link" or rel not in el.attrs.get("rel", "").lower().split():
            continue
        if type_ is None or el.attrs.get("type", "").lower() == type_:
            return el.attrs.get("href", "")
    return None


# --- HTML to Markdown -------------------------------------------------------

# Navigation, controls and non-content elements that don't belong in the Markdown
SKIP_TAGS = {
    "button", "canvas", "dialog", "form", "head", "iframe", "input", "nav",
    "noscript", "script", "select", "style", "svg", "template", "textarea",
    "title",
}
BLOCK_TAGS = {
    "#document", "address", "article", "aside", "blockquote", "body", "dd",
    "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main",
    "ol", "p", "pre", "section", "summary", "table", "ul",
}
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

LINE_BREAK = "\x00"  # marks <br> until whitespace is collapsed


def clean_inline(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    return re.sub(f" ?{LINE_BREAK} ?", "\n", text).strip()


def wrap(text: str, marker: str) -> str:
    """Surround text with an inline marker, keeping edge whitespace outside it."""
    core = text.strip()
    if not core:
        return text
    start = text.index(core[0])
    return f"{text[:start]}{marker}{core}{marker}{text[start + len(core):]}"


def normalize(text: str) -> str:
    return " ".join(text.split()).casefold()


class MarkdownRenderer:
    def __init__(self, base_url, page_urls, drop=None, heading_shift=0):
        self.base_url = base_url
        self.page_urls = page_urls  # public/ file path -> canonical page URL
        self.drop = drop  # heading element that repeats the page title
        self.heading_shift = heading_shift

    def skipped(self, el: Element) -> bool:
        return (
            el is self.drop
            or el.tag in SKIP_TAGS
            or "hidden" in el.attrs
            or el.attrs.get("aria-hidden") == "true"
        )

    def url(self, href: str) -> str:
        """Absolute URL for href, with links to .html files rewritten to their page URL."""
        parts = urlsplit(urljoin(self.base_url, href.strip()))
        url = parts.geturl()
        if f"{parts.scheme}://{parts.netloc}" == SITE_URL and parts.path in self.page_urls:
            url = parts._replace(scheme="", netloc="", path="").geturl()
            url = self.page_urls[parts.path] + url
        return quote(url, safe=":/?#[]@!$&'*+,;=%~")

    def blocks(self, nodes) -> list:
        out, inline = [], []

        def flush():
            text = clean_inline("".join(inline))
            inline.clear()
            if text:
                out.append(text)

        for node in nodes:
            if isinstance(node, str):
                inline.append(node)
            elif self.skipped(node):
                continue
            elif node.tag in BLOCK_TAGS:
                flush()
                out.extend(self.block(node))
            else:
                inline.append(self.inline(node))
        flush()
        return out

    def block(self, el: Element) -> list:
        if el.tag in HEADINGS:
            text = clean_inline(self.inline_children(el)).replace("\n", " ")
            level = min(6, HEADINGS[el.tag] + self.heading_shift)
            return [f"{'#' * level} {text}"] if text else []
        if el.tag in ("ul", "ol"):
            return [md] if (md := self.list(el)) else []
        if el.tag == "blockquote":
            inner = "\n\n".join(self.blocks(el.children))
            return ["\n".join(f"> {line}".rstrip() for line in inner.split("\n"))] if inner else []
        if el.tag == "pre":
            code = el.text().strip("\n")
            fence = "```"
            while fence in code:
                fence += "`"
            return [f"{fence}\n{code}\n{fence}"] if code.strip() else []
        if el.tag == "hr":
            return ["---"]
        if el.tag == "table":
            return [md] if (md := self.table(el)) else []
        return self.blocks(el.children)

    def list(self, el: Element) -> str:
        ordered = el.tag == "ol"
        number = int(el.attrs["start"]) if ordered and el.attrs.get("start", "").isdigit() else 1
        items = []
        for li in el.children:
            if not isinstance(li, Element) or li.tag != "li" or self.skipped(li):
                continue
            marker = f"{number}." if ordered else "-"
            number += 1
            body = "\n".join(self.blocks(li.children))
            if body:
                items.append(f"{marker} " + body.replace("\n", "\n" + " " * (len(marker) + 1)))
        return "\n".join(items)

    def table(self, el: Element) -> str:
        rows = []
        for tr in (e for e in el.iter() if e.tag == "tr"):
            cells = [
                clean_inline(self.inline_children(c)).replace("\n", " ").replace("|", "\\|")
                for c in tr.children
                if isinstance(c, Element) and c.tag in ("td", "th")
            ]
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
        return "\n".join(lines + ["| " + " | ".join(r) + " |" for r in rows[1:]])

    def inline(self, el: Element) -> str:
        if self.skipped(el):
            return ""
        if el.tag == "br":
            return LINE_BREAK
        if el.tag == "img":
            alt, src = clean_inline(el.attrs.get("alt", "")), el.attrs.get("src", "")
            # Images without alt text are decorative
            return f"![{alt}]({self.url(src)})" if alt and src else ""
        inner = self.inline_children(el)
        if el.tag == "a":
            href, text = el.attrs.get("href", ""), clean_inline(inner)
            return f"[{text}]({self.url(href)})" if href and text else inner
        if el.tag in ("strong", "b"):
            return wrap(inner, "**")
        if el.tag in ("em", "i"):
            return wrap(inner, "*")
        if el.tag == "code":
            return wrap(inner, "`")
        if el.tag in BLOCK_TAGS:
            return f" {inner} "
        return inner

    def inline_children(self, el: Element) -> str:
        return "".join(c if isinstance(c, str) else self.inline(c) for c in el.children)


def to_markdown(doc: Element, title: str, base_url: str, page_urls: dict) -> str:
    """Markdown for a page's content: its <main>, or <body> if it has none.

    Drops a leading heading that repeats the title (the title is rendered
    separately as the H1) and shifts headings so the top level is H2.
    """
    content = doc.find("main") or doc.find("body") or doc
    probe = MarkdownRenderer(base_url, page_urls)
    headings = [el for el in visible(content, probe) if el.tag in HEADINGS]
    drop = headings[0] if headings and normalize(headings[0].text()) == normalize(title) else None
    levels = [HEADINGS[h.tag] for h in headings if h is not drop]
    shift = 2 - min(levels) if levels else 0
    renderer = MarkdownRenderer(base_url, page_urls, drop, shift)
    return "\n\n".join(renderer.blocks(content.children))


def visible(el: Element, renderer: MarkdownRenderer):
    for child in el.children:
        if isinstance(child, Element) and not renderer.skipped(child):
            yield child
            yield from visible(child, renderer)


# --- Pages ------------------------------------------------------------------


@dataclass(frozen=True)
class Page:
    source: PurePosixPath  # relative to public/
    path: str
    title: str
    description: str
    body: str  # Markdown of the page content, without the title
    lastmod: datetime | None

    @property
    def url(self) -> str:
        return SITE_URL + self.path

    @property
    def markdown_path(self) -> str:
        return markdown_path(self.path)

    @property
    def section(self) -> str:
        return self.source.parts[0] if len(self.source.parts) > 1 else ""

    def markdown(self, index_link: bool = True) -> str:
        """The page as Markdown. index_link points readers of a lone copy at llms.txt."""
        updated = f" (last updated {self.lastmod.date().isoformat()})" if self.lastmod else ""
        head = f"# {self.title}\n\n> {self.description}\n\nSource: {self.url}{updated}"
        if index_link:
            head += f"\nAll pages: {SITE_URL}/llms.txt"
        return f"{head}\n\n{self.body}" if self.body else head


def page_title(raw: str) -> str:
    title = " ".join(raw.split())
    for sep in (" | ", " - ", " – ", " — ", " · "):
        if title.endswith(sep + SITE_NAME):
            return title[: -len(sep + SITE_NAME)].strip()
    return title


def html_sources(public: Path) -> list:
    return sorted(PurePosixPath(p.relative_to(public).as_posix()) for p in public.rglob("*.html"))


def load_pages(public: Path, lastmods: dict) -> list:
    """Parse every indexable page in public/, homepage first.

    lastmods maps a page's path relative to public/ (as a string) to its
    last-modified time.
    """
    docs = {}
    for source in html_sources(public):
        doc = parse_html((public / source).read_text(encoding="utf-8"))
        if "noindex" not in meta_content(doc, "robots").lower().replace(",", " ").split():
            docs[source] = doc

    page_urls = {"/" + source.as_posix(): SITE_URL + page_path(source) for source in docs}
    pages, problems = [], []
    for source, doc in docs.items():
        path = page_path(source)
        title_el = doc.find("title")
        title = page_title(title_el.text()) if title_el else ""
        description = meta_content(doc, "description")
        canonical = link_href(doc, "canonical")
        if not title:
            problems.append(f"public/{source}: add a <title>")
        if not description:
            problems.append(f'public/{source}: add <meta name="description" content="..."> (used in llms.txt)')
        if "." in path:
            problems.append(f"public/{source}: rename it; page URLs can't contain '.' (the Worker treats those as files)")
        if canonical is not None and canonical != SITE_URL + path:
            problems.append(f"public/{source}: canonical URL {canonical!r} should be {SITE_URL + path!r}")
        if (public / markdown_path(path).lstrip("/")).exists():
            problems.append(f"public{markdown_path(path)}: conflicts with the generated Markdown copy of public/{source}")
        body = to_markdown(doc, title, SITE_URL + path, page_urls)
        pages.append(Page(source, path, title, description, body, lastmods.get(source.as_posix())))

    for name in GENERATED:
        if (public / name).exists():
            problems.append(f"public/{name}: remove it; scripts/sitegen.py generates this file")
    if not any(p.path == "/" for p in pages):
        problems.append("public/index.html: missing (the homepage describes the site in llms.txt)")
    if problems:
        raise SiteError(problems)
    return sorted(pages, key=lambda p: (p.path != "/", p.section, p.path))


# --- Generated files --------------------------------------------------------


def sections(pages):
    """Pages grouped by top-level directory; pages at the root come first."""
    groups = {}
    for page in pages:
        groups.setdefault(page.section, []).append(page)
    return sorted(groups.items(), key=lambda item: (item[0] != "", item[0]))


def escape_brackets(text: str) -> str:
    return re.sub(r"([\[\]])", r"\\\1", text)


def section_title(section: str, default: str) -> str:
    return section.replace("-", " ").replace("_", " ").title() if section else default


def render_llms_txt(pages) -> str:
    home = pages[0]
    lines = [
        f"# {SITE_NAME}",
        "",
        f"> {home.description}",
        "",
        "Each link below is a Markdown copy of a page. Any page is also available as Markdown"
        " by adding `.md` to its path (`/index.md` for the homepage) or by requesting it with"
        " an `Accept: text/markdown` header.",
    ]
    for section, section_pages in sections(pages):
        lines += ["", f"## {section_title(section, 'Pages')}", ""]
        lines += [
            f"- [{escape_brackets(p.title)}]({SITE_URL}{p.markdown_path}): {p.description}"
            for p in section_pages
        ]
    lines += [
        "",
        "## Optional",
        "",
        f"- [Full text]({SITE_URL}/llms-full.txt): every page above in one Markdown file",
        f"- [Sitemap]({SITE_URL}/sitemap.xml): every page with its last-modified date",
    ]
    return "\n".join(lines) + "\n"


def render_llms_full_txt(pages) -> str:
    intro = (
        f"# {SITE_NAME}\n\n> {pages[0].description}\n\n"
        f"The full text of every page on {SITE_NAME}. Index: {SITE_URL}/llms.txt"
    )
    return "\n\n---\n\n".join([intro] + [page.markdown(index_link=False) for page in pages]) + "\n"


def render_sitemap_xml(pages) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for page in pages:
        lines += ["  <url>", f"    <loc>{xml_escape(page.url)}</loc>"]
        if page.lastmod:
            lines.append(f"    <lastmod>{page.lastmod.isoformat()}</lastmod>")
        lines.append("  </url>")
    return "\n".join(lines + ["</urlset>"]) + "\n"


# Styled like the other subpages (ideology.html, contact.html)
SITEMAP_HTML = """\
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sitemap | {site_name}</title>
        <link rel="icon" type="image/x-icon" href="./assets/favicon.ico">
        <meta name="description" content="Every page on {site_name}.">
        <script type="module" src="/assets/screensaver.js"></script>
        <style>
            body {{ max-width: 720px; margin: 40px auto; padding: 0 16px; }}
        </style>
        <link rel="canonical" href="{site_url}/sitemap">
    </head>
    <body>
{sections}
        <h2> For Robots </h2>
        <ul>
            <li> <a href="/llms.txt">llms.txt</a> </li>
            <li> <a href="/llms-full.txt">llms-full.txt</a> </li>
            <li> <a href="/sitemap.xml">sitemap.xml</a> </li>
            <li> <a href="/robots.txt">robots.txt</a> </li>
        </ul>
        <br>
        <nav><a href="/">[ Home ]</a></nav>
    </body>
</html>
"""


def render_sitemap_html(pages) -> str:
    blocks = []
    for section, section_pages in sections(pages):
        items = "\n".join(
            f'            <li> <a href="{html.escape(p.path)}">{html.escape(p.title)}</a> </li>'
            for p in section_pages
        )
        heading = html.escape(section_title(section, "Sitemap"))
        blocks.append(f"        <h2> {heading} </h2>\n        <ul>\n{items}\n        </ul>")
    return SITEMAP_HTML.format(site_name=SITE_NAME, site_url=SITE_URL, sections="\n".join(blocks))


def render_headers(pages, existing: str) -> str:
    rules = "\n".join(
        f'{p.markdown_path}\n  Link: <{p.url}>; rel="canonical", </llms.txt>; rel="describedby"'
        for p in pages
    )
    generated = f"# Added by scripts/sitegen.py: Markdown copies point at their page and llms.txt\n{rules}\n"
    return f"{existing.rstrip()}\n\n{generated}" if existing.strip() else generated


def with_head_links(text: str, page: Page) -> str:
    """Adds canonical, Markdown alternate and llms.txt links to a page's <head> if missing."""
    doc = parse_html(text)
    tags = []
    if link_href(doc, "canonical") is None:
        tags.append(f'<link rel="canonical" href="{html.escape(page.url)}">')
    if link_href(doc, "alternate", "text/markdown") is None:
        tags.append(f'<link rel="alternate" type="text/markdown" href="{html.escape(page.markdown_path)}">')
    if link_href(doc, "describedby") is None:
        tags.append('<link rel="describedby" href="/llms.txt">')
    match = re.search(r"([ \t]*)</head>", text, re.IGNORECASE)
    if not tags or not match:
        return text
    indent = match.group(1)
    added = "".join(f"{indent}    {tag}\n" for tag in tags)
    return f"{text[:match.start()]}{added}{text[match.start():]}"


def build(public: Path, dist: Path, lastmods: dict) -> list:
    """Writes public/ plus the generated files to dist/ and returns the pages."""
    pages = load_pages(public, lastmods)
    by_source = {page.source: page for page in pages}

    files = {}
    for path in sorted(p for p in public.rglob("*") if p.is_file()):
        rel = PurePosixPath(path.relative_to(public).as_posix())
        data = path.read_bytes()
        if rel in by_source:
            data = with_head_links(data.decode("utf-8"), by_source[rel]).encode("utf-8")
        files[rel] = data

    headers = files.pop(PurePosixPath("_headers"), b"").decode("utf-8")
    generated = {
        "llms.txt": render_llms_txt(pages),
        "llms-full.txt": render_llms_full_txt(pages),
        "sitemap.xml": render_sitemap_xml(pages),
        "sitemap.html": render_sitemap_html(pages),
        "_headers": render_headers(pages, headers),
    }
    generated.update({page.markdown_path.lstrip("/"): page.markdown() + "\n" for page in pages})
    files.update({PurePosixPath(name): text.encode("utf-8") for name, text in generated.items()})

    # Update dist/ in place (only changed files) so `wrangler dev` keeps watching it.
    # Delete stale files first: on a case-insensitive filesystem a renamed file's
    # old name (About.html) matches its new one (about.html).
    dist.mkdir(parents=True, exist_ok=True)
    for path in list(dist.rglob("*")):
        if path.is_file() and PurePosixPath(path.relative_to(dist).as_posix()) not in files:
            path.unlink()
    for rel, data in files.items():
        target = dist / rel
        if not target.is_file() or target.read_bytes() != data:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    for path in sorted(dist.rglob("*"), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    return pages


def git_lastmods(root: Path, public: Path) -> dict:
    """Last commit time of each HTML file in public/, keyed by path relative to public/."""

    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, check=True
        ).stdout.strip()

    try:
        shallow = git("rev-parse", "--is-shallow-repository")
    except (OSError, subprocess.CalledProcessError):
        print("sitegen: warning: not a git checkout; leaving out last-modified dates", file=sys.stderr)
        return {}
    if shallow == "true":
        raise SiteError(
            ["shallow git clone: last-modified dates would be wrong; fetch full history (actions/checkout `fetch-depth: 0`)"]
        )
    lastmods = {}
    for source in html_sources(public):
        timestamp = git("log", "-1", "--format=%ct", "--", str((public / source).relative_to(root)))
        if timestamp:
            lastmods[source.as_posix()] = datetime.fromtimestamp(int(timestamp), tz=timezone.utc)
        else:
            print(f"sitegen: warning: public/{source} isn't committed; leaving out its last-modified date", file=sys.stderr)
    return lastmods


def main() -> int:
    try:
        pages = build(PUBLIC, DIST, git_lastmods(ROOT, PUBLIC))
    except SiteError as err:
        for problem in err.problems:
            print(f"sitegen: error: {problem}", file=sys.stderr)
        return 1
    print(f"sitegen: {len(pages)} pages -> dist/ (llms.txt, llms-full.txt, sitemap.xml, sitemap.html, Markdown copies)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
