// Checks the built site in dist/. Run after `npm run build`: npm test
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { parse } from "node-html-parser";
import { markdownPath } from "../site/integrations/agent-files.ts";

const SITE_URL = "https://alexkan.xyz";
const pagePath = (file: string) => (file === "index.html" ? "/" : "/" + file.replace(/\.html$/, ""));
const frontmatter = (file: string) => readFileSync(file, "utf8").split(/^---$/m)[1] ?? "";

const dist = (name: string) => readFileSync(`dist/${name}`, "utf8");
assert.ok(existsSync("dist/index.html"), "build the site first: npm run build");

const htmlFiles = readdirSync("dist", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".html")).sort();
const doc = (file: string) => parse(dist(file));
const indexable = htmlFiles.filter((f) => !doc(f).querySelector('meta[name="robots"][content*="noindex"]'));

describe("every page", () => {
    test("covers the site's pages, with only 404 left out of the index", () => {
        for (const page of ["404.html", "contact.html", "ideology.html", "index.html", "projects.html", "writing.html"]) assert.ok(htmlFiles.includes(page), page);
        assert.deepEqual(htmlFiles.filter((f) => !indexable.includes(f)), ["404.html"]);
    });

    for (const file of htmlFiles) {
        test(`${file} sets the theme before paint, inlines its CSS, and shares the header`, () => {
            const page = doc(file);
            const head = page.querySelector("head")!;
            // theme.js is the first script, inline and blocking
            const first = head.querySelector("script")!;
            assert.ok(!first.getAttribute("src") && !first.getAttribute("type") && first.text.includes("data-theme-toggle"));
            // Astro inlines the CSS: no stylesheet requests
            assert.equal(head.querySelectorAll('link[rel="stylesheet"]').length, 0);
            assert.ok(head.querySelectorAll("style").some((s) => s.text.includes("scrollbar-gutter")));
            const headers = page.querySelectorAll("header");
            assert.equal(headers.length, 1);
            const links = headers[0].querySelectorAll("a").map((a) => [a.text, a.getAttribute("href")]);
            assert.deepEqual(links, [["Main", "/"], ["Ideology", "/ideology"], ["Projects", "/projects"], ["Contact", "/contact"]]);
            const current = headers[0].querySelectorAll('[aria-current="page"]').map((a) => a.getAttribute("href"));
            // The page's own link is marked, if it has one in the header (404 and Writing don't)
            assert.deepEqual(current, links.map(([, href]) => href).filter((href) => href === pagePath(file)));
        });
    }
});

describe("machine-readable files", () => {
    const sitemap = dist("sitemap.xml");
    const llms = dist("llms.txt");

    for (const file of indexable) {
        const path = pagePath(file);
        test(`${path} is in the sitemap and llms.txt, with a Markdown copy its <head> points to`, () => {
            assert.ok(sitemap.includes(`<loc>${SITE_URL}${path}</loc>`));
            assert.ok(llms.includes(`](${SITE_URL}${markdownPath(path)}): `));
            assert.ok(dist(markdownPath(path).slice(1)).startsWith("# "));
            const page = doc(file);
            assert.equal(page.querySelector('link[rel="canonical"]')?.getAttribute("href"), SITE_URL + path);
            assert.equal(page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute("href"), markdownPath(path));
            assert.equal(page.querySelector('link[rel="describedby"]')?.getAttribute("href"), "/llms.txt");
            assert.ok(dist("_headers").includes(`${markdownPath(path)}\n  Link: <${SITE_URL}${path}>; rel="canonical"`));
        });
    }

    test("the 404 page is left out", () => {
        assert.ok(!existsSync("dist/404.md"));
        assert.ok(!sitemap.includes("/404"));
        assert.ok(!llms.includes("/404"));
        assert.equal(doc("404.html").querySelector('link[rel="canonical"]'), null);
    });
});

describe("/projects", () => {
    const main = doc("projects.html").querySelector("main")!;
    const items = main.querySelectorAll("li");

    test("lists every project in site/content/projects/", () => {
        assert.equal(items.length, readdirSync("site/content/projects").filter((f) => f.endsWith(".md")).length);
    });

    test("every project shows its years, a description and its stack", () => {
        for (const li of items) {
            const name = li.querySelector("a")!.text;
            assert.match(li.querySelector(".years")?.text ?? "", /^\((\d{4})(-(\d{4}|Present))?\)$/, name);
            assert.equal(li.querySelectorAll("p:not([class])").length, 1, name);
            assert.ok(li.querySelector(".meta")?.text.trim(), `${name}: missing its stack line`);
        }
    });

    test("links in descriptions open in a new tab", () => {
        const link = main.querySelector('a[href="https://opensea.io/collection/cigawrettepacks"]');
        assert.equal(link?.getAttribute("target"), "_blank");
    });

    test("the live istheldown figure and its loaders are on the page", () => {
        const html = dist("projects.html");
        for (const id of ["subway-vis-caption", "subway-vis", "subway-map"]) assert.ok(main.querySelector(`#${id}`), id);
        assert.ok(html.includes("wss://istheldown.com/ws?systems=subway&alerts=subway"));
        assert.ok(html.includes('<script src="/assets/subway-vis.js" defer></script>'));
        assert.ok(html.includes('<link rel="preload" as="script" href="https://cdn.jsdelivr.net/npm/hydra-synth@1.4.0/dist/hydra-synth.js">'));
    });
});

describe("/writing", () => {
    const sources = readdirSync("site/content/writing").filter((f) => /\.mdx?$/.test(f));
    const published = sources.filter((f) => !/^draft:\s*true\s*$/m.test(frontmatter(`site/content/writing/${f}`)));

    test("builds a page and a Markdown copy for every published post, and none for drafts", () => {
        for (const file of sources) {
            const slug = file.replace(/\.mdx?$/, "");
            const built = existsSync(`dist/writing/${slug}.html`);
            assert.equal(built, published.includes(file), `${file}: ${built ? "built" : "not built"}`);
            assert.equal(existsSync(`dist/writing/${slug}.md`), built);
        }
    });

    test("the index links every published post", () => {
        const links = doc("writing.html").querySelectorAll("main li a").map((a) => a.getAttribute("href"));
        assert.deepEqual(links.sort(), published.map((f) => `/writing/${f.replace(/\.mdx?$/, "")}`).sort());
    });
});
