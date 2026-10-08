// After `astro build`, writes the files AI agents and crawlers read, made from
// the pages Astro just built:
//
//   /projects.md, /index.md  a Markdown copy of each page. src/lib.rs serves
//                            these to requests with `Accept: text/markdown`.
//   /llms.txt                an index of the pages (https://llmstxt.org)
//   /llms-full.txt           every page's Markdown in one file
//   /sitemap.xml             every page, dated by its last git commit
//   /_headers                points each Markdown copy at its page
//
// Pages marked <meta name="robots" content="noindex"> (the 404 page) are left
// out. The build fails if a page has no title or description.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { parse } from "node-html-parser";
import TurndownService from "turndown";

const SITE_NAME = "alexkan.xyz";

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });

export interface Page {
    path: string; // "/" or "/projects"
    url: string;
    title: string; // without " | alexkan.xyz"
    description: string;
    body: string; // the page's <main> as Markdown
    lastmod?: Date;
}

/** Where a page's Markdown copy lives. Keep in sync with markdown_path in src/lib.rs. */
export const markdownPath = (path: string) => (path.endsWith("/") ? `${path}index.md` : `${path}.md`);

/** Reads a built page, or returns undefined for a noindex page. Throws if it's missing its title or description. */
export function readPage(html: string, path: string, site: URL): Page | undefined {
    const doc = parse(html);
    const meta = (name: string) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
    if (meta("robots").includes("noindex")) return undefined;

    const title = (doc.querySelector("title")?.text.trim() ?? "").replace(` | ${SITE_NAME}`, "");
    const description = meta("description");
    if (!title || !description) throw new Error(`${path}: every page needs a <title> and a <meta name="description">`);
    if (path.includes(".")) throw new Error(`${path}: page URLs can't contain a dot (the Worker treats those as files)`);

    const url = new URL(path, site).href;
    const main = doc.querySelector("main") ?? doc.querySelector("body")!;
    // Leave out controls, the live figure, and anything hidden
    main.querySelectorAll('script, style, button, canvas, [hidden], [aria-hidden="true"]').forEach((el) => el.remove());
    // The title is the copy's H1, so drop a heading that repeats it
    const heading = main.querySelector("h1, h2");
    if (heading?.text.trim().toLowerCase() === title.toLowerCase()) heading.remove();
    // Make relative links and images absolute, so the Markdown works on its own
    for (const el of main.querySelectorAll("a[href], img[src]")) {
        const attr = el.tagName === "A" ? "href" : "src";
        const value = el.getAttribute(attr)!;
        if (!/^[a-z]+:/i.test(value)) el.setAttribute(attr, new URL(value, url).href);
    }
    const body = turndown.turndown(main.innerHTML).replace(/[ \t]+$/gm, "");
    return { path, url, title, description, body };
}

/** The page as a standalone Markdown file; llms-full.txt leaves out the "All pages" line. */
export function pageMarkdown(page: Page, site: URL, standalone = true): string {
    const updated = page.lastmod ? ` (last updated ${page.lastmod.toISOString().slice(0, 10)})` : "";
    const lines = [`# ${page.title}`, "", `> ${page.description}`, "", `Source: ${page.url}${updated}`];
    if (standalone) lines.push(`All pages: ${new URL("/llms.txt", site)}`);
    return [lines.join("\n"), page.body].filter(Boolean).join("\n\n") + "\n";
}

/** Pages grouped for llms.txt: top-level pages first, then one group per directory (/writing/... -> "Writing"). */
function sections(pages: Page[]): [string, Page[]][] {
    const groups = new Map<string, Page[]>([["Pages", []]]);
    for (const page of pages) {
        const dir = page.path.split("/").length > 2 ? page.path.split("/")[1] : "";
        const name = dir ? dir[0].toUpperCase() + dir.slice(1) : "Pages";
        groups.set(name, [...(groups.get(name) ?? []), page]);
    }
    return [...groups].filter(([, group]) => group.length);
}

export function llmsTxt(pages: Page[], site: URL): string {
    const link = (path: string) => new URL(path, site).href;
    return [
        `# ${SITE_NAME}`,
        "",
        `> ${pages[0].description}`,
        "",
        "Each link below is a Markdown copy of a page. Any page is also available as Markdown by adding `.md` to its path " +
            "(`/index.md` for the homepage) or by requesting it with an `Accept: text/markdown` header.",
        ...sections(pages).flatMap(([name, group]) => [
            "",
            `## ${name}`,
            "",
            ...group.map((p) => `- [${p.title}](${link(markdownPath(p.path))}): ${p.description}`),
        ]),
        "",
        "## Optional",
        "",
        `- [Full text](${link("/llms-full.txt")}): every page above in one Markdown file`,
        `- [Sitemap](${link("/sitemap.xml")}): every page with its last-modified date`,
        "",
    ].join("\n");
}

export function llmsFullTxt(pages: Page[], site: URL): string {
    const intro = `# ${SITE_NAME}\n\n> ${pages[0].description}\n\nThe full text of every page on ${SITE_NAME}. Index: ${new URL("/llms.txt", site)}\n`;
    return [intro, ...pages.map((p) => pageMarkdown(p, site, false))].join("\n---\n\n");
}

export function sitemapXml(pages: Page[]): string {
    const urls = pages.map((p) => {
        const lastmod = p.lastmod ? `\n    <lastmod>${p.lastmod.toISOString().replace(/\.\d+Z$/, "+00:00")}</lastmod>` : "";
        return `  <url>\n    <loc>${p.url}</loc>${lastmod}\n  </url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function headers(pages: Page[]): string {
    const rules = pages.map((p) => `${markdownPath(p.path)}\n  Link: <${p.url}>; rel="canonical", </llms.txt>; rel="describedby"`);
    return `# Added by the Astro build: Markdown copies point at their page and llms.txt\n${rules.join("\n")}\n`;
}

/** Time of the last commit that touched any of these files or directories. */
function lastCommit(root: string, files: string[]): Date | undefined {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    if (git("rev-parse", "--is-shallow-repository") === "true") {
        throw new Error("shallow git clone: sitemap dates would be wrong; fetch full history (actions/checkout `fetch-depth: 0`)");
    }
    const timestamp = git("log", "-1", "--format=%ct", "--", ...files);
    return timestamp ? new Date(Number(timestamp) * 1000) : undefined;
}

interface Options {
    // Files besides its .astro file that a page's sitemap date follows, such
    // as the content it renders. Pages built from a dynamic route like
    // writing/[slug].astro have no single .astro file, so list their source here.
    sources?: (path: string) => string[];
}

export default function agentFiles({ sources = () => [] }: Options = {}): AstroIntegration {
    let root = "";
    let site = new URL("https://example.com");
    const pageFiles = new Map<string, string>(); // "/projects" -> "site/pages/projects.astro"

    return {
        name: "agent-files",
        hooks: {
            "astro:config:done": ({ config }) => {
                root = fileURLToPath(config.root);
                site = new URL(config.site!);
            },
            "astro:routes:resolved": ({ routes }) => {
                for (const route of routes) if (route.type === "page" && route.pathname) pageFiles.set(route.pathname, route.entrypoint);
            },
            "astro:build:done": ({ dir, logger }) => {
                const dist = fileURLToPath(dir);
                const pages: Page[] = [];
                for (const file of readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".html"))) {
                    const path = "/" + file.replace(/(index)?\.html$/, "");
                    const page = readPage(readFileSync(join(dist, file), "utf8"), path, site);
                    if (!page) continue;
                    const files = [pageFiles.get(path), ...sources(path)].filter((f): f is string => !!f);
                    page.lastmod = files.length ? lastCommit(root, files) : undefined;
                    if (!page.lastmod) logger.warn(`${path} has no committed source yet, so it gets no sitemap date`);
                    pages.push(page);
                }
                // The homepage first: llms.txt describes the site with its description
                pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
                if (pages[0]?.path !== "/") throw new Error("the homepage (site/pages/index.astro) is missing");

                for (const page of pages) writeFileSync(join(dist, markdownPath(page.path)), pageMarkdown(page, site));
                writeFileSync(join(dist, "llms.txt"), llmsTxt(pages, site));
                writeFileSync(join(dist, "llms-full.txt"), llmsFullTxt(pages, site));
                writeFileSync(join(dist, "sitemap.xml"), sitemapXml(pages));
                // Appends to a public/_headers if there is one
                const headersFile = join(dist, "_headers");
                (existsSync(headersFile) ? appendFileSync : writeFileSync)(headersFile, headers(pages));
                logger.info(`${pages.length} pages -> Markdown copies, llms.txt, llms-full.txt, sitemap.xml, _headers`);
            },
        },
    };
}
