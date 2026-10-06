import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const year = z.number().int().min(1990).max(2100);

// One Markdown file per project in site/content/projects/, listed on /projects:
// these fields as frontmatter, then a sentence or two about it as the body.
// `astro build` fails if an entry doesn't match this schema.
const projects = defineCollection({
    loader: glob({ pattern: "*.md", base: "./site/content/projects" }),
    schema: z.object({
        name: z.string().trim().min(1),
        url: z.url().startsWith("https://", "use an https:// URL"),
        // Shown after the link as (2020-Present), (2020-2023) or (2025)
        years: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("since"), start: year }),
            z.object({ kind: z.literal("range"), start: year, end: year }).refine((y) => y.start < y.end, {
                message: "start must come before end; use kind: single for one year",
            }),
            z.object({ kind: z.literal("single"), year }),
        ]),
        // Shown under the description, joined with " · "
        stack: z.array(z.string().trim().min(1)).nonempty(),
        // Position in the list, smallest first; no two projects may share one
        order: z.number().int(),
        // A live figure shown above the description (site/components/)
        media: z.enum(["subway-vis"]).optional(),
    }),
});

export const collections = { projects };
