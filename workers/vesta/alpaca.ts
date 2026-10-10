import { INSTRUMENTS } from "../../shared/vesta.ts";
import type { BoardQuote } from "../../shared/board.ts";

export interface AlpacaCredentials { keyId: string; secretKey: string }
export type ProviderFailure = "missing_credentials" | "provider_unavailable" | "rate_limited"
    | "provider_auth_failed" | "provider_rejected" | "invalid_response" | "invalid_quote"
    | "missing_symbol" | "missing_previous_close" | "incomplete_snapshot";
export interface RequestStatus { batch: "stocks" | "crypto"; status: number | null }
export type ProviderResult =
    | { ok: true; quotes: BoardQuote[]; fetchedAt: number; requests: RequestStatus[] }
    | { ok: false; error: ProviderFailure; requests: RequestStatus[] };
class ProviderError extends Error {
    readonly code: ProviderFailure;
    constructor(code: ProviderFailure) { super(code); this.code = code; }
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("invalid_response");
    return value as Record<string, unknown>;
}
function price(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ProviderError("invalid_quote");
    return value;
}
function timestamp(value: unknown): number {
    if (typeof value !== "string") throw new ProviderError("invalid_quote");
    const result = Math.floor(Date.parse(value) / 1000);
    if (!Number.isSafeInteger(result) || result <= 0) throw new ProviderError("invalid_quote");
    return result;
}
function nyDate(at: number): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at * 1000));
}
// Current-session bars must be recent; prior sessions can survive weekends.
function stockMaxAge(at: number, now: number): number {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(now * 1000));
    return nyDate(at) === nyDate(now) && time >= "09:30" && time < "16:00" ? 3600 : 7 * 86400;
}
function requireFresh(at: number, now: number, maxAge: number): void {
    if (at > now + 60 || now - at > maxAge) throw new ProviderError("invalid_quote");
}
function quote(label: string, currentPrice: number, previousClose: number): BoardQuote {
    const changePercent = (currentPrice - previousClose) / previousClose * 100;
    if (!Number.isFinite(changePercent)) throw new ProviderError("invalid_quote");
    return { label, price: currentPrice, changePercent };
}

export function normalizeStocks(input: unknown, fetchedAt: number): BoardQuote[] {
    const snapshots = object(input);
    return INSTRUMENTS.slice(1).map(({ label, symbol }) => {
        if (!snapshots[symbol]) throw new ProviderError("missing_symbol");
        const snapshot = object(snapshots[symbol]);
        const bar = object(snapshot.minuteBar), previous = object(snapshot.prevDailyBar);
        const at = timestamp(bar.t), previousAt = timestamp(previous.t);
        requireFresh(at, fetchedAt, stockMaxAge(at, fetchedAt));
        if (previousAt >= at || nyDate(previousAt) >= nyDate(at)) throw new ProviderError("missing_previous_close");
        return quote(label, price(bar.c), price(previous.c));
    });
}

export function normalizeBitcoin(input: unknown, fetchedAt: number): BoardQuote {
    const data = object(input);
    if (data.next_page_token != null) throw new ProviderError("incomplete_snapshot");
    const raw = object(data.bars)["BTC/USD"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000) throw new ProviderError("incomplete_snapshot");
    const bars = raw.map(value => {
        const bar = object(value);
        return { at: timestamp(bar.t), close: price(bar.c) };
    });
    if (bars.some((bar, i) => bar.at > fetchedAt + 60 || (i > 0 && bar.at <= bars[i - 1].at))) throw new ProviderError("invalid_quote");
    const latest = bars.at(-1)!;
    requireFresh(latest.at, fetchedAt, 3600);
    // At UTC midnight, delayed bars may still belong to the preceding day.
    const dayStart = Math.floor(latest.at / 86400) * 86400;
    const comparison = bars.find(bar => bar.at === dayStart - 300);
    if (!comparison) throw new ProviderError("missing_previous_close");
    return quote("BTC", latest.close, comparison.close);
}

async function readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 262144) {
                await reader.cancel();
                throw new ProviderError("invalid_response");
            }
            chunks.push(value);
        }
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder().decode(buffer));
    } catch { throw new ProviderError("invalid_response"); }
    finally { reader.releaseLock(); }
}

interface BatchResult extends RequestStatus { data?: unknown; error?: ProviderFailure }
async function fetchBatch(batch: RequestStatus["batch"], url: URL, credentials: AlpacaCredentials,
    fetcher: typeof fetch, signal: AbortSignal): Promise<BatchResult> {
    let status: number | null = null;
    try {
        const response = await fetcher(url, {
            redirect: "manual", signal,
            headers: { Accept: "application/json", "APCA-API-KEY-ID": credentials.keyId, "APCA-API-SECRET-KEY": credentials.secretKey },
        });
        status = response.status;
        if (status === 429) throw new ProviderError("rate_limited");
        if (status === 401 || status === 403) throw new ProviderError("provider_auth_failed");
        if (!response.ok) throw new ProviderError(status >= 500 ? "provider_unavailable" : "provider_rejected");
        return { batch, status, data: await readJson(response) };
    } catch (error) {
        return { batch, status, error: error instanceof ProviderError ? error.code : "provider_unavailable" };
    }
}

export async function fetchAlpacaQuotes(credentials: AlpacaCredentials, fetcher: typeof fetch,
    clock: () => number): Promise<ProviderResult> {
    if (!credentials.keyId || !credentials.secretKey) return { ok: false, error: "missing_credentials", requests: [] };
    const stocks = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
    stocks.search = new URLSearchParams({ symbols: INSTRUMENTS.slice(1).map(q => q.symbol).join(","), feed: "iex", currency: "USD" }).toString();
    const bitcoin = new URL("https://data.alpaca.markets/v1beta3/crypto/us/bars");
    // Two prior UTC days cover the previous close even when delayed bars cross midnight.
    const now = clock(), dayStart = Math.floor(now / 86400) * 86400;
    bitcoin.search = new URLSearchParams({
        symbols: "BTC/USD", timeframe: "5Min", start: new Date((dayStart - 172800) * 1000).toISOString(),
        end: new Date((now - 1200) * 1000).toISOString(), limit: "1000", sort: "asc",
    }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
        const batches = await Promise.all([
            fetchBatch("stocks", stocks, credentials, fetcher, controller.signal),
            fetchBatch("crypto", bitcoin, credentials, fetcher, controller.signal),
        ]);
        const requests = batches.map(({ batch, status }) => ({ batch, status }));
        const error = batches.find(b => b.error === "rate_limited")?.error ?? batches.find(b => b.error)?.error;
        if (error) return { ok: false, error, requests };
        const fetchedAt = clock();
        try {
            const quotes = [normalizeBitcoin(batches[1].data, fetchedAt), ...normalizeStocks(batches[0].data, fetchedAt)];
            return { ok: true, quotes, fetchedAt, requests };
        } catch (error) {
            return { ok: false, error: error instanceof ProviderError ? error.code : "invalid_response", requests };
        }
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
