// Generate the site's fallback with the real Vesta CLI, never a second price table.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const checkout = process.argv[2];
if (!checkout || process.argv.length !== 3) {
    console.error("Usage: npm run vesta:demo -- /path/to/vesta-checkout");
    process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "vesta-demo-"));
try {
    const output = join(temporary, "preview.html");
    const result = spawnSync(process.env.VESTA_UV ?? "uv", [
        "run", "--project", resolve(checkout), "--frozen", "vesta", "--demo", "--preview-file", output,
    ], { encoding: "utf8", stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Vesta demo generation failed; existing artifact was preserved.");
    const html = readFileSync(output, "utf8");
    const document = parse(html);
    if (document.querySelectorAll(".board").length !== 1 || document.querySelectorAll(".board .tile").length !== 132) {
        throw new Error("Vesta CLI output must contain one complete six-row board.");
    }
    // Keep the exact CLI output. The component extracts its board and supplies
    // the site's existing Sample Prices label and layout.
    writeFileSync(join(root, "site/generated/vesta-demo.html"), html);
    console.log("Updated site/generated/vesta-demo.html from vesta --demo.");
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
