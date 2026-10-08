import { changePercent, INSTRUMENTS, SNAPSHOT_KEY, validateSnapshot, type DemoFallback, type Quote } from "../../shared/vesta.ts";

export const INTERVAL_SECONDS = 30 * 60;
export interface RefreshState { failures: number; nextAttemptAt: number; lastSlot: number }
export interface RefreshStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
}
export interface SnapshotStore { put(key: string, value: string): Promise<void> }
const STATE_KEY = "refresh-state:v1";

class RefreshError extends Error {}
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RefreshError("invalid_response");
    return value as RecordValue;
}
function number(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new RefreshError("invalid_quote");
    return value;
}
function timestamp(value: unknown): number {
    const result = number(value);
    if (!Number.isSafeInteger(result)) throw new RefreshError("invalid_quote");
    return result;
}
interface Period { start: number; end: number }
function period(value: unknown): Period {
    const data = object(value);
    const start = timestamp(data.start), end = timestamp(data.end);
    if (end <= start || end - start > 86400) throw new RefreshError("invalid_session");
    return { start, end };
}

// This uses Yahoo's own regular-session windows instead of hardcoding US
// holidays, DST or early closes. Five-day chartPreviousClose is not yesterday's
// close, so derive the comparison from the preceding session's chart bars.
export function normalizeChart(input: unknown, index: number, fetchedAt: number): Quote {
    const expected = INSTRUMENTS[index];
    const chart = object(object(input).chart);
    if (chart.error !== null && chart.error !== undefined) throw new RefreshError("provider_rejected");
    if (!Array.isArray(chart.result) || chart.result.length !== 1) throw new RefreshError("incomplete_snapshot");
    const data = object(chart.result[0]), meta = object(data.meta);
    if (meta.symbol !== expected.providerSymbol || meta.currency !== "USD" || meta.dataGranularity !== "5m"
        || (expected.assetType === "crypto" ? meta.instrumentType !== "CRYPTOCURRENCY" || meta.exchangeTimezoneName !== "UTC"
            : !["EQUITY", "ETF"].includes(String(meta.instrumentType)) || meta.exchangeTimezoneName !== "America/New_York")) throw new RefreshError("invalid_quote");
    const indicators = object(data.indicators);
    if (!Array.isArray(indicators.quote) || indicators.quote.length !== 1) throw new RefreshError("invalid_response");
    const closes = object(indicators.quote[0]).close;
    if (!Array.isArray(data.timestamp) || !Array.isArray(closes) || closes.length !== data.timestamp.length || closes.length > 2000) throw new RefreshError("invalid_response");
    const bars: { at: number; close: number }[] = [];
    let previousTimestamp = 0;
    for (let i = 0; i < closes.length; i++) {
        const at = timestamp(data.timestamp[i]);
        if (at <= previousTimestamp || at > fetchedAt + 60) throw new RefreshError("invalid_quote");
        previousTimestamp = at;
        if (closes[i] === null) continue;
        bars.push({ at, close: number(closes[i]) });
    }
    const latest = bars.at(-1);
    if (!latest) throw new RefreshError("incomplete_snapshot");
    let previousClose: number, marketState: Quote["marketState"] = "open";
    if (expected.assetType === "crypto") {
        const dayStart = Math.floor(latest.at / 86400) * 86400;
        if (dayStart !== Math.floor(fetchedAt / 86400) * 86400) throw new RefreshError("stale_quote");
        const comparison = bars.find(bar => bar.at === dayStart - 300);
        if (!comparison) throw new RefreshError("missing_previous_close");
        previousClose = comparison.close;
    } else {
        const current = period(object(meta.currentTradingPeriod).regular);
        if (!Array.isArray(meta.tradingPeriods)) throw new RefreshError("invalid_session");
        const periods = meta.tradingPeriods.flat().map(period).sort((a, b) => a.start - b.start);
        if (!periods.length || periods.some((p, i) => i > 0 && p.start <= periods[i - 1].end)) throw new RefreshError("invalid_session");
        const sessionIndex = periods.findIndex(p => p.start <= latest.at && latest.at <= p.end);
        if (sessionIndex < 1) throw new RefreshError("missing_previous_close");
        const session = periods[sessionIndex], previousSession = periods[sessionIndex - 1];
        marketState = fetchedAt >= current.start && fetchedAt < current.end ? "open" : "closed";
        if ((marketState === "open" || fetchedAt >= current.end) && session.start !== current.start) throw new RefreshError("stale_quote");
        if (marketState === "closed" && latest.at < session.end - 300) throw new RefreshError("stale_quote");
        // Reject extended-hours points even if an upstream response includes them.
        if (bars.some(bar => !periods.some(p => p.start <= bar.at && bar.at <= p.end))) throw new RefreshError("invalid_session");
        const comparison = bars.filter(bar => bar.at >= previousSession.end - 300 && bar.at <= previousSession.end).at(-1);
        if (!comparison) throw new RefreshError("missing_previous_close");
        previousClose = comparison.close;
    }
    return { id: expected.id, label: expected.label, assetType: expected.assetType, currency: "USD",
        price: latest.close, previousClose, changePercent: changePercent(latest.close, previousClose),
        quotedAt: latest.at, marketState };
}

async function fetchChart(symbol: string, fetcher: typeof fetch, signal: AbortSignal): Promise<unknown> {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
    url.search = new URLSearchParams({ range: "5d", interval: "5m", includePrePost: "false" }).toString();
    let response: Response;
    // Workers supports manual/follow only. Manual plus !ok below rejects 3xx
    // without following an upstream redirect.
    try { response = await fetcher(url, { headers: { Accept: "application/json" }, redirect: "manual", signal }); }
    catch { throw new RefreshError("provider_unavailable"); }
    if (response.status === 429) throw new RefreshError("rate_limited");
    if (!response.ok) throw new RefreshError(response.status >= 500 ? "provider_unavailable" : "provider_rejected");
    // Keep a malformed response from consuming unbounded memory.
    const reader = response.body?.getReader();
    if (!reader) throw new RefreshError("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 262144) { await reader.cancel(); throw new RefreshError("invalid_response"); }
            chunks.push(value);
        }
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        const result = JSON.parse(new TextDecoder().decode(buffer));
        const error = result?.chart?.error;
        if (error && /429|too[\s_-]*many[\s_-]*requests|rate[\s_-]*limit/i.test(`${error.code ?? ""} ${error.description ?? ""}`)) throw new RefreshError("rate_limited");
        return result;
    } catch (error) {
        throw error instanceof RefreshError ? error : new RefreshError("invalid_response");
    } finally { reader.releaseLock(); }
}

export async function fetchQuotes(fetcher: typeof fetch, clock: () => number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const charts: unknown[] = [];
    try {
        // One logical six-instrument refresh, two Yahoo requests at a time.
        // Yahoo's anonymous batch quote endpoint returns 401; no batch fiction
        // or cookie/account rotation, and no retry burst after a 429.
        for (let i = 0; i < INSTRUMENTS.length; i += 2) {
            const results = await Promise.allSettled(INSTRUMENTS.slice(i, i + 2).map(q => fetchChart(q.providerSymbol, fetcher, controller.signal)));
            const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
            if (failed.length) {
                const rateLimit = failed.find(r => r.reason instanceof RefreshError && r.reason.message === "rate_limited");
                throw (rateLimit ?? failed[0]).reason;
            }
            charts.push(...results.map(r => (r as PromiseFulfilledResult<unknown>).value));
        }
        const fetchedAt = clock();
        return validateSnapshot({ version: 1, mode: "market", provider: "yahoo-finance", priceBasis: "5-minute-bars", fetchedAt,
            quotes: charts.map((chart, i) => normalizeChart(chart, i, fetchedAt)) }, fetchedAt);
    } finally { clearTimeout(timer); controller.abort(); }
}

export async function refreshOnce(storage: RefreshStorage, snapshots: SnapshotStore, scheduledAt: number,
    fetcher: typeof fetch = fetch, clock: () => number = () => Math.floor(Date.now() / 1000)): Promise<string> {
    try {
        const now = clock(), slot = Math.floor(scheduledAt / INTERVAL_SECONDS);
        if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 || scheduledAt > now + 60 || now - scheduledAt >= INTERVAL_SECONDS) return "expired_trigger";
        const saved = await storage.get<RefreshState>(STATE_KEY);
        const state = saved ?? { failures: 0, nextAttemptAt: 0, lastSlot: -1 };
        if (![state.failures, state.nextAttemptAt, state.lastSlot].every(Number.isSafeInteger)
            || state.failures < 0 || state.failures > 10 || state.nextAttemptAt < 0 || state.lastSlot < -1) return "invalid_refresh_state";
        if (slot <= state.lastSlot || now < state.nextAttemptAt) return "cooldown";
        const failures = Math.min(state.failures + 1, 10);
        // Persist before calling Yahoo. An interrupted run leaves a cooldown.
        await storage.put(STATE_KEY, { failures, nextAttemptAt: now + Math.min(3600 * 2 ** (failures - 1), 8 * 3600), lastSlot: slot });
        const snapshot = await fetchQuotes(fetcher, clock);
        await snapshots.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
        await storage.put(STATE_KEY, { failures: 0, nextAttemptAt: scheduledAt + INTERVAL_SECONDS, lastSlot: slot });
        return "updated";
    } catch (error) {
        if (error instanceof RefreshError && error.message === "rate_limited") {
            // Match the CLI's local-preview fallback without copying its demo
            // prices into the Worker. The site uses its CLI-generated HTML.
            const fallback = { version: 1, mode: "demo", reason: "rate_limited", fetchedAt: clock() } satisfies DemoFallback;
            try { await snapshots.put(SNAPSHOT_KEY, JSON.stringify(fallback)); }
            catch { return "demo_fallback_failed"; }
        }
        // No upstream messages, URLs or bodies are written to public logs.
        return error instanceof RefreshError ? error.message : "refresh_failed";
    }
}
