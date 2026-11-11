// This repo's history for the figure on /projects
// (site/components/RepoFigure.astro): what every commit on the default branch
// changed (site/generated/xyz-history.json) and each commit's patch
// (public/repo/xyz/<sha>.patch, fetched when the slider reaches it). Reads a
// bare clone of the GitHub repo, so it sees only pushed commits.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "akan72/xyz";
// Files whose diffs are noise in a commit view
const SKIP_DIFF = /(^|\/)(package-lock\.json|Cargo\.lock)$/;
const MAX_FILE_DIFF = 60_000;
// The site keeps its email address out of what it serves (scripts/site.test.ts),
// so commit subjects and diffs that mention it get it spelled out instead
const hideAddress = (text) => text.replaceAll("me@alexkan.xyz", "me [at] alexkan.xyz");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 256 << 20 });

const STATUS = { A: "added", D: "deleted", M: "modified", T: "modified", R: "renamed" };

function mergeTitles(dir) {
    const titles = new Map();
    for (const entry of git(dir, "log", "--first-parent", "--merges", "--format=%H%x1f%s%x1f%b%x1e", "HEAD").split("\x1e")) {
        const [sha, subject, body] = entry.trim().split("\x1f");
        const number = subject?.match(/^Merge pull request #(\d+) from /)?.[1];
        const title = body?.trim().split("\n")[0];
        if (number && title) titles.set(sha, `${title} (#${number})`);
    }
    return titles;
}

function readHistory(dir) {
    const titles = mergeTitles(dir);
    const log = git(dir, "log", "--first-parent", "--diff-merges=first-parent", "--root", "--reverse", "-M", "--name-status", "--format=%x1e%H%x1f%cI%x1f%s", "HEAD");
    return log.split("\x1e").slice(1).map((entry) => {
        const [header, ...lines] = entry.split("\n");
        const [sha, date, subject] = header.split("\x1f");
        const changes = lines.filter(Boolean).map((line) => {
            const [code, ...paths] = line.split("\t");
            const status = STATUS[code[0]];
            if (!status || paths.some((path) => path.startsWith('"'))) throw new Error(`Can't read the change "${line}" in ${sha}.`);
            return status === "renamed" ? { path: paths[1], status, from: paths[0] } : { path: paths[0], status };
        });
        return { sha, date, subject: hideAddress(titles.get(sha) ?? subject), changes };
    });
}

function checkHistory(dir, commits) {
    const files = new Set();
    for (const { changes } of commits) {
        for (const { path, status, from } of changes) {
            if (status === "deleted") files.delete(path);
            else {
                if (from) files.delete(from);
                files.add(path);
            }
        }
    }
    const actual = git(dir, "ls-tree", "-r", "HEAD").split("\n").filter((line) => line.includes(" blob ")).map((line) => line.split("\t")[1]);
    const missing = actual.filter((path) => !files.has(path));
    const extra = [...files].filter((path) => !actual.includes(path));
    if (missing.length || extra.length) throw new Error(`Replaying the history doesn't rebuild HEAD. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
}

// Each commit's patch against the branch before it, minus lockfile noise
function trimPatch(patch) {
    return patch.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) => {
        const path = part.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "";
        if (SKIP_DIFF.test(path)) return "";
        if (part.length > MAX_FILE_DIFF) return part.slice(0, part.indexOf("\n@@")) + "\n";
        return part;
    }).join("");
}

function writePatches(dir) {
    const log = git(dir, "log", "--first-parent", "--diff-merges=first-parent", "--root", "-M", "-p", "--format=%x1e%H", "HEAD");
    let count = 0;
    for (const entry of log.split("\x1e").slice(1)) {
        const newline = entry.indexOf("\n");
        write(`public/repo/xyz/${entry.slice(0, newline)}.patch`, hideAddress(trimPatch(entry.slice(newline + 1))));
        count++;
    }
    return count;
}

const clone = mkdtempSync(join(tmpdir(), "xyz-"));
try {
    execFileSync("git", ["clone", "--quiet", "--bare", "--single-branch", `https://github.com/${REPO}.git`, clone], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const branch = git(clone, "symbolic-ref", "--short", "HEAD").trim();
    const commits = readHistory(clone);
    checkHistory(clone, commits);
    write("site/generated/xyz-history.json", JSON.stringify({ repo: REPO, branch, commits }, null, 2) + "\n");
    const patches = writePatches(clone);
    console.log(`${REPO}: ${commits.length} commits on ${branch} through ${commits.at(-1).sha.slice(0, 7)}, ${patches} patches.`);
} finally {
    rmSync(clone, { recursive: true, force: true });
}
