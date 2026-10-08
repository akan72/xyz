import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { refreshOnce } from "./prices.ts";
import { SNAPSHOT_KEY, type Snapshot, type DemoFallback } from "../../shared/vesta.ts";

interface Env {
    "APCA-API-KEY-ID"?: string;
    "APCA-API-SECRET-KEY"?: string;
    VESTA_REFRESH_ENABLED?: string;
    VESTA_PRICES?: KVNamespace;
    VESTA_REFRESH: DurableObjectNamespace<VestaRefresh>;
}

interface RunRecord {
    trigger: "cron" | "manual";
    scheduledAt: number;
    completedAt: number;
    result: string;
    requests: { symbol: string; status: number | null }[];
    published?: Snapshot | DemoFallback;
}
const HISTORY_KEY = "vesta:runs:alpaca:v1";

export class VestaRefresh extends DurableObject<Env> {
    private currentRun: Promise<string> | undefined;

    refresh(scheduledAt: number, trigger: "cron" | "manual" = "cron"): Promise<string> {
        if (this.env.VESTA_REFRESH_ENABLED !== "true") return Promise.resolve("disabled");
        if (!this.env.VESTA_PRICES) return Promise.resolve("not_configured");
        if (!this.env["APCA-API-KEY-ID"] || !this.env["APCA-API-SECRET-KEY"]) return Promise.resolve("missing_credentials");
        // All Cron deliveries use the same object. Concurrent deliveries share
        // one promise; durable state prevents duplicates after a restart.
        this.currentRun ??= this.run(scheduledAt, trigger).finally(() => {
            this.currentRun = undefined;
        });
        return this.currentRun;
    }

    private async run(scheduledAt: number, trigger: "cron" | "manual"): Promise<string> {
        const snapshots = this.env.VESTA_PRICES!;
        const requests: RunRecord["requests"] = [];
        let published: RunRecord["published"];
        const observedFetch: typeof fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            const symbol = url.searchParams.get("symbols") ?? "unknown";
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
        }, scheduledAt, { keyId: this.env["APCA-API-KEY-ID"]!, secretKey: this.env["APCA-API-SECRET-KEY"]! }, observedFetch);
        const record: RunRecord = { trigger, scheduledAt, completedAt: Math.floor(Date.now() / 1000), result, requests, ...(published ? { published } : {}) };
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

// An authenticated operator can invoke this named entrypoint through a remote
// service binding. It has no public route and cannot bypass the coordinator.
export class VestaOperations extends WorkerEntrypoint<Env> {
    async refresh(): Promise<string> {
        return this.env.VESTA_REFRESH.getByName("six-instruments-alpaca")
            .refresh(Math.floor(Date.now() / 1000), "manual");
    }
}

export default {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        let result = "disabled";
        if (env.VESTA_REFRESH_ENABLED === "true") {
            try {
                result = await env.VESTA_REFRESH.getByName("six-instruments-alpaca").refresh(Math.floor(controller.scheduledTime / 1000));
            } catch { result = "refresh_failed"; }
        }
        console.log(JSON.stringify({ service: "vesta-refresh", provider: "alpaca", result, scheduledAt: Math.floor(controller.scheduledTime / 1000) }));
    },
    fetch(): Response {
        // Public HTTP cannot invoke a refresh or read the cache.
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;
