import { DurableObject } from "cloudflare:workers";
import { refreshOnce } from "./prices.ts";
import { SNAPSHOT_KEY, type Snapshot, type DemoFallback } from "../../shared/vesta.ts";

interface Env {
    VESTA_REFRESH_ENABLED?: string;
    VESTA_PRICES?: KVNamespace;
    VESTA_REFRESH: DurableObjectNamespace<VestaRefresh>;
}

interface RunRecord {
    scheduledAt: number;
    completedAt: number;
    result: string;
    requests: { symbol: string; status: number | null }[];
    published?: Snapshot | DemoFallback;
}
const HISTORY_KEY = "vesta:runs:v1";

export class VestaRefresh extends DurableObject<Env> {
    private currentRun: Promise<string> | undefined;

    refresh(scheduledAt: number): Promise<string> {
        if (this.env.VESTA_REFRESH_ENABLED !== "true") return Promise.resolve("disabled");
        if (!this.env.VESTA_PRICES) return Promise.resolve("not_configured");
        // All Cron deliveries use the same object. Concurrent deliveries share
        // one promise; durable state prevents duplicates after a restart.
        this.currentRun ??= this.run(scheduledAt).finally(() => {
            this.currentRun = undefined;
        });
        return this.currentRun;
    }

    private async run(scheduledAt: number): Promise<string> {
        const snapshots = this.env.VESTA_PRICES!;
        const requests: RunRecord["requests"] = [];
        let published: RunRecord["published"];
        const observedFetch: typeof fetch = async (input, init) => {
            const symbol = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1)!;
            try {
                const response = await fetch(input, init);
                requests.push({ symbol, status: response.status });
                return response;
            } catch (error) {
                requests.push({ symbol, status: null });
                throw error;
            }
        };
        const result = await refreshOnce(this.ctx.storage, {
            async put(key, value) {
                await snapshots.put(key, value);
                // Record exactly what this run published, without rereading
                // eventually consistent KV or copying another run's data.
                if (key === SNAPSHOT_KEY) published = JSON.parse(value);
            },
        }, scheduledAt, observedFetch);
        const record: RunRecord = { scheduledAt, completedAt: Math.floor(Date.now() / 1000), result, requests, ...(published ? { published } : {}) };
        try {
            // Private, bounded evidence of real Cron deliveries survives gaps
            // in an attached tail. Never served by the website or HTTP handler.
            const prior = await this.ctx.storage.get<RunRecord[]>(HISTORY_KEY) ?? [];
            const history = [...prior, record].slice(-32);
            await this.ctx.storage.put(HISTORY_KEY, history);
            await snapshots.put(HISTORY_KEY, JSON.stringify(history));
        } catch { console.warn(JSON.stringify({ service: "vesta-refresh", result: "history_write_failed", scheduledAt })); }
        return result;
    }
}

export default {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        let result = "disabled";
        if (env.VESTA_REFRESH_ENABLED === "true") {
            try {
                result = await env.VESTA_REFRESH.getByName("six-instruments").refresh(Math.floor(controller.scheduledTime / 1000));
            } catch { result = "refresh_failed"; }
        }
        console.log(JSON.stringify({ service: "vesta-refresh", result, scheduledAt: Math.floor(controller.scheduledTime / 1000) }));
    },
    fetch(): Response {
        // The only producer entry point is a Cloudflare Cron Trigger.
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;
