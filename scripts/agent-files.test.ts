// Tests for site/lib/agent-files.ts. Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    SiteError, agentFiles, loadPages, markdownPath, pageMarkdown, pagePath, parseHtml, toMarkdown,
} from "../site/lib/agent-files.ts";

const page = (title = "About | alexkan.xyz", description = "About me.", body = "", head = "") => `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <meta name="description" content="${description}">${head}
    </head>
    <body>
${body}
    </body>
</html>
`;

describe("paths", () => {
    test("page paths follow Workers html_handling", () => {
        const cases = { "index.html": "/", "about.html": "/about", "notes/index.html": "/notes/", "notes/one.html": "/notes/one" };
        for (const [source, path] of Object.entries(cases)) assert.equal(pagePath(source), path);
    });

    test("Markdown paths match markdown_path in src/lib.rs", () => {
        assert.equal(markdownPath("/"), "/index.md");
        assert.equal(markdownPath("/about"), "/about.md");
        assert.equal(markdownPath("/notes/"), "/notes/index.md");
    });
});

describe("HTML to Markdown", () => {
    const render = (body: string, title = "About") =>
        toMarkdown(parseHtml(page(undefined, undefined, body)), title, "https://alexkan.xyz/about", new Map([["/contact.html", "https://alexkan.xyz/contact"]]));

    test("content", () => {
        const md = render(`
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
            <p>Absolute links stay as written: <a href="https://istheldown.com">istheldown</a></p>`);
        assert.equal(
            md,
            [
                "I like **black metal** and [PGP](https://alexkan.xyz/contact#pgp).",
                "## Lists",
                "- One\n- Two\n  - Nested",
                "3. Three",
                "![A picture](https://alexkan.xyz/assets/a%20b.jpg)",
                "Absolute links stay as written: [istheldown](https://istheldown.com)",
            ].join("\n\n"),
        );
    });

    test("prefers <main> and demotes h1", () => {
        assert.equal(render("<header>Skipped</header><main><h1>About</h1><p>Hi<br>there</p><h1>More</h1></main>"), "Hi\nthere\n\n## More");
    });

    test("omitted end tags", () => {
        const md = render(`
            <ul><li><p>One<li><p>Two</ul>
            <ul><li>A<ul><li>B<li>C</ul><li>D</ul>
            <table><tr><th>Name<th>Year<tr><td>Vim<td>1991<tr><td>Emacs<td>1976</table>`);
        assert.equal(
            md,
            ["- One\n- Two", "- A\n  - B\n  - C\n- D", "| Name | Year |\n| --- | --- |\n| Vim | 1991 |\n| Emacs | 1976 |"].join("\n\n"),
        );
    });

    test("pre, blockquote and table", () => {
        const md = render(`
            <pre><code>fn main() {
    ok();
}</code></pre>
            <blockquote><p>Quote</p><p>Two</p></blockquote>
            <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x|y</td></tr></table>`);
        assert.equal(md, ["```\nfn main() {\n    ok();\n}\n```", "> Quote\n>\n> Two", "| A | B |\n| --- | --- |\n| 1 | x\\|y |"].join("\n\n"));
    });

    test("hidden content is left out", () => {
        assert.equal(render('<p hidden>No</p><p aria-hidden="true">No</p><canvas>No</canvas><p>Yes</p>'), "Yes");
    });
});

describe("generated files", () => {
    const site = () => ({
        html: new Map([
            ["index.html", page("alexkan.xyz", "Personal website.", "<main><h2>alexkan.xyz</h2><p>Hi.</p></main>")],
            ["ideology.html", page("Ideology | alexkan.xyz", "Likes and dislikes.", "<h2>Likes</h2><ul><li>Vim</li></ul>")],
            ["notes/index.html", page("Notes | alexkan.xyz", "Notes.", "<p>Note.</p>")],
            ["404.html", '<html><head><meta name="robots" content="noindex"><title>Not found</title></head></html>'],
        ]),
        lastmods: new Map([["ideology.html", new Date("2026-09-01T12:30:00Z")]]),
        publicFiles: new Set(["assets/cig.jpg"]),
    });

    test("llms.txt, Markdown copies, llms-full.txt, sitemap.xml and _headers", () => {
        const pages = loadPages(site());
        assert.deepEqual(pages.map((p) => p.path), ["/", "/ideology", "/notes/"]);
        const files = agentFiles(pages, "/assets/*\n  Cache-Control: max-age=60\n");

        assert.equal(
            files.get("llms.txt"),
            `# alexkan.xyz

> Personal website.

Each link below is a Markdown copy of a page. Any page is also available as Markdown by adding \`.md\` to its path (\`/index.md\` for the homepage) or by requesting it with an \`Accept: text/markdown\` header.

## Pages

- [alexkan.xyz](https://alexkan.xyz/index.md): Personal website.
- [Ideology](https://alexkan.xyz/ideology.md): Likes and dislikes.

## Notes

- [Notes](https://alexkan.xyz/notes/index.md): Notes.

## Optional

- [Full text](https://alexkan.xyz/llms-full.txt): every page above in one Markdown file
- [Sitemap](https://alexkan.xyz/sitemap.xml): every page with its last-modified date
`,
        );
        assert.equal(
            files.get("ideology.md"),
            "# Ideology\n\n> Likes and dislikes.\n\nSource: https://alexkan.xyz/ideology (last updated 2026-09-01)\n" +
                "All pages: https://alexkan.xyz/llms.txt\n\n## Likes\n\n- Vim\n",
        );
        assert.equal(
            files.get("index.md"),
            "# alexkan.xyz\n\n> Personal website.\n\nSource: https://alexkan.xyz/\nAll pages: https://alexkan.xyz/llms.txt\n\nHi.\n",
        );
        assert.equal(files.get("notes/index.md")!.split("\n")[0], "# Notes");
        assert.ok(!files.has("404.md"));

        const full = files.get("llms-full.txt")!;
        assert.ok(full.startsWith("# alexkan.xyz\n\n> Personal website.\n\n"));
        assert.ok(!full.includes("All pages:"));
        for (const p of pages) assert.ok(full.includes(pageMarkdown(p, false)));

        assert.equal(
            files.get("sitemap.xml"),
            `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://alexkan.xyz/</loc>
  </url>
  <url>
    <loc>https://alexkan.xyz/ideology</loc>
    <lastmod>2026-09-01T12:30:00+00:00</lastmod>
  </url>
  <url>
    <loc>https://alexkan.xyz/notes/</loc>
  </url>
</urlset>
`,
        );

        const headers = files.get("_headers")!;
        assert.ok(headers.startsWith("/assets/*\n  Cache-Control: max-age=60\n\n"));
        assert.ok(headers.includes('/ideology.md\n  Link: <https://alexkan.xyz/ideology>; rel="canonical", </llms.txt>; rel="describedby"\n'));
        assert.ok(headers.includes('/notes/index.md\n  Link: <https://alexkan.xyz/notes/>; rel="canonical"'));
    });

    test("the same input always builds the same files", () => {
        assert.deepEqual(agentFiles(loadPages(site())), agentFiles(loadPages(site())));
    });

    test("problems fail the build, all reported at once", () => {
        const input = site();
        input.html.set("untitled.html", "<html><head></head><body>x</body></html>");
        input.html.set("v1.2/index.html", page("Old | alexkan.xyz"));
        input.html.set("moved.html", page("Moved | alexkan.xyz", undefined, "", '<link rel="canonical" href="https://alexkan.xyz/elsewhere">'));
        input.publicFiles.add("llms.txt").add("notes/index.md");
        assert.throws(
            () => loadPages(input),
            (err: unknown) => {
                assert.ok(err instanceof SiteError);
                assert.deepEqual(err.problems, [
                    "moved.html: canonical URL 'https://alexkan.xyz/elsewhere' should be 'https://alexkan.xyz/moved'",
                    "notes/index.md: conflicts with the generated Markdown copy of notes/index.html".replace(/^/, "public/"),
                    "untitled.html: add a <title>",
                    'untitled.html: add <meta name="description" content="..."> (used in llms.txt)',
                    "v1.2/index.html: rename it; page URLs can't contain '.' (the Worker treats those as files)",
                    "public/llms.txt: remove it; the Astro build generates this file",
                ]);
                return true;
            },
        );
    });
});
