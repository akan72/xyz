//! Private KV reads and server-side board rendering; no public price API.
use serde::Deserialize;
use worker::*;

const KEY: &str = "vesta:latest:v1";
const EXPECTED: [(&str, &str, &str); 6] = [
    ("bitcoin", "BTC", "crypto"),
    ("spcx", "SPCX", "security"),
    ("gld", "GLD", "security"),
    ("goog", "GOOG", "security"),
    ("meta", "META", "security"),
    ("vti", "VTI", "security"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    id: String,
    label: String,
    asset_type: String,
    currency: String,
    price: f64,
    previous_close: f64,
    change_percent: f64,
    quoted_at: u64,
    market_state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    version: u8,
    provider: String,
    fetched_at: u64,
    price_basis: String,
    quotes: Vec<Quote>,
    board: Vec<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DemoFallback {
    version: u8,
    reason: String,
    fetched_at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum CachedDisplay {
    Market(Snapshot),
    Demo(DemoFallback),
}

fn valid(data: &Snapshot, now: u64) -> bool {
    if data.version != 1
        || !matches!(
            (data.provider.as_str(), data.price_basis.as_str()),
            ("yahoo-finance", "5-minute-bars") | ("alpaca", "sampled-bars")
        )
        || data.fetched_at == 0
        || data.fetched_at > now + 60
        || data.quotes.len() != 6
        || data.board.len() != 6
    {
        return false;
    }
    for (i, quote) in data.quotes.iter().enumerate() {
        let expected = EXPECTED[i];
        let row = &data.board[i];
        let change = (quote.price - quote.previous_close) / quote.previous_close * 100.0;
        if quote.id != expected.0
            || quote.label != expected.1
            || quote.asset_type != expected.2
            || quote.currency != "USD"
            || !quote.price.is_finite()
            || quote.price <= 0.0
            || !quote.previous_close.is_finite()
            || quote.previous_close <= 0.0
            || !quote.change_percent.is_finite()
            || (quote.change_percent - change).abs() > 1e-8
            || quote.quoted_at == 0
            || quote.quoted_at > data.fetched_at + 60
            || data.fetched_at.saturating_sub(quote.quoted_at) > 7 * 86400
            || !matches!(quote.market_state.as_str(), "open" | "closed")
            || (quote.asset_type == "crypto" && quote.market_state != "open")
            || (quote.market_state == "open"
                && data.fetched_at.saturating_sub(quote.quoted_at) > 3600)
            || row.len() != 22
            || !matches!(row[21], 63 | 66 | 70)
            || !row[..21]
                .iter()
                .all(|code| matches!(code, 0..=36 | 40 | 44 | 46 | 54..=56))
        {
            return false;
        }
    }
    true
}

const BOARD_START: &str = "<!--vesta-board:start-->";
const BOARD_END: &str = "<!--vesta-board:end-->";
const SAMPLE_START: &str = "<!--vesta-sample:start-->";
const SAMPLE_END: &str = "<!--vesta-sample:end-->";

pub fn enabled(env: &Env) -> bool {
    env.var("VESTA_LIVE_ENABLED")
        .ok()
        .is_some_and(|value| value.to_string() == "true")
}

fn cell(code: u8) -> char {
    match code {
        1..=26 => char::from(b'A' + code - 1),
        27..=35 => char::from(b'1' + code - 27),
        36 => '0',
        40 => '$',
        44 => '-',
        46 => '+',
        54 => '%',
        55 => ',',
        56 => '.',
        _ => ' ',
    }
}

fn board_html(board: &[Vec<u8>]) -> String {
    let label = board
        .iter()
        .map(|row| {
            row[..21]
                .iter()
                .map(|code| cell(*code))
                .collect::<String>()
                .trim()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("; ");
    // Every character and color comes from a fixed allowlist. No provider HTML
    // or cached strings are interpolated into attributes or markup.
    let mut html =
        format!(r#"<div class="board" role="img" aria-label="Vestaboard preview: {label}">"#);
    for row in board {
        for code in &row[..21] {
            html.push_str(&format!(r#"<span class="tile">{}</span>"#, cell(*code)));
        }
        let color = match row[21] {
            63 => "#eb4842",
            66 => "#51aa6a",
            _ => "#151515",
        };
        html.push_str(&format!(r#"<span class="tile chip" style="background:{color}" aria-label="Color chip {}"></span>"#, row[21]));
    }
    html.push_str("</div>");
    html
}

fn replace_section(html: &str, start: &str, end: &str, replacement: &str) -> Option<String> {
    // Fail closed if the template unexpectedly contains duplicate slots.
    if html.matches(start).count() != 1 || html.matches(end).count() != 1 {
        return None;
    }
    let from = html.find(start)?;
    let to = from + start.len() + html[from + start.len()..].find(end)? + end.len();
    Some(format!("{}{}{}", &html[..from], replacement, &html[to..]))
}

// Pure rendering helper; malformed snapshots/templates keep the static sample.
pub fn render_cached(html: &str, text: &str, now: u64) -> Option<String> {
    if text.len() > 32768 {
        return None;
    }
    let display = serde_json::from_str::<CachedDisplay>(text).ok()?;
    let snapshot = match display {
        CachedDisplay::Market(snapshot) => snapshot,
        CachedDisplay::Demo(fallback) => {
            if fallback.version != 1
                || fallback.reason != "rate_limited"
                || fallback.fetched_at == 0
                || fallback.fetched_at > now + 60
            {
                return None;
            }
            // Keep the actual `vesta --demo` board and Sample Prices caption
            // already rendered by Astro; no demo price table is duplicated here.
            return Some(html.to_string());
        }
    };
    if !valid(&snapshot, now) {
        return None;
    }
    let html = replace_section(html, BOARD_START, BOARD_END, &board_html(&snapshot.board))?;
    replace_section(&html, SAMPLE_START, SAMPLE_END, "")
}

pub async fn render(html: String, env: &Env) -> String {
    if !enabled(env) {
        return html;
    }
    // A KV binding is a private Cloudflare capability, not a public URL.
    // Missing/staging bindings never fall back to a production service.
    let Ok(kv) = env.kv("VESTA_PRICES") else {
        return html;
    };
    let Ok(Some(text)) = kv.get(KEY).text().await else {
        return html;
    };
    render_cached(&html, &text, Date::now().as_millis() / 1000).unwrap_or(html)
}
