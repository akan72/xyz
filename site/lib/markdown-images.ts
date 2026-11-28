import { fileURLToPath } from "node:url";
import { emitImageMetadata } from "astro/assets/utils/node";
import { defineHastPlugin } from "satteri";

const publicDir = new URL("../../public/", import.meta.url);

export const markdownImages = defineHastPlugin({
    name: "markdown-images",
    element: {
        filter: ["img"],
        async visit(node, ctx) {
            const src = String(node.properties.src ?? "");
            ctx.setProperty(node, "decoding", "async");
            if (!src.endsWith("/cover.jpg")) ctx.setProperty(node, "loading", "lazy");

            if (!src.startsWith("/") || src.startsWith("//")) return;
            const file = new URL(`.${src}`, publicDir);
            if (!file.href.startsWith(publicDir.href) || !/\.(avif|gif|jpe?g|png|webp)$/i.test(file.pathname)) return;

            const dimensions = await emitImageMetadata(fileURLToPath(file));
            if (!dimensions) return;
            ctx.setProperty(node, "width", dimensions.width);
            ctx.setProperty(node, "height", dimensions.height);
        },
    },
});
