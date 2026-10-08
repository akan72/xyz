import assert from "node:assert/strict";
import test from "node:test";
import { fetchAlpacaQuotes, normalizeBitcoin, normalizeStocks } from "../workers/vesta/alpaca.ts";
import { refreshOnce } from "../workers/vesta/prices.ts";
import { INSTRUMENTS, SNAPSHOT_KEY } from "../shared/vesta.ts";

const at = Date.parse("2026-10-08T18:47:00Z") / 1000;
const credentials = { keyId: "fixture-key", secretKey: "fixture-secret" };
const crypto = { bars: { "BTC/USD": [
    { t: "2026-10-07T23:55:00Z", c: 80000 },
    { t: "2026-10-08T18:25:00Z", c: 84000 },
] }, next_page_token: null };
const stocks = Object.fromEntries(INSTRUMENTS.slice(1).map(i => [i.label, {
    minuteBar: { t: "2026-10-08T18:45:00Z", c: 110 },
    prevDailyBar: { t: "2026-10-07T04:00:00Z", c: 100 },
}]));

function storage() {
    const data = new Map<string, unknown>();
    return {
        async get<T>(key: string): Promise<T | undefined> { return data.get(key) as T | undefined; },
        async put(key: string, value: unknown): Promise<void> { data.set(key, value); },
    };
}

test("Alpaca authenticates only to its fixed origin and batches six quotes into two requests", async () => {
    const requested: URL[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        requested.push(url);
        assert.equal(url.origin, "https://data.alpaca.markets");
        assert.equal(init?.redirect, "manual");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("APCA-API-KEY-ID"), credentials.keyId);
        assert.equal(headers.get("APCA-API-SECRET-KEY"), credentials.secretKey);
        return Response.json(url.pathname.includes("/stocks/") ? stocks : crypto);
    };
    const result = await fetchAlpacaQuotes(credentials, fetcher, () => at);
    assert.equal(requested.length, 2);
    assert.equal(requested[0].searchParams.get("symbols"), "SPCX,GLD,GOOG,META,VTI");
    assert.equal(requested[1].searchParams.get("symbols"), "BTC/USD");
    assert.equal(result.board.length, 6);
    assert.ok(result.board.every(row => row.length === 22));
    assert.equal(result.quotes[0].price, 84000);
});

test("delayed Bitcoin bars use the sampled UTC day across midnight", () => {
    const now = Date.parse("2026-10-09T00:17:00Z") / 1000;
    const result = normalizeBitcoin({ bars: { "BTC/USD": [
        { t: "2026-10-07T23:55:00Z", c: 80000 },
        { t: "2026-10-08T23:55:00Z", c: 84000 },
    ] } }, now);
    assert.equal(result.changePercent, 5);
});

test("incomplete stock batches and crypto pages cannot publish a partial board", () => {
    assert.throws(() => normalizeStocks({}, at));
    assert.throws(() => normalizeBitcoin({ ...crypto, next_page_token: "more" }, at));
    assert.throws(() => normalizeBitcoin({ bars: { "BTC/USD": [crypto.bars["BTC/USD"][1]] } }, at));
});

test("scheduled duplicate deliveries do not call the provider twice", async () => {
    const state = storage(), publications: string[] = [];
    let requests = 0;
    const kv = { async put(key: string, value: string) { assert.equal(key, SNAPSHOT_KEY); publications.push(value); } };
    const fetcher: typeof fetch = async input => {
        requests++;
        return Response.json(String(input).includes("/stocks/") ? stocks : crypto);
    };
    assert.equal(await refreshOnce(state, kv, at, credentials, fetcher, () => at), "updated");
    await refreshOnce(state, kv, at, credentials, fetcher, () => at);
    assert.equal(requests, 2);
    assert.equal(publications.length, 1);
});

test("429 publishes only a demo marker and persisted cooldown prevents further requests", async () => {
    const state = storage(), publications: string[] = [];
    let requests = 0;
    const kv = { async put(_key: string, value: string) { publications.push(value); } };
    const fetcher: typeof fetch = async () => { requests++; return new Response(null, { status: 429 }); };
    assert.equal(await refreshOnce(state, kv, at, credentials, fetcher, () => at), "rate_limited");
    assert.equal(JSON.parse(publications[0]).mode, "demo");
    assert.equal("quotes" in JSON.parse(publications[0]), false);
    assert.equal(await refreshOnce(state, kv, at + 1800, credentials, fetcher, () => at + 1800), "cooldown");
    assert.equal(requests, 2);
});

test("authentication failures preserve the published display", async () => {
    const state = storage(), publications: string[] = [];
    const kv = { async put(_key: string, value: string) { publications.push(value); } };
    const result = await refreshOnce(state, kv, at, credentials, async () => new Response(null, { status: 401 }), () => at);
    assert.equal(result, "provider_auth_failed");
    assert.equal(publications.length, 0);
});
