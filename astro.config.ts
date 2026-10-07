import { satteri } from "@astrojs/markdown-satteri";
import { defineConfig } from "astro/config";
import { defineHastPlugin } from "satteri";
import agentFiles from "./site/integrations/agent-files.ts";

// Links in Markdown (project descriptions) to other sites open in a new tab,
// like every other outside link on the site
const externalLinksInNewTab = defineHastPlugin({
    name: "external-links-in-new-tab",
    element: {
        filter: ["a"],
        visit(node, ctx) {
            if (/^https?:\/\//.test(String(node.properties.href))) ctx.setProperty(node, "target", "_blank");
        },
    },
});

// `src/` belongs to the Rust Worker, so Astro's sources live in `site/`.
// public/ (images, robots.txt, the projects figure's script) is copied into
// dist/ unchanged, and dist/ is what Workers Static Assets serves.
export default defineConfig({
    site: "https://alexkan.xyz",
    srcDir: "./site",
    publicDir: "./public",
    outDir: "./dist",
    build: {
        // site/pages/ideology.astro -> dist/ideology.html, served at /ideology
        format: "file",
        // Put each page's CSS in a <style> in its <head>: one fewer request
        // per page, and page-navigation.js swaps those when it changes pages
        inlineStylesheets: "always",
    },
    // Page-only development uses the deployed Worker for the random-cig images.
    vite: {
        server: {
            proxy: {
                "/image": { target: "https://alexkan.xyz", changeOrigin: true },
                "/cig/": { target: "https://alexkan.xyz", changeOrigin: true },
            },
        },
    },
    markdown: { processor: satteri({ hastPlugins: [externalLinksInNewTab] }) },
    integrations: [agentFiles({ sources: { "/projects": ["site/content/projects"] } })],
});
