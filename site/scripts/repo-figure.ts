// The repo figure on /projects (site/components/RepoFigure.astro). Every page
// loads this, so it also runs when page-navigation.js brings a page in
// without a reload; the libraries and the history download only on a page
// that has the figure.
import type { FileDiff, File as FileView } from "@pierre/diffs";
import type { FileTree } from "@pierre/trees";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const figures = new Map<HTMLElement, () => void>(); // Each mounted figure's clean-up

function debounce(run: () => void, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(run, ms);
    };
}

async function mount(figure: HTMLElement) {
    const [{ FileTree }, diffs, lib, response] = await Promise.all([
        import("@pierre/trees"), import("@pierre/diffs"), import("../lib/repo-history"), fetch("/repo/xyz/history.json").catch(() => null),
    ]);
    if (!response?.ok) return;
    const history = lib.createHistory(await response.json());
    const container = figure.querySelector<HTMLElement>("file-tree-container");
    if (!container?.isConnected) return;
    const options = { ...lib.diffsTheme, overflow: "wrap", preferredHighlighter: "highlights" } as const;

    const slider = figure.querySelector<HTMLInputElement>(".commit-slider")!;
    const link = figure.querySelector<HTMLAnchorElement>(".commit a")!;
    const subject = figure.querySelector<HTMLElement>(".commit .subject")!;
    const date = figure.querySelector<HTMLElement>(".commit .date")!;
    const diffPane = figure.querySelector<HTMLElement>(".diff-pane")!;
    const diffBody = figure.querySelector<HTMLElement>(".diff-body")!;
    const filePane = figure.querySelector<HTMLElement>(".file")!;
    const filePath = figure.querySelector<HTMLElement>(".file-path")!;
    const code = figure.querySelector<HTMLElement>(".file-body .code")!;
    const message = figure.querySelector<HTMLElement>(".file-body .message")!;
    const note = (text: string) => Object.assign(document.createElement("p"), { className: "message", textContent: text });

    // The open file, as it was at the slider's commit
    let openPath: string | null = null;
    let fileView: FileView | null = null;
    let fileRequest = 0;
    const say = (text: string) => {
        code.hidden = true;
        message.hidden = false;
        message.replaceChildren(text);
    };
    async function showFile() {
        if (!openPath) return;
        const request = ++fileRequest;
        const index = slider.valueAsNumber;
        const { sha } = history.commits[index];
        filePane.hidden = false;
        filePath.textContent = openPath;
        if (!history.has(index, openPath)) return say(`Not in the repo at ${sha.slice(0, 7)}.`);
        const url = `https://raw.githubusercontent.com/${history.repo}/${sha}/${openPath}`;
        if (IMAGE.test(openPath)) {
            const image = new Image();
            image.src = url;
            image.alt = openPath;
            say("");
            message.replaceChildren(image);
            return;
        }
        const response = await fetch(url).catch(() => null);
        if (request !== fileRequest) return;
        if (!response?.ok) return say(`Couldn't load ${openPath} from GitHub.`);
        const contents = await response.text();
        if (request !== fileRequest) return;
        code.hidden = false;
        message.hidden = true;
        fileView ??= new diffs.File(options);
        fileView.render({ file: { name: openPath, contents, cacheKey: `${sha}:${openPath}` }, containerWrapper: code });
    }
    const closeFile = () => {
        openPath = null;
        fileRequest++;
        filePane.hidden = true;
    };

    // What the slider's commit changed
    let fileDiffs: FileDiff[] = [];
    let diffShown = -1;
    let diffRequest = 0;
    const diffOf = new Map<string, HTMLElement>(); // Each changed file's diff, by path
    let jumpTo: string | null = null; // A changed file picked before its diff arrived
    /** A file the commit changed jumps to its diff */
    function showChange(path: string) {
        const index = slider.valueAsNumber;
        if (!history.commits[index].changes.some((change) => change.path === path)) return false;
        if (diffShown !== index) {
            jumpTo = path;
            return true;
        }
        const box = diffOf.get(path);
        if (!box) return false; // A lockfile or binary file, which has no diff
        closeFile();
        diffPane.scrollTop += box.getBoundingClientRect().top - diffPane.getBoundingClientRect().top;
        return true;
    }
    async function showDiff() {
        const index = slider.valueAsNumber;
        if (diffShown === index) return;
        const request = ++diffRequest;
        const { sha } = history.commits[index];
        const response = await fetch(`/repo/xyz/${sha}.patch`).catch(() => null);
        const patch = response?.ok ? await response.text() : null;
        if (request !== diffRequest) return;
        for (const fileDiff of fileDiffs) fileDiff.cleanUp();
        fileDiffs = [];
        diffOf.clear();
        diffBody.replaceChildren();
        diffPane.scrollTop = 0;
        diffShown = index;
        if (patch == null) return diffBody.append(note("Couldn't load this commit's diff."));
        const files = diffs.parsePatchFiles(patch).flatMap(({ files }) => files);
        if (files.length === 0) diffBody.append(note("Only binary files or lockfiles changed."));
        for (const fileDiff of files) {
            const view = new diffs.FileDiff({ ...options, diffStyle: "unified" });
            const box = diffBody.appendChild(document.createElement("div"));
            view.render({ fileDiff, containerWrapper: box });
            fileDiffs.push(view);
            diffOf.set(fileDiff.name, box);
        }
        if (jumpTo) {
            const path = jumpTo;
            jumpTo = null;
            if (!showChange(path)) {
                openPath = path;
                showFile();
            }
        }
    }

    // The build drew the tree at the slider's commit, with its changes' folders open
    const start = slider.valueAsNumber;
    const tree: FileTree = new FileTree({
        ...history.treeOptions(start),
        onSelectionChange(paths) {
            const path = paths.at(-1);
            if (!path || path.endsWith("/") || showChange(path)) return;
            openPath = path;
            showFile();
        },
    });
    tree.hydrate({ fileTreeContainer: container });
    figure.querySelector(".close")!.addEventListener("click", closeFile);

    // Folders the last commit opened to show its changes, which the next one
    // closes again unless it changed something in them too
    let opened = new Set(history.changedFolders(start));
    const fileLater = debounce(showFile, 150);
    const diffLater = debounce(showDiff, 150);
    slider.addEventListener("input", () => {
        const index = slider.valueAsNumber;
        const commit = history.commits[index];
        const { paths, gitStatus } = history.treeAt(index);
        const open = new Set(tree.getVisibleRows(0, tree.getVisibleCount())
            .filter((row) => row.kind === "directory" && row.isExpanded && !opened.has(row.path))
            .map((row) => row.path));
        opened = new Set(history.changedFolders(index).filter((folder) => !open.has(folder)));
        tree.resetPaths(paths, { initialExpandedPaths: [...open, ...opened] });
        tree.setGitStatus(gitStatus);
        const changed = new Set(gitStatus.map(({ path }) => path));
        const rows = tree.getVisibleRows(0, tree.getVisibleCount());
        const first = rows.findIndex((row) => changed.has(row.path));
        if (first !== -1) tree.scrollToPath(rows[Math.max(0, first - 1)].path, { offset: "top" });
        link.href = lib.commitUrl(history.repo, commit.sha);
        link.firstElementChild!.textContent = commit.sha.slice(0, 7);
        subject.textContent = subject.title = commit.subject;
        date.textContent = lib.commitDate(commit.date);
        slider.setAttribute("aria-valuetext", `${date.textContent}: ${commit.subject}`);
        fileLater();
        diffLater();
    });
    slider.disabled = false;
    showDiff();

    figures.set(figure, () => {
        tree.cleanUp();
        fileView?.cleanUp();
        for (const fileDiff of fileDiffs) fileDiff.cleanUp();
    });
}

function mountAll() {
    for (const [figure, cleanUp] of figures) {
        if (!figure.isConnected) {
            cleanUp();
            figures.delete(figure);
        }
    }
    for (const figure of document.querySelectorAll<HTMLElement>(".repo-figure:not([data-mounted])")) {
        figure.dataset.mounted = "";
        mount(figure);
    }
}

mountAll();
document.addEventListener("xyz:navigated", mountAll);
