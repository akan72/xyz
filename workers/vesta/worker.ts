import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { refreshOnce, type RefreshResult } from "./prices.ts";

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
    result: RefreshResult["result"];
    requests: RefreshResult["requests"];
    publishedAt?: number;
    mode?: "market" | "demo";
}
const HISTORY_KEY = "vesta:runs:alpaca:v2";
const COORDINATOR = "six-instruments-alpaca";

export class VestaRefresh extends DurableObject<Env> {
    private currentRun: Promise<string> | undefined;

    refresh(scheduledAt: number, trigger: "cron" | "manual" = "cron"): Promise<string> {
        if (this.env.VESTA_REFRESH_ENABLED !== "true") return Promise.resolve("disabled");
        if (!this.env.VESTA_PRICES) return Promise.resolve("not_configured");
        if (!this.env["APCA-API-KEY-ID"] || !this.env["APCA-API-SECRET-KEY"]) return Promise.resolve("missing_credentials");
        // Concurrent deliveries share a run; durable state handles later duplicates.
        this.currentRun ??= this.run(scheduledAt, trigger).finally(() => { this.currentRun = undefined; });
        return this.currentRun;
    }

    private async run(scheduledAt: number, trigger: RunRecord["trigger"]): Promise<string> {
        const outcome = await refreshOnce(this.ctx.storage, this.env.VESTA_PRICES!, scheduledAt, {
            keyId: this.env["APCA-API-KEY-ID"]!, secretKey: this.env["APCA-API-SECRET-KEY"]!,
        });
        const record: RunRecord = {
            trigger, scheduledAt, completedAt: Math.floor(Date.now() / 1000),
            result: outcome.result, requests: outcome.requests,
            ...(outcome.publication ? { publishedAt: outcome.publication.fetchedAt, mode: outcome.publication.mode } : {}),
        };
        console.log(JSON.stringify({ service: "vesta-refresh", ...record }));
        try {
            // Small private run records, not copies of complete quote/board payloads.
            const prior = await this.ctx.storage.get<RunRecord[]>(HISTORY_KEY) ?? [];
            const history = [...prior, record].slice(-32);
            await this.ctx.storage.put(HISTORY_KEY, history);
            await this.env.VESTA_PRICES!.put(HISTORY_KEY, JSON.stringify(history));
        } catch { console.warn(JSON.stringify({ service: "vesta-refresh", result: "history_write_failed" })); }
        return outcome.result;
    }
}

// Administrative RPC uses the same coordinator and cooldown, with no public URL.
export class VestaOperations extends WorkerEntrypoint<Env> {
    async refresh(): Promise<string> {
        return this.env.VESTA_REFRESH.getByName(COORDINATOR).refresh(Math.floor(Date.now() / 1000), "manual");
    }
}

export default {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        try {
            await env.VESTA_REFRESH.getByName(COORDINATOR).refresh(Math.floor(controller.scheduledTime / 1000));
        } catch { console.warn(JSON.stringify({ service: "vesta-refresh", result: "refresh_failed" })); }
    },
    fetch(): Response {
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;
