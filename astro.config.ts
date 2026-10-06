import { defineConfig } from "astro/config";
import agentFiles from "./site/integrations/agent-files.ts";

// `src/` belongs to the Rust Worker, so Astro's sources live in `site/`.
// public/ (images, scripts, robots.txt) is copied into dist/ unchanged, and
// dist/ is what Workers Static Assets serves (wrangler.toml).
export default defineConfig({
    site: "https://alexkan.xyz",
    srcDir: "./site",
    publicDir: "./public",
    outDir: "./dist",
    // site/pages/ideology.astro -> dist/ideology.html, served at /ideology
    build: { format: "file" },
    // Keep the pages' whitespace as written
    compressHTML: false,
    integrations: [agentFiles({ sources: { "/projects": ["site/content/projects"] } })],
});
