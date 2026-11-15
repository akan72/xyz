import { readHistory } from "./repo-git.ts";

/** "November 2026": the month of the newest commit, the one the repo figure on /projects ends at. */
export function lastUpdated(): string {
    // e.g. 2026-11-04T13:18:15-05:00. Reading the month from the string keeps
    // the committer's offset, so a late-night commit isn't dated a month ahead.
    const date = readHistory().commits.at(-1)?.date ?? "";
    const [, year, month] = date.match(/^(\d{4})-(\d{2})/) ?? [];
    if (!year) throw new Error(`can't date the site from the newest commit: ${JSON.stringify(date)}`);
    const name = new Date(Date.UTC(Number(year), Number(month) - 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    return `${name} ${year}`;
}
