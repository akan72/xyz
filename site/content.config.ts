import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const year = z.number().int().min(1990).max(2100);

// One Markdown file per project in site/content/projects/, listed on /projects:
// these fields as frontmatter, then a sentence or two about it as the body.
// `astro check` and `astro build` fail if an entry doesn't match this schema,
// including on a key it doesn't list (a typo like `tittle:`).
const projects = defineCollection({
    loader: glob({ pattern: "*.md", base: "./site/content/projects" }),
    schema: z.strictObject({
        name: z.string().trim().min(1),
        url: z.url().startsWith("https://", "use an https:// URL"),
        // Shown after the link as (2020-Present), (2020-2023) or (2025)
        years: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("since"), start: year }),
            z.strictObject({ kind: z.literal("range"), start: year, end: year }).refine((y) => y.start < y.end, {
                message: "start must come before end; use kind: single for one year",
            }),
            z.strictObject({ kind: z.literal("single"), year }),
        ]),
        // Shown under the description, joined with " · "
        stack: z.array(z.string().trim().min(1)).nonempty(),
        // Position in the list, smallest first; no two projects may share one
        order: z.number().int(),
        // Project media shown above the description (site/components/)
        media: z.enum(["subway-vis", "cig-picker", "vesta-demo"]).optional(),
    }),
});

// One Markdown (.md) or MDX (.mdx) file per post in site/content/writing/. The
// filename is the URL: my-post.mdx -> /writing/my-post. MDX can import and
// use components, e.g. an interactive figure.
const writing = defineCollection({
    loader: glob({ pattern: "*.{md,mdx}", base: "./site/content/writing" }),
    schema: z.strictObject({
        title: z.string().trim().min(1),
        // One sentence: the page's meta description and its llms.txt entry
        description: z.string().trim().min(1),
        date: z.coerce.date(),
        // Drafts show up in `npm run dev` only; the build leaves them out entirely
        draft: z.boolean().default(false),
    }),
});

export const collections = { projects, writing };
