import { changePercent, INSTRUMENTS, validateSnapshot, type Quote } from "../../shared/vesta.ts";

export interface AlpacaCredentials { keyId: string; secretKey: string }
export class ProviderError extends Error {}
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

export function normalizeStocks(input: unknown, fetchedAt: number): Quote[] {
    const snapshots = object(input);
    return INSTRUMENTS.slice(1).map(expected => {
        if (!snapshots[expected.providerSymbol]) throw new ProviderError(`missing_symbol_${expected.label}`);
        const snapshot = object(snapshots[expected.providerSymbol]);
        if (!snapshot.minuteBar) throw new ProviderError(`missing_minute_bar_${expected.label}`);
        if (!snapshot.prevDailyBar) throw new ProviderError(`missing_previous_close_${expected.label}`);
        // Use the sampled minute close rather than a separate trade price.
        const bar = object(snapshot.minuteBar), previous = object(snapshot.prevDailyBar);
        const at = timestamp(bar.t), previousAt = timestamp(previous.t);
        if (previousAt >= at || nyDate(previousAt) >= nyDate(at)) throw new ProviderError("missing_previous_close");
        const currentPrice = price(bar.c), previousClose = price(previous.c);
        const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(fetchedAt * 1000));
        const minutes = Number(local.find(p => p.type === "hour")?.value) * 60 + Number(local.find(p => p.type === "minute")?.value);
        // A current-session minute bar identifies an open regular session.
        // Holidays/weekends naturally retain the last actual session's bar.
        const open = nyDate(at) === nyDate(fetchedAt) && minutes >= 570 && minutes < 960;
        return { id: expected.id, label: expected.label, assetType: "security", currency: "USD",
            price: currentPrice, previousClose, changePercent: changePercent(currentPrice, previousClose), quotedAt: at, marketState: open ? "open" : "closed" };
    });
}

export function normalizeBitcoin(input: unknown, fetchedAt: number): Quote {
    const data = object(input);
    if (data.next_page_token !== null && data.next_page_token !== undefined) throw new ProviderError("incomplete_snapshot");
    const raw = object(data.bars)["BTC/USD"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000) throw new ProviderError("incomplete_snapshot");
    const bars = raw.map(value => { const bar = object(value); return { at: timestamp(bar.t), close: price(bar.c) }; });
    if (bars.some((bar, i) => bar.at > fetchedAt + 60 || (i > 0 && bar.at <= bars[i - 1].at))) throw new ProviderError("invalid_quote");
    const latest = bars.at(-1)!;
    // Delayed bars can still belong to yesterday just after UTC midnight.
    const dayStart = Math.floor(latest.at / 86400) * 86400;
    const comparison = bars.find(bar => bar.at === dayStart - 300);
    if (!comparison) throw new ProviderError("missing_previous_close");
    return { id: "bitcoin", label: "BTC", assetType: "crypto", currency: "USD", price: latest.close,
        previousClose: comparison.close, changePercent: changePercent(latest.close, comparison.close), quotedAt: latest.at, marketState: "open" };
}

async function getJson(url: URL, credentials: AlpacaCredentials, fetcher: typeof fetch, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
        response = await fetcher(url, { redirect: "manual", signal, headers: { Accept: "application/json",
            "APCA-API-KEY-ID": credentials.keyId, "APCA-API-SECRET-KEY": credentials.secretKey } });
    } catch { throw new ProviderError("provider_unavailable"); }
    if (response.status === 429) throw new ProviderError("rate_limited");
    if (response.status === 401 || response.status === 403) throw new ProviderError("provider_auth_failed");
    if (!response.ok) throw new ProviderError(response.status >= 500 ? "provider_unavailable" : "provider_rejected");
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 262144) { await reader.cancel(); throw new ProviderError("invalid_response"); }
            chunks.push(value);
        }
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(buffer));
    } catch (error) { throw error instanceof ProviderError ? error : new ProviderError("invalid_response"); }
    finally { reader.releaseLock(); }
}

export async function fetchAlpacaQuotes(credentials: AlpacaCredentials, fetcher: typeof fetch, clock: () => number) {
    if (!credentials.keyId || !credentials.secretKey) throw new ProviderError("missing_credentials");
    const stocks = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
    stocks.search = new URLSearchParams({ symbols: INSTRUMENTS.slice(1).map(q => q.providerSymbol).join(","), feed: "iex", currency: "USD" }).toString();
    const bitcoin = new URL("https://data.alpaca.markets/v1beta3/crypto/us/bars");
    // Include the UTC previous-close bar and current day in one bounded page.
    // Explicit 20-minute delay works without a paid recent-data entitlement.
    const now = clock(), dayStart = Math.floor(now / 86400) * 86400;
    bitcoin.search = new URLSearchParams({ symbols: "BTC/USD", timeframe: "5Min", start: new Date((dayStart - 172800) * 1000).toISOString(),
        end: new Date((now - 1200) * 1000).toISOString(), limit: "1000", sort: "asc" }).toString();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
    try {
        const results = await Promise.allSettled([getJson(stocks, credentials, fetcher, controller.signal), getJson(bitcoin, credentials, fetcher, controller.signal)]);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failures.length) throw (failures.find(r => r.reason instanceof ProviderError && r.reason.message === "rate_limited") ?? failures[0]).reason;
        const fetchedAt = clock();
        const values = results.map(r => (r as PromiseFulfilledResult<unknown>).value);
        return validateSnapshot({ version: 1, mode: "market", provider: "alpaca", priceBasis: "sampled-bars", fetchedAt,
            quotes: [normalizeBitcoin(values[1], fetchedAt), ...normalizeStocks(values[0], fetchedAt)] }, fetchedAt);
    } finally { clearTimeout(timer); controller.abort(); }
}
