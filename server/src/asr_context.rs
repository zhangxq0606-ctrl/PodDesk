//! Episode metadata turned into recogniser background context (rules only, no LLM).
use once_cell::sync::Lazy;
use regex::Regex;

pub const BUDGET_QWEN: usize = 1200;
pub const BUDGET_DOUBAO: usize = 700;
pub const BUDGET_PROMPT: usize = 160;

#[derive(Default, Clone, Debug)]
pub struct Meta {
    pub title: String,
    pub show: String,
    pub description: String,
    pub chapters: Vec<String>,
}

static TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(?:https?://|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b").unwrap());
static EMOJI: Lazy<Regex> = Lazy::new(|| Regex::new("[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B50}\u{2B06}]").unwrap());
static STAMP: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[^\d:])((?:\d{1,2}:)?\d{1,2}:\d{2}(?::\d{2})?)(?:$|[^\d:])").unwrap());
static HASHTAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"[#＃]([^\s#＃]+)").unwrap());
static BOILERPLATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)关注|订阅|转发|点赞|三连|投币|收藏|商务合作|合作联系|联系方式|微信|公众号|小红书|微博|抖音|赞助|广告|优惠|折扣|下载|APP|扫码|二维码|加群|入群|社群|版权|转载|免责|follow|subscribe|sponsor|patreon|discount|promo code|affiliate|business inquir|copyright|all rights|link in|click|my (?:course|book|newsletter)|instagram|twitter|facebook|tiktok|discord|spotify|apple podcasts").unwrap());
static BULLET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s\-–—•·*▪■●◆▶►>]+").unwrap());
static SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static WORDY: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w\u{4e00}-\u{9fff}]").unwrap());

fn unescape(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

pub fn clean_line(line: &str) -> String {
    let s = unescape(&TAGS.replace_all(&unescape(line), " "));
    let s = URL.replace_all(&s, " ");
    let s = EMOJI.replace_all(&s, " ");
    let s = HASHTAG.replace_all(&s, "$1");
    let s = STAMP.replace_all(&s, |c: &regex::Captures| c[0].replace(&c[1], " "));
    let s = BULLET.replace(&s, "");
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    SPACES.replace_all(&s, " ").trim_matches(|c: char| " \t|｜-–—:：,，;；".contains(c)).to_string()
}

pub fn clean_lines(text: &str) -> Vec<String> {
    let text = Regex::new(r"(?i)</(?:p|li|h\d|blockquote|div)>|<br\s*/?>")
        .unwrap()
        .replace_all(text, "\n");
    let mut seen = std::collections::HashSet::new();
    text.split(['\r', '\n'])
        .filter_map(|raw| {
            let line = clean_line(raw);
            if line.chars().count() < 2 || BOILERPLATE.is_match(&line) || !WORDY.is_match(&line) {
                return None;
            }
            let key: String = line.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
            seen.insert(key).then_some(line)
        })
        .collect()
}

fn compose(m: &Meta) -> (Vec<String>, Vec<String>, Vec<String>) {
    let head: Vec<String> = [clean_line(&m.title), clean_line(&m.show)].into_iter().filter(|x| !x.is_empty()).collect();
    let chapters = m.chapters.iter().take(40).map(|c| clean_line(c)).filter(|c| c.chars().count() >= 2).collect();
    (head, chapters, clean_lines(&m.description))
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub fn background(m: &Meta, limit: usize) -> String {
    let (head, chapters, description) = compose(m);
    let mut parts = Vec::new();
    if !head.is_empty() {
        parts.push(head.join("。"));
    }
    if !chapters.is_empty() {
        parts.push(format!("章节：{}", chapters.join("；")));
    }
    parts.extend(description);
    let mut out = String::new();
    for part in parts {
        let used = out.chars().count();
        if limit < used + 9 {
            break;
        }
        let room = limit - used - 1;
        if !out.is_empty() {
            out.push('\n');
        }
        if part.chars().count() <= room {
            out.push_str(&part);
        } else {
            out.push_str(&take_chars(&part, room - 1));
            out.push('…');
        }
    }
    out.trim().to_string()
}

pub fn prompt(m: &Meta, limit: usize) -> String {
    let (head, _, description) = compose(m);
    let lead = take_chars(&description.join(" "), limit);
    let tail = if head.is_empty() { String::new() } else { format!("{}。", head.join("。")) };
    let text = SPACES.replace_all(&format!("{lead} {tail}"), " ").trim().to_string();
    let n = text.chars().count();
    if n <= limit {
        text
    } else {
        format!("…{}", text.chars().skip(n - (limit - 1)).collect::<String>())
    }
}

pub fn doubao(m: &Meta, hotwords: &[String]) -> String {
    let text = background(m, BUDGET_DOUBAO);
    let words: Vec<serde_json::Value> = hotwords
        .iter()
        .filter(|w| {
            let n = w.chars().count();
            n >= 2 && if w.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) { n <= 10 } else { n <= 30 }
        })
        .take(100)
        .map(|w| serde_json::json!({ "word": w }))
        .collect();
    if text.is_empty() && words.is_empty() {
        return String::new();
    }
    let mut v = serde_json::json!({ "context_type": "dialog_ctx", "context_data": [{ "text": text }] });
    if !words.is_empty() {
        v["hotwords"] = serde_json::Value::Array(words);
    }
    v.to_string()
}

pub fn fits_language(text: &str, language: &str) -> bool {
    let total = text.chars().count();
    let cjk = text.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count() * 100 > total * 15;
    text.is_empty()
        || (language == "en" && !cjk)
        || (matches!(language, "zh" | "ja" | "ko") && cjk)
        || !matches!(language, "en" | "zh" | "ja" | "ko")
}

#[allow(dead_code)]
pub fn script_of(text: &str) -> &'static str {
    let total = text.chars().count().max(1);
    if text.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count() * 100 > total * 15 {
        "zh"
    } else {
        "en"
    }
}

pub fn is_echo(cue: &str, background: &str) -> bool {
    let norm = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let (c, b) = (norm(cue), norm(background));
    let n = c.chars().count();
    if n < 8 || b.is_empty() {
        return false;
    }
    let cs: Vec<char> = c.chars().collect();
    let grams: Vec<String> = cs.windows(4).map(|w| w.iter().collect()).collect();
    let hit = grams.iter().filter(|g| b.contains(g.as_str())).count();
    hit * 100 >= grams.len() * 60
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta {
            title: "EP12 曾鸣：AI 时代的组织".into(),
            show: "播客示例".into(),
            description: "<p>本期嘉宾：曾鸣，湖畔大学教育长</p><p>00:12 开场</p><p>关注我们的公众号获取更多</p><p>https://x.com/abc 链接</p><p>本期嘉宾：曾鸣，湖畔大学教育长</p><li>聊到 OpenAI 和 Anthropic 🚀</li>".into(),
            chapters: vec!["智能商业".into(), "".into()],
        }
    }

    #[test]
    fn cleans_notes() {
        let lines = clean_lines(&meta().description);
        assert_eq!(lines, vec!["本期嘉宾：曾鸣，湖畔大学教育长", "开场", "链接", "聊到 OpenAI 和 Anthropic"]);
    }

    #[test]
    fn background_puts_identity_first_and_fits() {
        let b = background(&meta(), BUDGET_QWEN);
        assert!(b.starts_with("EP12 曾鸣：AI 时代的组织。播客示例\n章节：智能商业"), "{b}");
        assert!(b.contains("曾鸣，湖畔大学"));
        assert!(background(&meta(), 30).chars().count() <= 30);
    }

    #[test]
    fn prompt_ends_with_the_title() {
        let p = prompt(&meta(), 40);
        assert!(p.chars().count() <= 40);
        assert!(p.ends_with("EP12 曾鸣：AI 时代的组织。播客示例。"), "{p}");
    }

    #[test]
    fn doubao_context_is_a_json_string() {
        let v: serde_json::Value = serde_json::from_str(&doubao(
            &meta(),
            &["曾鸣".into(), "Anthropic".into(), "这是一个超过十个字的中文热词啊".into()],
        ))
        .unwrap();
        assert_eq!(v["context_type"], "dialog_ctx");
        assert_eq!(v["hotwords"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn language_and_echo() {
        assert!(!fits_language("本期嘉宾：曾鸣，湖畔大学教育长", "en"));
        assert!(fits_language("Guest: Dario Amodei, CEO of Anthropic", "en"));
        assert!(fits_language("本期嘉宾：曾鸣", "zh"));
        assert!(is_echo("本期嘉宾曾鸣湖畔大学教育长", "EP12 曾鸣：AI 时代的组织。本期嘉宾：曾鸣，湖畔大学教育长"));
        assert!(!is_echo("我们今天聊一聊组织的变化", "EP12 曾鸣：AI 时代的组织。本期嘉宾：曾鸣，湖畔大学教育长"));
    }
}
