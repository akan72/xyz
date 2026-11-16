// This repo's history for the figure on /projects, read from git at build
// time: what every commit on the branch changed, and each commit's patch.
// site/pages/repo/xyz/ serves both. Build-only (it runs git), so the browser
// gets the history from /repo/xyz/history.json instead.
import { execFileSync } from "node:child_process";
import type { Change, Commit, History } from "./repo-history";

const REPO = "akan72/xyz";
// Files whose diffs are noise in a commit view
const SKIP_DIFF = /(^|\/)(package-lock\.json|Cargo\.lock)$/;
const MAX_FILE_DIFF = 60_000;
const STATUS: Record<string, string> = { A: "added", D: "deleted", M: "modified", T: "modified", R: "renamed" };

const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 256 << 20 });

// The site keeps its email address out of what it serves (scripts/site.test.ts),
// so commit subjects and diffs that mention it get it spelled out instead
const hideAddress = (text: string) => text.replaceAll("me@alexkan.xyz", "me [at] alexkan.xyz");

/** The commit the history ends at. A pull request's CI checks out a merge
 * commit GitHub made, which isn't on any branch; its second parent is the
 * pull request's own newest commit. */
function tip() {
    if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
        throw new Error("shallow git clone: the repo figure needs the full history (actions/checkout `fetch-depth: 0`)");
    }
    return /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/.test(git("log", "-1", "--format=%s", "HEAD").trim()) ? "HEAD^2" : "HEAD";
}

// Merged pull requests by their titles, "Migrate from Fly.io to Cloudflare Workers (#7)"
function mergeTitles(head: string) {
    const titles = new Map<string, string>();
    for (const entry of git("log", "--first-parent", "--merges", "--format=%H%x1f%s%x1f%b%x1e", head).split("\x1e")) {
        const [sha, subject, body] = entry.trim().split("\x1f");
        const number = subject?.match(/^Merge pull request #(\d+) from /)?.[1];
        const title = body?.trim().split("\n")[0];
        if (number && title) titles.set(sha, `${title} (#${number})`);
    }
    return titles;
}

function readCommits(head: string): Commit[] {
    const titles = mergeTitles(head);
    const log = git("log", "--first-parent", "--diff-merges=first-parent", "--root", "--reverse", "-M", "--name-status", "--format=%x1e%H%x1f%cI%x1f%s", head);
    return log.split("\x1e").slice(1).map((entry) => {
        const [header, ...lines] = entry.split("\n");
        const [sha, date, subject] = header.split("\x1f");
        const changes = lines.filter(Boolean).map((line): Change => {
            const [code, ...paths] = line.split("\t");
            const status = STATUS[code[0]];
            if (!status || paths.some((path) => path.startsWith('"'))) throw new Error(`Can't read the change "${line}" in ${sha}.`);
            return status === "renamed" ? { path: paths[1], status, from: paths[0] } : { path: paths[0], status };
        });
        return { sha, date, subject: hideAddress(titles.get(sha) ?? subject), changes };
    });
}

// Replaying every change has to rebuild the files at the tip, or the tree
// would show the wrong files at some commit
function checkCommits(head: string, commits: Commit[]) {
    const files = new Set<string>();
    for (const { changes } of commits) {
        for (const { path, status, from } of changes) {
            if (status === "deleted") files.delete(path);
            else {
                if (from) files.delete(from);
                files.add(path);
            }
        }
    }
    const actual = git("ls-tree", "-r", head).split("\n").filter((line) => line.includes(" blob ")).map((line) => line.split("\t")[1]);
    const missing = actual.filter((path) => !files.has(path));
    const extra = [...files].filter((path) => !actual.includes(path));
    if (missing.length || extra.length) throw new Error(`Replaying the history doesn't rebuild ${head}. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
}

// A commit's patch against the branch before it, minus lockfile noise
function trimPatch(patch: string) {
    return patch.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) => {
        const path = part.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "";
        if (SKIP_DIFF.test(path)) return "";
        if (part.length > MAX_FILE_DIFF) return part.slice(0, part.indexOf("\n@@")) + "\n";
        return part;
    }).join("");
}

let history: History | undefined;
/** Every commit on the branch, oldest first */
export function readHistory(): History {
    if (!history) {
        const head = tip();
        const commits = readCommits(head);
        checkCommits(head, commits);
        history = { repo: REPO, commits };
    }
    return history;
}

let patches: Map<string, string> | undefined;
/** Each commit's patch, by SHA */
export function readPatches() {
    if (!patches) {
        patches = new Map();
        const log = git("log", "--first-parent", "--diff-merges=first-parent", "--root", "-M", "-p", "--format=%x1e%H", tip());
        for (const entry of log.split("\x1e").slice(1)) {
            const newline = entry.indexOf("\n");
            patches.set(entry.slice(0, newline), hideAddress(trimPatch(entry.slice(newline + 1))));
        }
    }
    return patches;
}
