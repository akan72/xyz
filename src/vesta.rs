//! Private KV reads and server-side board rendering; no public price API.
use serde::Deserialize;
use worker::*;

const KEY: &str = "vesta:display:v2";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketDisplay {
    version: u8,
    fetched_at: u64,
    board: Vec<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoDisplay {
    version: u8,
    fetched_at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum CachedDisplay {
    Market(MarketDisplay),
    Demo(DemoDisplay),
}

fn valid_timestamp(version: u8, fetched_at: u64, now: u64) -> bool {
    version == 2 && fetched_at > 0 && fetched_at <= now + 60
}

fn valid_board(board: &[Vec<u8>]) -> bool {
    board.len() == 6
        && board.iter().all(|row| {
            row.len() == 22
                && matches!(row[21], 63 | 66 | 70)
                && row[..21]
                    .iter()
                    .all(|code| matches!(code, 0..=36 | 40 | 44 | 46 | 54..=56))
        })
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

// Pure rendering helper; malformed displays/templates keep the static sample.
pub fn render_cached(html: &str, text: &str, now: u64) -> Option<String> {
    if text.len() > 32768 {
        return None;
    }
    let display = serde_json::from_str::<CachedDisplay>(text).ok()?;
    let market = match display {
        CachedDisplay::Market(market) => market,
        CachedDisplay::Demo(fallback) => {
            if !valid_timestamp(fallback.version, fallback.fetched_at, now) {
                return None;
            }
            // Keep the actual `vesta --demo` board and Sample Prices caption
            // already rendered by Astro; no demo price table is duplicated here.
            return Some(html.to_string());
        }
    };
    if !valid_timestamp(market.version, market.fetched_at, now) || !valid_board(&market.board) {
        return None;
    }
    let html = replace_section(html, BOARD_START, BOARD_END, &board_html(&market.board))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const TEMPLATE: &str = "before<!--vesta-board:start-->sample<!--vesta-board:end-->middle<!--vesta-sample:start-->Sample Prices<!--vesta-sample:end-->after";

    fn display() -> Value {
        let fixtures: Value =
            serde_json::from_str(include_str!("../scripts/fixtures/vesta-board.json")).unwrap();
        json!({ "version": 2, "mode": "market", "fetchedAt": 1000, "board": fixtures[0]["board"] })
    }

    #[test]
    fn renders_cli_board_and_removes_sample_caption() {
        let html = render_cached(TEMPLATE, &display().to_string(), 1000).unwrap();
        assert_eq!(html.matches("class=\"tile").count(), 132);
        assert!(html.contains("BTC     $83,436 +2.8%"));
        assert!(!html.contains("Sample Prices"));
        assert!(html.starts_with("before") && html.ends_with("after"));
    }

    #[test]
    fn demo_marker_keeps_original_cli_sample() {
        let marker = json!({ "version": 2, "mode": "demo", "fetchedAt": 1000 });
        assert_eq!(
            render_cached(TEMPLATE, &marker.to_string(), 1000).unwrap(),
            TEMPLATE
        );
    }

    #[test]
    fn rejects_wrong_dimensions_and_unsafe_codes() {
        for (row, col, value) in [(0, 0, 999), (0, 21, 40), (0, 1, 37)] {
            let mut data = display();
            data["board"][row][col] = json!(value);
            assert!(render_cached(TEMPLATE, &data.to_string(), 1000).is_none());
        }
        let mut data = display();
        data["board"][0].as_array_mut().unwrap().pop();
        assert!(render_cached(TEMPLATE, &data.to_string(), 1000).is_none());
        data["board"].as_array_mut().unwrap().pop();
        assert!(render_cached(TEMPLATE, &data.to_string(), 1000).is_none());
    }

    #[test]
    fn rejects_wrong_versions_and_future_timestamps() {
        for (version, fetched_at) in [(1, 1000), (2, 0), (2, 1061)] {
            let mut data = display();
            data["version"] = json!(version);
            data["fetchedAt"] = json!(fetched_at);
            assert!(render_cached(TEMPLATE, &data.to_string(), 1000).is_none());
        }
    }

    #[test]
    fn malformed_json_or_template_keeps_static_fallback() {
        assert!(render_cached(TEMPLATE, "not JSON", 1000).is_none());
        assert!(render_cached("no slots", &display().to_string(), 1000).is_none());
        assert!(render_cached(
            &format!("{TEMPLATE}{TEMPLATE}"),
            &display().to_string(),
            1000
        )
        .is_none());
    }
}
