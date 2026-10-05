"""Tests for sitegen.py. Run: python3 -m unittest discover -s scripts"""

import re
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import projects
import sitegen

PAGE = """<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>{title}</title>
        <meta name="description" content="{description}">
    </head>
    <body>
{body}
    </body>
</html>
"""


def page(title="About | alexkan.xyz", description="About me.", body=""):
    return PAGE.format(title=title, description=description, body=body)


class PathTests(unittest.TestCase):
    def test_page_paths_follow_workers_html_handling(self):
        cases = {
            "index.html": "/",
            "about.html": "/about",
            "notes/index.html": "/notes/",
            "notes/one.html": "/notes/one",
        }
        for source, path in cases.items():
            self.assertEqual(sitegen.page_path(PurePosixPath(source)), path)

    def test_markdown_paths(self):
        self.assertEqual(sitegen.markdown_path("/"), "/index.md")
        self.assertEqual(sitegen.markdown_path("/about"), "/about.md")
        self.assertEqual(sitegen.markdown_path("/notes/"), "/notes/index.md")


class MarkdownTests(unittest.TestCase):
    def render(self, body, title="About"):
        doc = sitegen.parse_html(page(body=body))
        page_urls = {"/contact.html": "https://alexkan.xyz/contact"}
        return sitegen.to_markdown(doc, title, "https://alexkan.xyz/about", page_urls)

    def test_content(self):
        md = self.render(
            """
            <h2> About </h2>
            <nav><a href="/">[ Home ]</a></nav>
            <p>I like <b> black metal </b>and <a href="./contact.html#pgp">PGP</a>.</p>
            <h3>Lists</h3>
            <ul>
                <li>One
                <li>Two<ul><li>Nested</li></ul></li>
            </ul>
            <ol start="3"><li>Three</li></ol>
            <button>Get Random Cig</button>
            <img src="./assets/a b.jpg" alt="A picture">
            <img src="./assets/spacer.gif" alt="">
            """
        )
        self.assertEqual(
            md,
            "\n\n".join(
                [
                    "I like **black metal** and [PGP](https://alexkan.xyz/contact#pgp).",
                    "## Lists",
                    "- One\n- Two\n  - Nested",
                    "3. Three",
                    "![A picture](https://alexkan.xyz/assets/a%20b.jpg)",
                ]
            ),
        )

    def test_prefers_main_and_demotes_h1(self):
        md = self.render(
            "<header>Skipped</header><main><h1>About</h1><p>Hi<br>there</p><h1>More</h1></main>"
        )
        self.assertEqual(md, "Hi\nthere\n\n## More")

    def test_omitted_end_tags(self):
        md = self.render(
            """
            <ul><li><p>One<li><p>Two</ul>
            <ul><li>A<ul><li>B<li>C</ul><li>D</ul>
            <table><tr><th>Name<th>Year<tr><td>Vim<td>1991<tr><td>Emacs<td>1976</table>
            """
        )
        self.assertEqual(
            md,
            "\n\n".join(
                [
                    "- One\n- Two",
                    "- A\n  - B\n  - C\n- D",
                    "| Name | Year |\n| --- | --- |\n| Vim | 1991 |\n| Emacs | 1976 |",
                ]
            ),
        )

    def test_page_without_head_or_body_tags(self):
        doc = sitegen.parse_html("<!DOCTYPE html><title>About</title><p>Just text.")
        self.assertEqual(sitegen.to_markdown(doc, "About", "https://alexkan.xyz/about", {}), "Just text.")

    def test_pre_blockquote_and_table(self):
        md = self.render(
            """
            <pre><code>fn main() {
    ok();
}</code></pre>
            <blockquote><p>Quote</p><p>Two</p></blockquote>
            <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x|y</td></tr></table>
            """
        )
        self.assertEqual(
            md,
            "\n\n".join(
                [
                    "```\nfn main() {\n    ok();\n}\n```",
                    "> Quote\n>\n> Two",
                    "| A | B |\n| --- | --- |\n| 1 | x\\|y |",
                ]
            ),
        )


class BuildTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.public = Path(tmp.name) / "public"
        self.dist = Path(tmp.name) / "dist"
        self.write(
            "index.html",
            page("alexkan.xyz", "Personal website.", "<main><h2>alexkan.xyz</h2><p>Hi.</p></main>"),
        )
        self.write(
            "ideology.html",
            page("Ideology | alexkan.xyz", "Likes and dislikes.", "<h2>Likes</h2><ul><li>Vim</li></ul>"),
        )
        self.write("notes/index.html", page("Notes | alexkan.xyz", "Notes.", "<p>Note.</p>"))
        self.write(
            "404.html",
            '<html><head><meta name="robots" content="noindex"><title>Not found</title></head></html>',
        )
        self.write("assets/cig.jpg", b"\xff\xd8")
        self.write("_headers", "/assets/*\n  Cache-Control: max-age=60\n")

    def write(self, rel, content):
        path = self.public / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)

    def read(self, rel):
        return (self.dist / rel).read_text()

    def snapshot(self):
        return {p.relative_to(self.dist): p.read_bytes() for p in self.dist.rglob("*") if p.is_file()}

    def test_generated_files(self):
        updated = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
        pages = sitegen.build(self.public, self.dist, {"ideology.html": updated})

        self.assertEqual([p.path for p in pages], ["/", "/ideology", "/notes/"])
        self.assertEqual(
            self.read("llms.txt"),
            """# alexkan.xyz

> Personal website.

Each link below is a Markdown copy of a page. Any page is also available as Markdown by adding `.md` to its path (`/index.md` for the homepage) or by requesting it with an `Accept: text/markdown` header.

## Pages

- [alexkan.xyz](https://alexkan.xyz/index.md): Personal website.
- [Ideology](https://alexkan.xyz/ideology.md): Likes and dislikes.

## Notes

- [Notes](https://alexkan.xyz/notes/index.md): Notes.

## Optional

- [Full text](https://alexkan.xyz/llms-full.txt): every page above in one Markdown file
- [Sitemap](https://alexkan.xyz/sitemap.xml): every page with its last-modified date
""",
        )
        self.assertEqual(
            self.read("ideology.md"),
            "# Ideology\n\n> Likes and dislikes.\n\n"
            "Source: https://alexkan.xyz/ideology (last updated 2026-09-01)\n"
            "All pages: https://alexkan.xyz/llms.txt\n\n"
            "## Likes\n\n- Vim\n",
        )
        self.assertEqual(
            self.read("index.md"),
            "# alexkan.xyz\n\n> Personal website.\n\nSource: https://alexkan.xyz/\n"
            "All pages: https://alexkan.xyz/llms.txt\n\nHi.\n",
        )
        self.assertEqual(self.read("notes/index.md").splitlines()[0], "# Notes")

        full = self.read("llms-full.txt")
        self.assertTrue(full.startswith("# alexkan.xyz\n\n> Personal website.\n\n"))
        self.assertNotIn("All pages:", full)
        for p in pages:
            self.assertIn(p.markdown(index_link=False), full)

        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        urls = ET.fromstring(self.read("sitemap.xml")).findall("s:url", ns)
        self.assertEqual(
            [(u.findtext("s:loc", namespaces=ns), u.findtext("s:lastmod", namespaces=ns)) for u in urls],
            [
                ("https://alexkan.xyz/", None),
                ("https://alexkan.xyz/ideology", "2026-09-01T12:30:00+00:00"),
                ("https://alexkan.xyz/notes/", None),
            ],
        )

        self.assertFalse((self.dist / "sitemap.html").exists())

        ideology = self.read("ideology.html")
        self.assertIn(
            '        <link rel="canonical" href="https://alexkan.xyz/ideology">\n'
            '        <link rel="alternate" type="text/markdown" href="/ideology.md">\n'
            '        <link rel="describedby" href="/llms.txt">\n'
            "    </head>",
            ideology,
        )
        self.assertEqual(self.read("404.html"), (self.public / "404.html").read_text())
        self.assertEqual((self.dist / "assets/cig.jpg").read_bytes(), b"\xff\xd8")

        headers = self.read("_headers")
        self.assertTrue(headers.startswith("/assets/*\n  Cache-Control: max-age=60\n\n"))
        self.assertIn(
            '/ideology.md\n  Link: <https://alexkan.xyz/ideology>; rel="canonical", </llms.txt>; rel="describedby"\n',
            headers,
        )
        self.assertIn('/notes/index.md\n  Link: <https://alexkan.xyz/notes/>; rel="canonical"', headers)

    def test_rebuild_is_deterministic_and_prunes_stale_files(self):
        sitegen.build(self.public, self.dist, {})
        first = self.snapshot()

        ideology = (self.public / "ideology.html").read_text()
        (self.public / "ideology.html").unlink()
        sitegen.build(self.public, self.dist, {})
        self.assertFalse((self.dist / "ideology.html").exists())
        self.assertFalse((self.dist / "ideology.md").exists())
        self.assertNotIn("Ideology", self.read("llms.txt"))

        self.write("ideology.html", ideology)
        sitegen.build(self.public, self.dist, {})
        self.assertEqual(self.snapshot(), first)

    def test_existing_head_links_are_kept(self):
        self.write(
            "ideology.html",
            page("Ideology | alexkan.xyz", "Likes.").replace(
                "</head>", '<link rel="canonical" href="https://alexkan.xyz/ideology"></head>'
            ),
        )
        sitegen.build(self.public, self.dist, {})
        self.assertEqual(self.read("ideology.html").count('rel="canonical"'), 1)

    def test_problems_fail_the_build(self):
        self.write("untitled.html", "<html><head></head><body>x</body></html>")
        self.write("v1.2/index.html", page("Old | alexkan.xyz"))
        self.write("llms.txt", "hand-written")
        self.write("notes/index.md", "hand-written")
        self.write(
            "moved.html",
            page("Moved | alexkan.xyz").replace(
                "</head>", '<link rel="canonical" href="https://alexkan.xyz/elsewhere"></head>'
            ),
        )
        with self.assertRaises(sitegen.SiteError) as err:
            sitegen.build(self.public, self.dist, {})
        self.assertEqual(
            err.exception.problems,
            [
                "public/moved.html: canonical URL 'https://alexkan.xyz/elsewhere' should be 'https://alexkan.xyz/moved'",
                "public/notes/index.md: conflicts with the generated Markdown copy of public/notes/index.html",
                "public/untitled.html: add a <title>",
                'public/untitled.html: add <meta name="description" content="..."> (used in llms.txt)',
                "public/v1.2/index.html: rename it; page URLs can't contain '.' (the Worker treats those as files)",
                "public/llms.txt: remove it; scripts/sitegen.py generates this file",
            ],
        )
        self.assertFalse(self.dist.exists())


class ProjectsTests(unittest.TestCase):
    """scripts/projects.py: the typed project data behind /projects."""

    def test_year_labels(self):
        self.assertEqual(projects.Since(2020).label(), "(2020-Present)")
        self.assertEqual(projects.Range(2020, 2023).label(), "(2020-2023)")
        self.assertEqual(projects.Single(2025).label(), "(2025)")

    def test_impossible_values_raise(self):
        bad = [
            lambda: projects.Range(2023, 2021),  # backwards
            lambda: projects.Range(2023, 2023),  # one year: use Single
            lambda: projects.Since(1999),
            lambda: projects.Single(20025),
            lambda: projects.Project("x", "http://x", projects.Since(2020), "About.", ("Rust",)),  # not https
            lambda: projects.Project("x", "https://x", projects.Since(2020), " ", ("Rust",)),  # no about
            lambda: projects.Project("x", "https://x", projects.Since(2020), "About.", ()),  # no stack
        ]
        for make in bad:
            with self.assertRaises(ValueError):
                make()

    def test_render(self):
        project = projects.Project(
            "dotfiles", "https://github.com/akan72/dotfiles", projects.Since(2020),
            'My <a href="https://x">dotfiles</a>!', ("Lua", "shell, zsh"), media="<p>fig</p>",
        )
        self.assertEqual(
            projects.render_project(project, indent=""),
            '<li> <a href="https://github.com/akan72/dotfiles" target="_blank">dotfiles</a> <span class="years">(2020-Present)</span>\n'
            "    <p>fig</p>\n"
            '    <p>My <a href="https://x">dotfiles</a>!</p>\n'
            '    <p class="meta">Lua &middot; shell, zsh</p>\n'
            "</li>",
        )

    def test_projects_page_lists_every_project(self):
        page = (sitegen.PUBLIC / "projects.html").read_text(encoding="utf-8")
        self.assertRegex(page, sitegen.PROJECTS_MARKER, "public/projects.html needs a <!-- sitegen:projects --> line")
        with tempfile.TemporaryDirectory() as tmp:
            sitegen.build(sitegen.PUBLIC, Path(tmp), {})
            built = (Path(tmp) / "projects.html").read_text(encoding="utf-8")
            markdown = (Path(tmp) / "projects.md").read_text(encoding="utf-8")
        self.assertNotRegex(built, sitegen.PROJECTS_MARKER)
        for p in projects.PROJECTS:
            self.assertIn(f">{p.name}</a> <span class=\"years\">{p.years.label()}</span>", built)
            self.assertIn(f"[{p.name}]({p.url}) {p.years.label()}", markdown)


class SiteTests(unittest.TestCase):
    def test_public_builds(self):
        with tempfile.TemporaryDirectory() as tmp:
            pages = sitegen.build(sitegen.PUBLIC, Path(tmp), {})
            paths = [p.path for p in pages]
            self.assertEqual(paths[0], "/")
            self.assertIn("/ideology", paths)
            self.assertNotIn("/404", paths)
            for p in pages:
                self.assertTrue((Path(tmp) / p.markdown_path.lstrip("/")).is_file())


if __name__ == "__main__":
    unittest.main()
