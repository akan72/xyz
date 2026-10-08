// Snapshot contract for the scheduled producer and private KV storage.
// Provider IDs are independent of the labels printed on the physical board.
export const INSTRUMENTS = [
    { id: "bitcoin", providerSymbol: "BTC-USD", label: "BTC", assetType: "crypto" },
    { id: "spcx", providerSymbol: "SPCX", label: "SPCX", assetType: "security" },
    { id: "gld", providerSymbol: "GLD", label: "GLD", assetType: "security" },
    { id: "goog", providerSymbol: "GOOG", label: "GOOG", assetType: "security" },
    { id: "meta", providerSymbol: "META", label: "META", assetType: "security" },
    { id: "vti", providerSymbol: "VTI", label: "VTI", assetType: "security" },
] as const;

export const SNAPSHOT_KEY = "vesta:latest:v1";
export const MAX_OPEN_BAR_AGE_SECONDS = 60 * 60;
export const MAX_QUOTE_AGE_SECONDS = 7 * 24 * 60 * 60;

// A fallback selects the CLI-generated sample HTML; it contains no sample values.
export interface DemoFallback {
    version: 1;
    mode: "demo";
    reason: "rate_limited";
    fetchedAt: number;
}

export interface Quote {
    id: string;
    label: string;
    assetType: "crypto" | "security";
    currency: "USD";
    price: number;
    previousClose: number;
    changePercent: number;
    quotedAt: number;
    marketState: "open" | "closed";
}

export interface Snapshot {
    version: 1;
    mode: "market";
    provider: "yahoo-finance" | "alpaca";
    fetchedAt: number;
    priceBasis: "5-minute-bars" | "sampled-bars";
    quotes: Quote[];
    board: number[][];
}

export function changePercent(price: number, previousClose: number): number {
    return (price - previousClose) / previousClose * 100;
}

// Python rounds the exact binary float to even on ties. Multiplying by 10
// first in JS changes some ties; decode the float to preserve CLI behavior.
export function roundDecimal(value: number, digits: number): number {
    if (!Number.isFinite(value)) throw new Error("invalid_number");
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Math.abs(value));
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 2047n);
    const fraction = bits & ((1n << 52n) - 1n);
    const mantissa = exponent === 0 ? fraction : fraction + (1n << 52n);
    const shift = exponent === 0 ? -1074 : exponent - 1023 - 52;
    let numerator = mantissa * 10n ** BigInt(digits);
    let denominator = 1n;
    if (shift >= 0) numerator <<= BigInt(shift);
    else denominator <<= BigInt(-shift);
    let rounded = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n)) rounded++;
    const result = Number(rounded) / 10 ** digits;
    return result === 0 ? 0 : Math.sign(value) * result;
}

const CHAR_CODES = Object.fromEntries([
    ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (char, i) => [char, i + 1]),
    ...Array.from("1234567890", (char, i) => [char, i + 27]),
    [" ", 0], ["$", 40], ["-", 44], ["+", 46], ["%", 54], [",", 55], [".", 56],
]) as Record<string, number>;

export function formatBoard(quotes: Pick<Quote, "label" | "price" | "changePercent">[]): number[][] {
    if (quotes.length !== 6) throw new Error("incomplete_snapshot");
    return quotes.map(({ label, price, changePercent }) => {
        if (!/^[A-Z0-9]{1,6}$/.test(label) || !Number.isFinite(price) || price <= 0) throw new Error("invalid_quote");
        const rounded = roundDecimal(changePercent, 1);
        const change = `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}%`;
        let amount = roundDecimal(price, price >= 100 ? 0 : 2).toFixed(price >= 100 ? 0 : 2);
        if (price >= 1000) amount = amount.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        const priceText = `$${amount}`;
        if (priceText.length > 8 || change.length > 6) throw new Error("board_overflow");
        const text = `${label.padEnd(6)} ${priceText.padStart(8)}${change.padStart(6)} `;
        const row = Array.from(text, (char) => CHAR_CODES[char]);
        row[21] = rounded > 0 ? 66 : rounded < 0 ? 63 : 70;
        if (row.length !== 22 || row.some((code) => code === undefined)) throw new Error("board_overflow");
        return row;
    });
}

// Reconstruct allowlisted fields; never forward arbitrary cached/provider JSON.
export function validateSnapshot(input: unknown, now = Math.floor(Date.now() / 1000)): Snapshot {
    if (!input || typeof input !== "object") throw new Error("invalid_snapshot");
    const data = input as Snapshot;
    if (data.version !== 1 || data.mode !== "market" || !((data.provider === "yahoo-finance" && data.priceBasis === "5-minute-bars") || (data.provider === "alpaca" && data.priceBasis === "sampled-bars"))
        || !Number.isSafeInteger(data.fetchedAt) || data.fetchedAt <= 0 || data.fetchedAt > now + 60
        || !Array.isArray(data.quotes) || data.quotes.length !== INSTRUMENTS.length) throw new Error("invalid_snapshot");
    const quotes = data.quotes.map((q, i): Quote => {
        const expected = INSTRUMENTS[i];
        if (!q || q.id !== expected.id || q.label !== expected.label || q.assetType !== expected.assetType || q.currency !== "USD"
            || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.previousClose) || q.previousClose <= 0
            || !Number.isFinite(q.changePercent) || Math.abs(q.changePercent - changePercent(q.price, q.previousClose)) > 1e-8
            || !Number.isSafeInteger(q.quotedAt) || q.quotedAt <= 0 || q.quotedAt > data.fetchedAt + 60
            || data.fetchedAt - q.quotedAt > MAX_QUOTE_AGE_SECONDS
            || (q.marketState !== "open" && q.marketState !== "closed")
            || (q.assetType === "crypto" && q.marketState !== "open")
            || (q.marketState === "open" && data.fetchedAt - q.quotedAt > MAX_OPEN_BAR_AGE_SECONDS)) throw new Error("invalid_quote");
        return { id: q.id, label: q.label, assetType: q.assetType, currency: "USD", price: q.price,
            previousClose: q.previousClose, changePercent: q.changePercent, quotedAt: q.quotedAt, marketState: q.marketState };
    });
    const board = formatBoard(quotes);
    if (data.board !== undefined && JSON.stringify(data.board) !== JSON.stringify(board)) throw new Error("invalid_board");
    return { version: 1, mode: "market", provider: data.provider, fetchedAt: data.fetchedAt, priceBasis: data.priceBasis, quotes, board };
}
