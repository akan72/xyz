import { SNAPSHOT_KEY, type DemoFallback } from "../../shared/vesta.ts";
import { fetchAlpacaQuotes, ProviderError, type AlpacaCredentials } from "./alpaca.ts";

export const INTERVAL_SECONDS = 30 * 60;
export interface RefreshState { failures: number; nextAttemptAt: number; lastSlot: number }
export interface RefreshStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
}
export interface SnapshotStore { put(key: string, value: string): Promise<void> }
// A provider change does not inherit Yahoo's failed-request cooldown.
const STATE_KEY = "refresh-state:alpaca:v1";

export async function refreshOnce(storage: RefreshStorage, snapshots: SnapshotStore, scheduledAt: number,
    credentials: AlpacaCredentials, fetcher: typeof fetch = fetch, clock: () => number = () => Math.floor(Date.now() / 1000)): Promise<string> {
    try {
        const now = clock(), slot = Math.floor(scheduledAt / INTERVAL_SECONDS);
        if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 || scheduledAt > now + 60 || now - scheduledAt >= INTERVAL_SECONDS) return "expired_trigger";
        const saved = await storage.get<RefreshState>(STATE_KEY);
        const state = saved ?? { failures: 0, nextAttemptAt: 0, lastSlot: -1 };
        if (![state.failures, state.nextAttemptAt, state.lastSlot].every(Number.isSafeInteger)
            || state.failures < 0 || state.failures > 10 || state.nextAttemptAt < 0 || state.lastSlot < -1) return "invalid_refresh_state";
        if (slot <= state.lastSlot || now < state.nextAttemptAt) return "cooldown";
        const failures = Math.min(state.failures + 1, 10);
        // Persist before calling the provider. An interrupted run leaves a cooldown.
        await storage.put(STATE_KEY, { failures, nextAttemptAt: now + Math.min(3600 * 2 ** (failures - 1), 8 * 3600), lastSlot: slot });
        const snapshot = await fetchAlpacaQuotes(credentials, fetcher, clock);
        await snapshots.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
        await storage.put(STATE_KEY, { failures: 0, nextAttemptAt: scheduledAt + INTERVAL_SECONDS, lastSlot: slot });
        return "updated";
    } catch (error) {
        if (error instanceof ProviderError && error.message === "rate_limited") {
            // Match the CLI's local-preview fallback without copying its demo
            // prices into the Worker. The site uses its CLI-generated HTML.
            const fallback = { version: 1, mode: "demo", reason: "rate_limited", fetchedAt: clock() } satisfies DemoFallback;
            try { await snapshots.put(SNAPSHOT_KEY, JSON.stringify(fallback)); }
            catch { return "demo_fallback_failed"; }
        }
        // No upstream messages, URLs or bodies are written to public logs.
        return error instanceof ProviderError ? error.message : "refresh_failed";
    }
}
