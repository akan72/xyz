// Writes the files in site/lib/agent-files.ts into dist/ once Astro has built
// the pages, and fails the build if a page breaks one of its rules.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration, AstroIntegrationLogger } from "astro";
import { SiteError, agentFiles, loadPages, metaContent, pagePath, parseHtml } from "../lib/agent-files.ts";

interface Options {
    // Besides its page file, what each page's sitemap date follows, e.g. the
    // content collection a page renders: { "/projects": ["site/content/projects"] }
    sources?: Record<string, string[]>;
}

function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
}

/** Last commit time of each page's sources, keyed by its HTML file. */
function gitLastmods(root: string, sourcesByFile: Map<string, string[]>, logger: AstroIntegrationLogger): Map<string, Date> {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const lastmods = new Map<string, Date>();
    let shallow: string;
    try {
        shallow = git("rev-parse", "--is-shallow-repository");
    } catch {
        logger.warn("not a git checkout; leaving out last-modified dates");
        return lastmods;
    }
    if (shallow === "true") {
        throw new SiteError(["shallow git clone: last-modified dates would be wrong; fetch full history (actions/checkout `fetch-depth: 0`)"]);
    }
    for (const [file, sources] of sourcesByFile) {
        const timestamp = git("log", "-1", "--format=%ct", "--", ...sources);
        if (timestamp) lastmods.set(file, new Date(Number(timestamp) * 1000));
        else logger.warn(`${sources[0]} isn't committed; leaving out its last-modified date`);
    }
    return lastmods;
}

export default function agentFilesIntegration({ sources = {} }: Options = {}): AstroIntegration {
    let root = "";
    let publicDir = "";
    const entrypoints = new Map<string, string>(); // page path -> its file in site/pages/

    return {
        name: "agent-files",
        hooks: {
            "astro:config:done": ({ config }) => {
                root = fileURLToPath(config.root);
                publicDir = fileURLToPath(config.publicDir);
            },
            "astro:routes:resolved": ({ routes }) => {
                for (const route of routes) {
                    if (route.type === "page" && route.pathname) entrypoints.set(route.pathname, route.entrypoint);
                }
            },
            "astro:build:done": ({ dir, logger }) => {
                const dist = fileURLToPath(dir);
                const htmlFiles = filesUnder(dist).filter((file) => file.endsWith(".html"));
                const html = new Map(htmlFiles.map((file) => [file, readFileSync(join(dist, file), "utf8")]));
                const sourcesByFile = new Map<string, string[]>();
                for (const file of htmlFiles) {
                    if (metaContent(parseHtml(html.get(file)!), "robots").includes("noindex")) continue;
                    const path = pagePath(file).replace(/(.)\/$/, "$1");
                    const entrypoint = entrypoints.get(path);
                    if (entrypoint) sourcesByFile.set(file, [entrypoint, ...(sources[path] ?? [])]);
                }
                try {
                    const pages = loadPages({
                        html,
                        lastmods: gitLastmods(root, sourcesByFile, logger),
                        publicFiles: new Set(filesUnder(publicDir)),
                    });
                    const headersFile = join(dist, "_headers");
                    const existing = existsSync(headersFile) ? readFileSync(headersFile, "utf8") : "";
                    for (const [name, text] of agentFiles(pages, existing)) writeFileSync(join(dist, name), text);
                    logger.info(`${pages.length} pages -> llms.txt, llms-full.txt, sitemap.xml, _headers, Markdown copies`);
                } catch (err) {
                    if (!(err instanceof SiteError)) throw err;
                    for (const problem of err.problems) logger.error(problem);
                    throw new Error(`${err.problems.length} problem(s) with the site's pages; see above`);
                }
            },
        },
    };
}
