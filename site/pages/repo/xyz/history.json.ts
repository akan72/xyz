// What every commit changed, for the repo figure's script (site/scripts/repo-figure.ts)
import { readHistory } from "../../../lib/repo-git";

export const GET = () => Response.json(readHistory());
