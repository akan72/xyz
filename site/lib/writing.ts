import { getCollection, type CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"writing">;

/** Posts, newest first. Drafts are included only in `npm run dev`. */
export async function getPosts(): Promise<Post[]> {
    const posts = await getCollection("writing", ({ data }) => import.meta.env.DEV || !data.draft);
    return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

/** 2026-10-07 */
export const formatDate = (date: Date) => date.toISOString().slice(0, 10);
