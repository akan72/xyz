// The site's machine-readable files, generated from the built HTML pages:
//
//     sitemap.xml    every page with the date of its last git commit
//     llms.txt       an index of the site for LLMs (https://llmstxt.org)
//     llms-full.txt  the Markdown of every page in one file
//     <page>.md      a Markdown copy of each page: /ideology -> /ideology.md,
//                    / -> /index.md. The Worker also serves these to requests
//                    sent with `Accept: text/markdown`.
//     _headers       points each Markdown copy's canonical URL at its page
//
// Every page needs a <title> and a <meta name="description">; the build fails
// without them. Pages marked <meta name="robots" content="noindex"> are left
// out. Pure functions only: site/integrations/agent-files.ts does the I/O.

import { Parser } from "htmlparser2";

export const SITE_URL = "https://alexkan.xyz";
export const SITE_NAME = "alexkan.xyz";

// Written to the root of dist/; public/ must not contain files with these names
export const GENERATED = ["llms.txt", "llms-full.txt", "sitemap.xml"];

export class SiteError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(problems.join("\n"));
        this.problems = problems;
    }
}

// --- URLs -------------------------------------------------------------------

/**
 * URL path Workers Static Assets serves an HTML file at.
 *
 * Matches the default html_handling ("auto-trailing-slash"), which
 * redirects /about.html to /about and /notes/index.html to /notes/.
 */
export function pagePath(source: string): string {
    if (source === "index.html" || source.endsWith("/index.html")) {
        const parent = source.slice(0, -"index.html".length).replace(/\/$/, "");
        return parent ? `/${parent}/` : "/";
    }
    return "/" + source.replace(/\.html$/, "");
}

/** Path of a page's Markdown copy. Keep in sync with markdown_path in src/lib.rs. */
export function markdownPath(path: string): string {
    return path.endsWith("/") ? `${path}index.md` : `${path}.md`;
}

// --- HTML parsing -----------------------------------------------------------

export class Element {
    readonly tag: string;
    readonly attrs: Record<string, string>;
    readonly children: (Element | string)[] = [];

    constructor(tag: string, attrs: Record<string, string>) {
        this.tag = tag;
        this.attrs = attrs;
    }

    *iter(): Generator<Element> {
        for (const child of this.children) {
            if (child instanceof Element) {
                yield child;
                yield* child.iter();
            }
        }
    }

    find(tag: string): Element | undefined {
        for (const el of this.iter()) if (el.tag === tag) return el;
        return undefined;
    }

    text(): string {
        return this.children.map((c) => (typeof c === "string" ? c : c.text())).join("");
    }
}

// Opening one of these closes an unclosed sibling (hand-written HTML often skips </li> and </p>)
const IMPLIED_END: Record<string, string[]> = {
    li: ["li"], p: ["p"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"],
};
// ...searching up to the enclosing list or table (a <p> only closes a <p> directly above it)
const IMPLIED_SCOPE: Record<string, string[]> = {
    li: ["ul", "ol"], dt: ["dl"], dd: ["dl"], tr: ["table", "thead", "tbody", "tfoot"], td: ["tr", "table"], th: ["tr", "table"],
};

export function parseHtml(text: string): Element {
    const root = new Element("#document", {});
    const stack = [root];
    const parser = new Parser(
        {
            onopentag(name, attribs) {
                const closes = IMPLIED_END[name] ?? [];
                const scope = IMPLIED_SCOPE[name];
                for (let i = stack.length - 1; i > 0; i--) {
                    if (closes.includes(stack[i].tag)) {
                        stack.length = i;
                        break;
                    }
                    if (!scope || scope.includes(stack[i].tag)) break;
                }
                const el = new Element(name, { ...attribs });
                stack.at(-1)!.children.push(el);
                stack.push(el);
            },
            // Also called for end tags htmlparser2 implies, e.g. right after a void element
            onclosetag(name) {
                for (let i = stack.length - 1; i > 0; i--) {
                    if (stack[i].tag === name) {
                        stack.length = i;
                        return;
                    }
                }
            },
            ontext(data) {
                stack.at(-1)!.children.push(data);
            },
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
    parser.write(text);
    parser.end();
    return root;
}

const collapse = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

export function metaContent(doc: Element, name: string): string {
    for (const el of doc.iter()) {
        if (el.tag === "meta" && (el.attrs.name ?? "").toLowerCase() === name) return collapse(el.attrs.content ?? "");
    }
    return "";
}

export function linkHref(doc: Element, rel: string, type?: string): string | undefined {
    for (const el of doc.iter()) {
        if (el.tag !== "link" || !(el.attrs.rel ?? "").toLowerCase().split(/\s+/).includes(rel)) continue;
        if (type === undefined || (el.attrs.type ?? "").toLowerCase() === type) return el.attrs.href ?? "";
    }
    return undefined;
}

// --- HTML to Markdown -------------------------------------------------------

// Navigation, controls and non-content elements that don't belong in the Markdown
const SKIP_TAGS = new Set([
    "button", "canvas", "dialog", "form", "head", "iframe", "input", "nav",
    "noscript", "script", "select", "style", "svg", "template", "textarea",
    "title",
]);
const BLOCK_TAGS = new Set([
    "#document", "address", "article", "aside", "blockquote", "body", "dd",
    "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main",
    "ol", "p", "pre", "section", "summary", "table", "ul",
]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const LINE_BREAK = "\x00"; // marks <br> until whitespace is collapsed

function cleanInline(text: string): string {
    return text.replace(/\s+/g, " ").replace(new RegExp(` ?${LINE_BREAK} ?`, "g"), "\n").trim();
}

/** Surround text with an inline marker, keeping edge whitespace outside it. */
function wrap(text: string, marker: string): string {
    const core = text.trim();
    if (!core) return text;
    const start = text.indexOf(core[0]);
    return `${text.slice(0, start)}${marker}${core}${marker}${text.slice(start + core.length)}`;
}

const normalize = (text: string) => collapse(text).toLowerCase();

// Characters left unescaped in URLs (what sitegen.py's urllib.parse.quote kept)
const URL_SAFE = /[A-Za-z0-9_.\-~:/?#[\]@!$&'*+,;=%]/;

function quoteUrl(url: string): string {
    let out = "";
    for (const char of url) {
        out += URL_SAFE.test(char)
            ? char
            : Array.from(new TextEncoder().encode(char), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    }
    return out;
}

class MarkdownRenderer {
    readonly baseUrl: string;
    readonly pageUrls: Map<string, string>; // "/contact.html" -> canonical page URL
    readonly drop?: Element; // heading element that repeats the page title
    readonly headingShift: number;

    constructor(baseUrl: string, pageUrls: Map<string, string>, drop?: Element, headingShift = 0) {
        this.baseUrl = baseUrl;
        this.pageUrls = pageUrls;
        this.drop = drop;
        this.headingShift = headingShift;
    }

    skipped(el: Element): boolean {
        return el === this.drop || SKIP_TAGS.has(el.tag) || "hidden" in el.attrs || el.attrs["aria-hidden"] === "true";
    }

    /** Absolute URL for href, with links to .html files rewritten to their page URL. */
    url(href: string): string {
        href = href.trim();
        // Absolute URLs pass through as written (no added trailing slash)
        let url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : new URL(href, this.baseUrl).href;
        const match = url.match(/^(https?:\/\/[^/?#]+)([^?#]*)(.*)$/s);
        if (match && match[1] === SITE_URL && this.pageUrls.has(match[2])) {
            url = this.pageUrls.get(match[2]) + match[3];
        }
        return quoteUrl(url);
    }

    blocks(nodes: (Element | string)[]): string[] {
        const out: string[] = [];
        let inline: string[] = [];
        const flush = () => {
            const text = cleanInline(inline.join(""));
            inline = [];
            if (text) out.push(text);
        };
        for (const node of nodes) {
            if (typeof node === "string") inline.push(node);
            else if (this.skipped(node)) continue;
            else if (BLOCK_TAGS.has(node.tag)) {
                flush();
                out.push(...this.block(node));
            } else inline.push(this.inline(node));
        }
        flush();
        return out;
    }

    block(el: Element): string[] {
        if (el.tag in HEADINGS) {
            const text = cleanInline(this.inlineChildren(el)).replaceAll("\n", " ");
            const level = Math.min(6, HEADINGS[el.tag] + this.headingShift);
            return text ? [`${"#".repeat(level)} ${text}`] : [];
        }
        if (el.tag === "ul" || el.tag === "ol") {
            const md = this.list(el);
            return md ? [md] : [];
        }
        if (el.tag === "blockquote") {
            const inner = this.blocks(el.children).join("\n\n");
            return inner ? [inner.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")] : [];
        }
        if (el.tag === "pre") {
            const code = el.text().replace(/^\n+|\n+$/g, "");
            let fence = "```";
            while (code.includes(fence)) fence += "`";
            return code.trim() ? [`${fence}\n${code}\n${fence}`] : [];
        }
        if (el.tag === "hr") return ["---"];
        if (el.tag === "table") {
            const md = this.table(el);
            return md ? [md] : [];
        }
        return this.blocks(el.children);
    }

    list(el: Element): string {
        const ordered = el.tag === "ol";
        let number = ordered && /^\d+$/.test(el.attrs.start ?? "") ? Number(el.attrs.start) : 1;
        const items: string[] = [];
        for (const li of el.children) {
            if (!(li instanceof Element) || li.tag !== "li" || this.skipped(li)) continue;
            const marker = ordered ? `${number}.` : "-";
            number++;
            const body = this.blocks(li.children).join("\n");
            if (body) items.push(`${marker} ` + body.replaceAll("\n", "\n" + " ".repeat(marker.length + 1)));
        }
        return items.join("\n");
    }

    table(el: Element): string {
        const rows: string[][] = [];
        for (const tr of el.iter()) {
            if (tr.tag !== "tr") continue;
            const cells = tr.children
                .filter((c): c is Element => c instanceof Element && (c.tag === "td" || c.tag === "th"))
                .map((c) => cleanInline(this.inlineChildren(c)).replaceAll("\n", " ").replaceAll("|", "\\|"));
            if (cells.length) rows.push(cells);
        }
        if (!rows.length) return "";
        const width = Math.max(...rows.map((r) => r.length));
        const padded = rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
        const lines = ["| " + padded[0].join(" | ") + " |", "|" + " --- |".repeat(width)];
        return [...lines, ...padded.slice(1).map((r) => "| " + r.join(" | ") + " |")].join("\n");
    }

    inline(el: Element): string {
        if (this.skipped(el)) return "";
        if (el.tag === "br") return LINE_BREAK;
        if (el.tag === "img") {
            const alt = cleanInline(el.attrs.alt ?? "");
            const src = el.attrs.src ?? "";
            // Images without alt text are decorative
            return alt && src ? `![${alt}](${this.url(src)})` : "";
        }
        const inner = this.inlineChildren(el);
        if (el.tag === "a") {
            const href = el.attrs.href ?? "";
            const text = cleanInline(inner);
            return href && text ? `[${text}](${this.url(href)})` : inner;
        }
        if (el.tag === "strong" || el.tag === "b") return wrap(inner, "**");
        if (el.tag === "em" || el.tag === "i") return wrap(inner, "*");
        if (el.tag === "code") return wrap(inner, "`");
        if (BLOCK_TAGS.has(el.tag)) return ` ${inner} `;
        return inner;
    }

    inlineChildren(el: Element): string {
        return el.children.map((c) => (typeof c === "string" ? c : this.inline(c))).join("");
    }
}

function* visible(el: Element, renderer: MarkdownRenderer): Generator<Element> {
    for (const child of el.children) {
        if (child instanceof Element && !renderer.skipped(child)) {
            yield child;
            yield* visible(child, renderer);
        }
    }
}

/**
 * Markdown for a page's content: its <main>, or <body> if it has none.
 *
 * Drops a leading heading that repeats the title (the title is rendered
 * separately as the H1) and shifts headings so the top level is H2.
 */
export function toMarkdown(doc: Element, title: string, baseUrl: string, pageUrls: Map<string, string>): string {
    const content = doc.find("main") ?? doc.find("body") ?? doc;
    const probe = new MarkdownRenderer(baseUrl, pageUrls);
    const headings = [...visible(content, probe)].filter((el) => el.tag in HEADINGS);
    const drop = headings.length && normalize(headings[0].text()) === normalize(title) ? headings[0] : undefined;
    const levels = headings.filter((h) => h !== drop).map((h) => HEADINGS[h.tag]);
    const shift = levels.length ? 2 - Math.min(...levels) : 0;
    return new MarkdownRenderer(baseUrl, pageUrls, drop, shift).blocks(content.children).join("\n\n");
}

// --- Pages ------------------------------------------------------------------

export interface Page {
    source: string; // HTML file, relative to dist/
    path: string;
    title: string;
    description: string;
    body: string; // Markdown of the page content, without the title
    lastmod?: Date;
}

export const pageUrl = (page: Page) => SITE_URL + page.path;
const section = (page: Page) => (page.source.includes("/") ? page.source.split("/")[0] : "");

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
// Same format as Python's datetime.isoformat() for a UTC time
const isoTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** The page as Markdown. indexLink points readers of a lone copy at llms.txt. */
export function pageMarkdown(page: Page, indexLink = true): string {
    const updated = page.lastmod ? ` (last updated ${isoDate(page.lastmod)})` : "";
    let head = `# ${page.title}\n\n> ${page.description}\n\nSource: ${pageUrl(page)}${updated}`;
    if (indexLink) head += `\nAll pages: ${SITE_URL}/llms.txt`;
    return page.body ? `${head}\n\n${page.body}` : head;
}

function pageTitle(raw: string): string {
    const title = collapse(raw);
    for (const sep of [" | ", " - ", " – ", " — ", " · "]) {
        if (title.endsWith(sep + SITE_NAME)) return title.slice(0, -(sep + SITE_NAME).length).trim();
    }
    return title;
}

/** Sort comparator over a tuple of string keys. */
const byKey =
    <T>(key: (item: T) => string[]) =>
    (a: T, b: T) => {
        const [ka, kb] = [key(a), key(b)];
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        return 0;
    };

export interface SiteInput {
    html: Map<string, string>; // built HTML files, relative to dist/ -> contents
    lastmods: Map<string, Date>; // same keys -> last-modified time
    publicFiles: Set<string>; // files in public/, relative to it
}

/** Parse every indexable page, homepage first. Throws SiteError listing every problem. */
export function loadPages({ html, lastmods, publicFiles }: SiteInput): Page[] {
    const docs = new Map<string, Element>();
    for (const source of [...html.keys()].sort()) {
        const doc = parseHtml(html.get(source)!);
        if (!metaContent(doc, "robots").toLowerCase().replaceAll(",", " ").split(/\s+/).includes("noindex")) {
            docs.set(source, doc);
        }
    }

    const pageUrls = new Map([...docs.keys()].map((source) => [`/${source}`, SITE_URL + pagePath(source)]));
    const pages: Page[] = [];
    const problems: string[] = [];
    for (const [source, doc] of docs) {
        const path = pagePath(source);
        const titleEl = doc.find("title");
        const title = titleEl ? pageTitle(titleEl.text()) : "";
        const description = metaContent(doc, "description");
        const canonical = linkHref(doc, "canonical");
        if (!title) problems.push(`${source}: add a <title>`);
        if (!description) problems.push(`${source}: add <meta name="description" content="..."> (used in llms.txt)`);
        if (path.includes(".")) problems.push(`${source}: rename it; page URLs can't contain '.' (the Worker treats those as files)`);
        if (canonical !== undefined && canonical !== SITE_URL + path) {
            problems.push(`${source}: canonical URL '${canonical}' should be '${SITE_URL + path}'`);
        }
        if (publicFiles.has(markdownPath(path).slice(1))) {
            problems.push(`public${markdownPath(path)}: conflicts with the generated Markdown copy of ${source}`);
        }
        const body = toMarkdown(doc, title, SITE_URL + path, pageUrls);
        pages.push({ source, path, title, description, body, lastmod: lastmods.get(source) });
    }

    for (const name of GENERATED) {
        if (publicFiles.has(name)) problems.push(`public/${name}: remove it; the Astro build generates this file`);
    }
    if (!pages.some((p) => p.path === "/")) problems.push("index.html: missing (the homepage describes the site in llms.txt)");
    if (problems.length) throw new SiteError(problems);
    return pages.sort(byKey((p) => [p.path === "/" ? "0" : "1", section(p), p.path]));
}

// --- Generated files --------------------------------------------------------

/** Pages grouped by top-level directory; pages at the root come first. */
function sections(pages: Page[]): [string, Page[]][] {
    const groups = new Map<string, Page[]>();
    for (const page of pages) groups.set(section(page), [...(groups.get(section(page)) ?? []), page]);
    return [...groups].sort(byKey(([name]) => [name === "" ? "0" : "1", name]));
}

const escapeBrackets = (text: string) => text.replace(/([[\]])/g, "\\$1");

function sectionTitle(name: string, fallback: string): string {
    if (!name) return fallback;
    return name.replace(/[-_]/g, " ").replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

export function renderLlmsTxt(pages: Page[]): string {
    const lines = [
        `# ${SITE_NAME}`,
        "",
        `> ${pages[0].description}`,
        "",
        "Each link below is a Markdown copy of a page. Any page is also available as Markdown" +
            " by adding `.md` to its path (`/index.md` for the homepage) or by requesting it with" +
            " an `Accept: text/markdown` header.",
    ];
    for (const [name, sectionPages] of sections(pages)) {
        lines.push("", `## ${sectionTitle(name, "Pages")}`, "");
        lines.push(...sectionPages.map((p) => `- [${escapeBrackets(p.title)}](${SITE_URL}${markdownPath(p.path)}): ${p.description}`));
    }
    lines.push(
        "",
        "## Optional",
        "",
        `- [Full text](${SITE_URL}/llms-full.txt): every page above in one Markdown file`,
        `- [Sitemap](${SITE_URL}/sitemap.xml): every page with its last-modified date`,
    );
    return lines.join("\n") + "\n";
}

export function renderLlmsFullTxt(pages: Page[]): string {
    const intro =
        `# ${SITE_NAME}\n\n> ${pages[0].description}\n\n` + `The full text of every page on ${SITE_NAME}. Index: ${SITE_URL}/llms.txt`;
    return [intro, ...pages.map((page) => pageMarkdown(page, false))].join("\n\n---\n\n") + "\n";
}

const xmlEscape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderSitemapXml(pages: Page[]): string {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
    for (const page of pages) {
        lines.push("  <url>", `    <loc>${xmlEscape(pageUrl(page))}</loc>`);
        if (page.lastmod) lines.push(`    <lastmod>${isoTime(page.lastmod)}</lastmod>`);
        lines.push("  </url>");
    }
    return [...lines, "</urlset>"].join("\n") + "\n";
}

export function renderHeaders(pages: Page[], existing = ""): string {
    const rules = pages
        .map((p) => `${markdownPath(p.path)}\n  Link: <${pageUrl(p)}>; rel="canonical", </llms.txt>; rel="describedby"`)
        .join("\n");
    const generated = `# Added by the Astro build: Markdown copies point at their page and llms.txt\n${rules}\n`;
    return existing.trim() ? `${existing.trimEnd()}\n\n${generated}` : generated;
}

/** Every generated file, keyed by its path relative to dist/. */
export function agentFiles(pages: Page[], existingHeaders = ""): Map<string, string> {
    const files = new Map([
        ["llms.txt", renderLlmsTxt(pages)],
        ["llms-full.txt", renderLlmsFullTxt(pages)],
        ["sitemap.xml", renderSitemapXml(pages)],
        ["_headers", renderHeaders(pages, existingHeaders)],
    ]);
    for (const page of pages) files.set(markdownPath(page.path).slice(1), pageMarkdown(page) + "\n");
    return files;
}
