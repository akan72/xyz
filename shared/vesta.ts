// The site's private cache contains a display, not provider response data.
export const DISPLAY_KEY = "vesta:display:v2";
export const INSTRUMENTS = [
    { label: "BTC", symbol: "BTC/USD" },
    { label: "SPCX", symbol: "SPCX" },
    { label: "GLD", symbol: "GLD" },
    { label: "GOOG", symbol: "GOOG" },
    { label: "META", symbol: "META" },
    { label: "VTI", symbol: "VTI" },
] as const;

export type CachedDisplay =
    | { version: 2; mode: "market"; fetchedAt: number; board: number[][] }
    | { version: 2; mode: "demo"; fetchedAt: number };
