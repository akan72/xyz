// Tests for site/integrations/agent-files.ts. Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headers, llmsFullTxt, llmsTxt, markdownPath, pageMarkdown, readPage, sitemapXml } from "../site/integrations/agent-files.ts";

const site = new URL("https://alexkan.xyz");
const html = (title: string, description: string, main: string, head = "") =>
    `<!DOCTYPE html><html><head><title>${title}</title><meta name="description" content="${description}">${head}</head>` +
    `<body><header><h2>alexkan.xyz</h2><nav><a href="/">Main</a></nav></header><main>${main}</main></body></html>`;

describe("readPage", () => {
    test("turns <main> into Markdown, without the controls, the live figure or a heading that repeats the title", () => {
        const page = readPage(
            html("Projects | alexkan.xyz", "Things I've built.", `
                <h2> Projects </h2>
                <ul><li><a href="https://istheldown.com" target="_blank">istheldown.com</a> <span>(2026)</span>
                    <p hidden>Loading…</p><div><canvas></canvas></div>
                    <p>A map of <b>transit</b>. See <a href="/pgp.txt">PGP</a>.</p>
                    <button>Get Random Cig</button>
                    <img src="/assets/cig.jpg" alt="Cigawrette"></li></ul>`),
            "/projects",
            site,
        )!;
        assert.equal(page.title, "Projects");
        assert.equal(page.url, "https://alexkan.xyz/projects");
        assert.equal(
            page.body,
            [
                "-   [istheldown.com](https://istheldown.com) (2026)",
                "",
                "    A map of **transit**. See [PGP](https://alexkan.xyz/pgp.txt).",
                "",
                "    ![Cigawrette](https://alexkan.xyz/assets/cig.jpg)",
            ].join("\n"),
        );
    });

    test("keeps headings that don't repeat the title", () => {
        assert.equal(readPage(html("Ideology | alexkan.xyz", "Likes.", "<h2>Likes</h2><ul><li>Vim</li></ul>"), "/ideology", site)!.body, "## Likes\n\n-   Vim");
    });

    test("leaves out noindex pages", () => {
        assert.equal(readPage(html("Not found", "", "<p>x</p>", '<meta name="robots" content="noindex">'), "/404", site), undefined);
    });

    test("fails on a page without a title or description, or with a dot in its URL", () => {
        assert.throws(() => readPage(html("", "About me.", ""), "/about", site), /needs a <title> and a <meta name="description">/);
        assert.throws(() => readPage(html("About | alexkan.xyz", "", ""), "/about", site), /needs a <title> and a <meta name="description">/);
        assert.throws(() => readPage(html("Old | alexkan.xyz", "Old.", ""), "/v1.2/", site), /can't contain a dot/);
    });
});

describe("generated files", () => {
    const pages = [
        { path: "/", url: "https://alexkan.xyz/", title: "alexkan.xyz", description: "Personal website.", body: "Hi." },
        { path: "/ideology", url: "https://alexkan.xyz/ideology", title: "Ideology", description: "Likes.", body: "-   Vim", lastmod: new Date("2026-09-01T12:30:00Z") },
    ];

    test("Markdown copies sit where src/lib.rs's markdown_path looks", () => {
        assert.equal(markdownPath("/"), "/index.md");
        assert.equal(markdownPath("/ideology"), "/ideology.md");
        assert.equal(markdownPath("/notes/"), "/notes/index.md");
    });

    test("a page's Markdown copy", () => {
        assert.equal(
            pageMarkdown(pages[1], site),
            "# Ideology\n\n> Likes.\n\nSource: https://alexkan.xyz/ideology (last updated 2026-09-01)\nAll pages: https://alexkan.xyz/llms.txt\n\n-   Vim\n",
        );
    });

    test("llms.txt links every page's Markdown copy", () => {
        const text = llmsTxt(pages, site);
        assert.ok(text.startsWith("# alexkan.xyz\n\n> Personal website.\n"));
        assert.ok(text.includes("- [alexkan.xyz](https://alexkan.xyz/index.md): Personal website.\n- [Ideology](https://alexkan.xyz/ideology.md): Likes.\n"));
    });

    test("llms.txt lists pages in a directory under their own heading", () => {
        const post = { path: "/writing/first-post", url: "https://alexkan.xyz/writing/first-post", title: "First", description: "A post.", body: "Hi." };
        const text = llmsTxt([...pages, post], site);
        assert.ok(text.includes("## Pages\n\n- [alexkan.xyz]"));
        assert.ok(text.includes("## Writing\n\n- [First](https://alexkan.xyz/writing/first-post.md): A post.\n"));
        assert.ok(text.indexOf("## Pages") < text.indexOf("## Writing"));
    });

    test("llms-full.txt has every page, without the per-copy index link", () => {
        const text = llmsFullTxt(pages, site);
        for (const page of pages) assert.ok(text.includes(pageMarkdown(page, site, false)));
        assert.ok(!text.includes("All pages:"));
    });

    test("sitemap.xml dates pages that have a commit", () => {
        assert.equal(
            sitemapXml(pages),
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
                "  <url>\n    <loc>https://alexkan.xyz/</loc>\n  </url>\n" +
                "  <url>\n    <loc>https://alexkan.xyz/ideology</loc>\n    <lastmod>2026-09-01T12:30:00+00:00</lastmod>\n  </url>\n</urlset>\n",
        );
    });

    test("_headers points each Markdown copy at its page and llms.txt", () => {
        assert.ok(headers(pages).includes('/ideology.md\n  Link: <https://alexkan.xyz/ideology>; rel="canonical", </llms.txt>; rel="describedby"\n'));
    });
});
