// This repo's history, for the figure on /projects
// (site/components/RepoFigure.astro), from site/generated/xyz-history.json,
// which `npm run repo:history` writes. The build renders the tree at the
// slider's first commit and the browser hydrates it, which only works when
// both build it from the same options, so both get them from here.
import type { FileTreeOptions, GitStatusEntry } from "@pierre/trees";

export interface Change { path: string; status: string; from?: string }
export interface Commit { sha: string; date: string; subject: string; changes: Change[] }
export interface History { repo: string; branch: string; commits: Commit[] }

export const loadHistory = async () => createHistory((await import("../generated/xyz-history.json")).default as History);

export function createHistory(history: History) {
    const { commits } = history;
    // The files after each commit, rebuilt by replaying what each one changed
    const filesAfter: ReadonlySet<string>[] = [];
    let files = new Set<string>();
    for (const { changes } of commits) {
        files = new Set(files);
        for (const { path, status, from } of changes) {
            if (status === "deleted") files.delete(path);
            else {
                if (from) files.delete(from);
                files.add(path);
            }
        }
        filesAfter.push(files);
    }

    /** The tree after commit `index`, marking what it changed. Files it
     * deleted stay in for that one commit, marked deleted. */
    const treeAt = (index: number) => {
        const { changes } = commits[index];
        return {
            paths: [...filesAfter[index], ...changes.filter(({ status }) => status === "deleted").map(({ path }) => path)],
            gitStatus: changes.map(({ path, status }) => ({ path, status })) as GitStatusEntry[],
        };
    };

    /** The folders holding what commit `index` changed, in the tree's own form ("site/pages/") */
    const changedFolders = (index: number) => {
        const folders = new Set<string>();
        for (const { path } of commits[index].changes) {
            for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) folders.add(path.slice(0, slash + 1));
        }
        return [...folders];
    };

    /** The tree at commit `index`, with the folders it changed open */
    const treeOptions = (index: number): FileTreeOptions => ({
        id: "xyz-tree",
        ...treeAt(index),
        flattenEmptyDirectories: true,
        initialExpansion: "closed",
        initialExpandedPaths: changedFolders(index),
        initialVisibleRowCount: 12,
        density: "compact",
        search: true,
    });

    return { ...history, treeAt, changedFolders, treeOptions, has: (index: number, path: string) => filesAfter[index].has(path) };
}

export const commitUrl = (repo: string, sha: string) => `https://github.com/${repo}/commit/${sha}`;

// The day in the committer's own time zone, which the ISO date starts with
export const commitDate = (date: string) =>
    new Date(date.slice(0, 10)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const diffsTheme = {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    themeType: "system",
} as const;
