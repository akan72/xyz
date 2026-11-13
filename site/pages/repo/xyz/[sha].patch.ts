// Each commit's patch, which the repo figure fetches when its slider reaches the commit
import type { APIRoute, GetStaticPaths } from "astro";
import { readPatches } from "../../../lib/repo-git";

export const getStaticPaths = (() => [...readPatches()].map(([sha, patch]) => ({ params: { sha }, props: { patch } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => new Response(props.patch, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
