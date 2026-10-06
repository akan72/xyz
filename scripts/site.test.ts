// Checks the built site in dist/. Run after `npm run build`: npm test
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { SITE_URL, linkHref, markdownPath, metaContent, pagePath, parseHtml } from "../site/lib/agent-files.ts";

const dist = (name: string) => readFileSync(`dist/${name}`, "utf8");
assert.ok(existsSync("dist/index.html"), "build the site first: npm run build");

const htmlFiles = readdirSync("dist").filter((f) => f.endsWith(".html")).sort();
const indexable = htmlFiles.filter((f) => !metaContent(parseHtml(dist(f)), "robots").includes("noindex"));

describe("every page", () => {
    test("covers the five pages, with only 404 left out of the index", () => {
        assert.deepEqual(htmlFiles, ["404.html", "contact.html", "ideology.html", "index.html", "projects.html"]);
        assert.deepEqual(indexable, ["contact.html", "ideology.html", "index.html", "projects.html"]);
    });

    for (const file of htmlFiles) {
        test(`${file} inlines the render-blocking assets and shares the header`, () => {
            const html = dist(file);
            const doc = parseHtml(html);
            const theme = readFileSync("public/assets/theme.js", "utf8").replace(/<\/script/gi, "<\\/script");
            assert.ok(html.includes(`<script data-inline-source="/assets/theme.js">\n${theme}\n</script>`));
            for (const name of ["typography.css", "navigation.css", "transitions.css"]) {
                assert.ok(html.includes(`<style data-inline-source="/assets/${name}">\n${readFileSync(`public/assets/${name}`, "utf8")}\n</style>`), name);
            }
            const headers = [...doc.iter()].filter((el) => el.tag === "header");
            assert.equal(headers.length, 1);
            const links = [...headers[0].iter()].filter((el) => el.tag === "a").map((el) => [el.text(), el.attrs.href]);
            assert.deepEqual(links, [["Main", "/"], ["Ideology", "/ideology"], ["Projects", "/projects"], ["Contact", "/contact"]]);
            const current = [...headers[0].iter()].filter((el) => el.attrs["aria-current"] === "page").map((el) => el.attrs.href);
            assert.deepEqual(current, file === "404.html" ? [] : [pagePath(file)]);
            assert.equal(html.split('src="/assets/page-navigation.js"').length - 1, 1);
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
            const doc = parseHtml(dist(file));
            assert.equal(linkHref(doc, "canonical"), SITE_URL + path);
            assert.equal(linkHref(doc, "alternate", "text/markdown"), markdownPath(path));
            assert.equal(linkHref(doc, "describedby"), "/llms.txt");
            assert.ok(dist("_headers").includes(`${markdownPath(path)}\n  Link: <${SITE_URL}${path}>; rel="canonical"`));
        });
    }

    test("the 404 page is left out", () => {
        assert.ok(!existsSync("dist/404.md"));
        assert.ok(!sitemap.includes("/404"));
        assert.ok(!llms.includes("/404"));
        assert.equal(linkHref(parseHtml(dist("404.html")), "canonical"), undefined);
    });
});

describe("/projects", () => {
    const doc = parseHtml(dist("projects.html"));
    const items = [...doc.find("main")!.iter()].filter((el) => el.tag === "li");

    test("lists every project in site/content/projects/", () => {
        assert.equal(items.length, readdirSync("site/content/projects").filter((f) => f.endsWith(".yaml")).length);
    });

    test("every project shows its years, a description and its stack", () => {
        for (const li of items) {
            const name = li.find("a")!.text();
            const years = [...li.iter()].find((el) => el.attrs.class === "years")?.text() ?? "";
            assert.match(years, /^\((\d{4})(-(\d{4}|Present))?\)$/, name);
            const paragraphs = [...li.iter()].filter((el) => el.tag === "p" && !el.attrs.class);
            assert.equal(paragraphs.length, 1, name);
            const stack = [...li.iter()].find((el) => el.attrs.class === "meta")?.text() ?? "";
            assert.ok(stack.trim(), `${name}: missing its stack line`);
        }
    });

    test("the live istheldown figure and its loaders are on the page", () => {
        const html = dist("projects.html");
        for (const id of ["subway-vis-caption", "subway-vis", "subway-map"]) assert.ok([...doc.iter()].some((el) => el.attrs.id === id), id);
        assert.ok(html.includes("wss://istheldown.com/ws?systems=subway&alerts=subway"));
        assert.ok(html.includes('<script src="/assets/subway-vis.js" defer></script>'));
        assert.ok(html.includes('<link rel="preload" as="script" href="https://cdn.jsdelivr.net/npm/hydra-synth@1.4.0/dist/hydra-synth.js">'));
    });
});
