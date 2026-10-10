import { DISPLAY_KEY, type CachedDisplay } from "../../shared/vesta.ts";
import { formatBoard } from "../../shared/board.ts";
import { fetchAlpacaQuotes, type AlpacaCredentials, type ProviderFailure, type RequestStatus } from "./alpaca.ts";

export const INTERVAL_SECONDS = 30 * 60;
interface RefreshState { failures: number; nextAttemptAt: number; lastSlot: number }
export interface RefreshStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
}
export interface DisplayStore { put(key: string, value: string): Promise<void> }
type RefreshStatus = ProviderFailure | "updated" | "expired_trigger" | "cooldown" | "invalid_refresh_state" | "refresh_failed";
export interface RefreshResult {
    result: RefreshStatus;
    requests: RequestStatus[];
    publication?: CachedDisplay;
}
// Keep the deployed coordinator's cooldown when changing the display contract.
const STATE_KEY = "refresh-state:alpaca:v1";

export async function refreshOnce(storage: RefreshStorage, displays: DisplayStore, scheduledAt: number,
    credentials: AlpacaCredentials, fetcher: typeof fetch = fetch,
    clock: () => number = () => Math.floor(Date.now() / 1000)): Promise<RefreshResult> {
    let requests: RequestStatus[] = [];
    let published: CachedDisplay | undefined;
    try {
        const now = clock(), slot = Math.floor(scheduledAt / INTERVAL_SECONDS);
        if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 || scheduledAt > now + 60 || now - scheduledAt >= INTERVAL_SECONDS) {
            return { result: "expired_trigger", requests };
        }
        const state = await storage.get<RefreshState>(STATE_KEY) ?? { failures: 0, nextAttemptAt: 0, lastSlot: -1 };
        if (![state.failures, state.nextAttemptAt, state.lastSlot].every(Number.isSafeInteger)
            || state.failures < 0 || state.failures > 10 || state.nextAttemptAt < 0 || state.lastSlot < -1) {
            return { result: "invalid_refresh_state", requests };
        }
        if (slot <= state.lastSlot || now < state.nextAttemptAt) return { result: "cooldown", requests };

        // Persist before network access so an interrupted request cannot cause a retry storm.
        const failures = Math.min(state.failures + 1, 10);
        await storage.put(STATE_KEY, {
            failures, nextAttemptAt: now + Math.min(3600 * 2 ** (failures - 1), 8 * 3600), lastSlot: slot,
        });
        const provider = await fetchAlpacaQuotes(credentials, fetcher, clock);
        requests = provider.requests;
        if (!provider.ok) {
            if (provider.error !== "rate_limited") return { result: provider.error, requests };
            // Select the CLI-generated sample without duplicating its prices.
            const publication: CachedDisplay = { version: 2, mode: "demo", fetchedAt: clock() };
            await displays.put(DISPLAY_KEY, JSON.stringify(publication));
            published = publication;
            return { result: "rate_limited", requests, publication };
        }
        const publication: CachedDisplay = {
            version: 2, mode: "market", fetchedAt: provider.fetchedAt, board: formatBoard(provider.quotes),
        };
        await displays.put(DISPLAY_KEY, JSON.stringify(publication));
        published = publication;
        await storage.put(STATE_KEY, { failures: 0, nextAttemptAt: scheduledAt + INTERVAL_SECONDS, lastSlot: slot });
        return { result: "updated", requests, publication };
    } catch {
        // Never return upstream bodies, URLs or credential-bearing error messages.
        return { result: "refresh_failed", requests, ...(published ? { publication: published } : {}) };
    }
}
