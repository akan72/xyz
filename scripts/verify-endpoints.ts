// Run against a built local Worker or its deployment:
// node scripts/verify-endpoints.ts http://127.0.0.1:8787 --cig-id=1
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { parse } from "node-html-parser";
import { markdownPath, readPage } from "../site/integrations/agent-files.ts";

const origin = process.argv[2]?.replace(/\/$/, "");
if (!origin || !/^https?:\/\//.test(origin)) throw new Error("Supply the Worker origin to verify");
const cigId = process.argv.find(arg => arg.startsWith("--cig-id="))?.split("=")[1];
const files = readdirSync("dist", { recursive: true, encoding: "utf8" }).filter(file => statSync(`dist/${file}`).isFile());
const content = (file: string) => readFileSync(`dist/${file}`);
const pages = files.filter(file => file.endsWith(".html")).map(file =>
    readPage(content(file).toString(), "/" + file.replace(/(index)?\.html$/, ""), new URL("https://alexkan.xyz")))
    .filter(page => !!page);
const request = (path: string, accept = "*/*", method = "GET", headers = {}) =>
    fetch(origin + path, { method, headers: { Accept: accept, ...headers }, signal: AbortSignal.timeout(15000) });
const mediaType = (response: Response) => response.headers.get("content-type")?.split(";")[0];
const vary = (response: Response) => assert.ok(response.headers.get("vary")?.toLowerCase().split(/,\s*/).includes("accept"));

test("HTML pages, aliases, and discovery links", async () => {
    for (const page of pages) {
        const response = await request(page.path, "text/html");
        assert.equal(response.status, 200, page.path);
        assert.equal(mediaType(response), "text/html");
        vary(response);
        const html = await response.text(), doc = parse(html);
        assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), page.url);
        assert.equal(doc.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute("href"), markdownPath(page.path));
        assert.equal(doc.querySelector('link[rel="describedby"]')?.getAttribute("href"), "/llms.txt");
        assert.ok(html.includes('property="og:title"'));
        const alias = page.path === "/" ? "/index.html" : `${page.path}.html`;
        const redirected = await request(alias, "text/markdown");
        assert.equal(redirected.status, 200, alias);
        assert.equal(new URL(redirected.url).pathname, page.path);
        assert.equal(mediaType(redirected), "text/markdown");
    }
});

test("meaningful homepage and trust page content without JavaScript", async () => {
    for (const path of ["/", "/about", "/contact", "/privacy"]) {
        const response = await request(path);
        assert.equal(response.status, 200);
        const doc = parse(await response.text());
        doc.querySelectorAll("script, style, [hidden], [aria-hidden=true]").forEach(el => el.remove());
        const paragraphs = doc.querySelectorAll("main p").map(el => el.text.replace(/\s+/g, " ").trim()).join(" ");
        assert.ok(paragraphs.length >= 500, `${path}: ${paragraphs.length} characters`);
    }
});

test("negotiated Markdown matches each direct copy", async () => {
    for (const page of pages) {
        const response = await request(page.path, "text/markdown");
        assert.equal(response.status, 200, page.path);
        assert.equal(mediaType(response), "text/markdown");
        vary(response);
        const body = await response.text();
        assert.equal(body, content(markdownPath(page.path).slice(1)).toString());
        const direct = await request(markdownPath(page.path));
        assert.equal(direct.status, 200);
        assert.equal(mediaType(direct), "text/markdown");
        assert.ok(direct.headers.get("link")?.includes('rel="canonical"'));
        assert.equal(await direct.text(), body);
    }
});

test("real Markdown 404s for missing pages and files", async () => {
    for (const path of ["/__ora-404-probe-1kjbbxuq", "/__ora-missing/child", "/__ora-missing/",
        "/__ora-missing.html", "/__ora-missing.md", "/__ora-missing.txt", "/assets/__ora-missing.jpg",
        "/v1.2/__ora-missing", "/cig/0", "/cig/9997"]) {
        const response = await request(path, "text/markdown");
        assert.equal(response.status, 404, path);
        assert.equal(mediaType(response), "text/markdown", path);
        vary(response);
        assert.equal(response.headers.get("x-robots-tag"), "noindex");
        const body = await response.text();
        assert.ok(body.startsWith("# Page not found\n"));
        assert.ok(body.length >= 20 && !body.includes("<html"));
        assert.match(body, /\[.+?\]\(https:\/\/alexkan\.xyz\/(llms\.txt|sitemap\.xml)\)/);
        const html = await request(path, "text/html");
        assert.equal(html.status, 404);
        assert.equal(mediaType(html), "text/html");
        vary(html);
        assert.ok((await html.text()).includes("Not found"));
    }
});

test("HEAD returns the correct status and type with no body", async () => {
    for (const path of [...pages.map(page => page.path), "/__ora-missing", "/__ora-missing.md"]) {
        for (const accept of ["text/html", "text/markdown"]) {
            const response = await request(path, accept, "HEAD");
            assert.equal(response.status, path.includes("missing") ? 404 : 200, path);
            assert.equal(mediaType(response), accept);
            vary(response);
            assert.equal(await response.text(), "");
        }
    }
});

test("Accept preferences distinguish HTML and Markdown", async () => {
    for (const path of ["/", "/__ora-missing", "/__ora-missing.md"]) {
        for (const [accept, type] of [["text/html, text/markdown;q=0.5", "text/html"],
            ["text/markdown;q=0", "text/html"], ["text/html;q=0.5, text/markdown", "text/markdown"], ["*/*", "text/html"]]) {
            const response = await request(path, accept);
            assert.equal(response.status, path === "/" ? 200 : 404);
            assert.equal(mediaType(response), type);
            await response.arrayBuffer();
        }
    }
});

test("Markdown conditional requests preserve 304 and Vary", async () => {
    const response = await request("/about", "text/markdown");
    assert.equal(response.status, 200);
    const etag = response.headers.get("etag");
    assert.ok(etag);
    await response.arrayBuffer();
    const cached = await request("/about", "text/markdown", "GET", { "If-None-Match": etag });
    assert.equal(cached.status, 304);
    vary(cached);
    assert.equal(await cached.text(), "");
});

test("every static file remains available with unchanged content", async () => {
    let count = 0;
    for (const file of files.filter(file => !file.endsWith(".html") && !["_headers", "_redirects"].includes(file))) {
        const response = await request("/" + file);
        assert.equal(response.status, 200, file);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), content(file), file);
        if (file.endsWith(".md")) assert.equal(mediaType(response), "text/markdown", file);
        count++;
    }
    console.log(`Verified ${pages.length} pages and ${count} static files over HTTP`);
});

test("machine-readable indexes and all llms.txt links resolve", async () => {
    for (const [path, type] of [["/llms.txt", "text/plain"], ["/llms-full.txt", "text/plain"],
        ["/robots.txt", "text/plain"], ["/sitemap.xml", "application/xml"], ["/agent-instructions.md", "text/markdown"]]) {
        const response = await request(path);
        assert.equal(response.status, 200);
        assert.equal(mediaType(response), type);
        assert.ok((await response.text()).length > 20);
    }
    const llms = await (await request("/llms.txt")).text();
    assert.ok(llms.includes("## When to use this"));
    for (const match of llms.matchAll(/\]\((https:\/\/alexkan\.xyz\/[^)]+)\)/g)) {
        const response = await request(new URL(match[1]).pathname);
        assert.equal(response.status, 200, match[1]);
        await response.arrayBuffer();
    }
    const sitemap = await (await request("/sitemap.xml")).text();
    for (const page of pages) assert.ok(sitemap.includes(`<loc>${page.url}</loc>`));
    assert.ok((await (await request("/robots.txt")).text()).includes("Sitemap: https://alexkan.xyz/sitemap.xml"));
});

test("legacy writing redirects are preserved", async () => {
    for (const [from, to] of [["/ideology", "/writing/gm"], ["/ideology.md", "/writing/gm.md"]]) {
        const response = await request(from);
        assert.equal(response.status, 200);
        assert.equal(new URL(response.url).pathname, to);
        await response.arrayBuffer();
    }
});

test("the random image endpoint preserves its URL contract", async () => {
    const response = await request("/image");
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /^\/cig\/\d+$/);
    assert.ok(Number(body.slice(5)) >= 1 && Number(body.slice(5)) <= 9996);
});

test("R2 image serving remains unchanged", { skip: !cigId }, async () => {
    const response = await request(`/cig/${cigId}`, "text/markdown");
    assert.equal(response.status, 200);
    assert.equal(mediaType(response), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400, s-maxage=31536000");
    assert.ok(Buffer.from(await response.arrayBuffer()).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
});
