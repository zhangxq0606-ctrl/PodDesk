//! Subtitle formats (WebVTT, SRT, Podcasting 2.0 JSON, YouTube json3) and the clean-up that turns caption
//! fragments into readable sentences.
use crate::model::Segment;
use regex::Regex;

fn clock(stamp: &str) -> Option<f64> {
    let stamp = stamp.trim().replace(',', ".");
    let parts: Vec<&str> = stamp.split(':').collect();
    let mut total = 0.0;
    for p in &parts {
        total = total * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    if parts.len() > 3 { None } else { Some(total) }
}

fn strip_tags(text: &str) -> String {
    static TAG: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
    let t = TAG.replace_all(text, "");
    decode_entities(&t).split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn decode_entities(text: &str) -> String {
    static NUM: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap());
    let t = NUM.replace_all(text, |c: &regex::Captures| {
        let radix = if c[1].is_empty() { 10 } else { 16 };
        u32::from_str_radix(&c[2], radix).ok().and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_default()
    });
    t.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// WebVTT and SRT share the `start --> end` cue line.
pub fn parse_cues(body: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let body = body.replace("\r\n", "\n");
    for block in body.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(idx) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let mut it = lines[idx].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (clock(a), clock(b)) else { continue };
        let text = strip_tags(&lines[idx + 1..].join(" "));
        if !text.is_empty() {
            out.push(Segment { start, end, text });
        }
    }
    out
}

/// Podcasting 2.0 JSON transcript: {"segments":[{"startTime":..,"endTime":..,"body":".."}]}
pub fn parse_podcast_json(body: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return vec![] };
    v["segments"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let text = s["body"].as_str()?.trim().to_string();
                    let start = s["startTime"].as_f64()?;
                    let end = s["endTime"].as_f64().unwrap_or(start + 2.0);
                    (!text.is_empty()).then_some(Segment { start, end, text })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// YouTube timedtext: json3 events, or srv3/classic XML.
pub fn parse_youtube(body: &str) -> Vec<Segment> {
    let trimmed = body.trim();
    let mut out = Vec::new();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            for ev in v["events"].as_array().into_iter().flatten() {
                let Some(t) = ev["tStartMs"].as_f64() else { continue };
                let d = ev["dDurationMs"].as_f64().unwrap_or(0.0);
                let text: String = ev["segs"].as_array().into_iter().flatten().filter_map(|s| s["utf8"].as_str()).collect();
                let text = strip_tags(&text);
                if !text.is_empty() {
                    out.push(Segment { start: t / 1000.0, end: (t + d) / 1000.0, text });
                }
            }
        }
        return out;
    }
    static P: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r#"(?s)<(text|p)\b([^>]*)>(.*?)</(?:text|p)>"#).unwrap());
    static A: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| Regex::new(r#"\b(start|dur|t|d)="([\d.]+)""#).unwrap());
    for c in P.captures_iter(trimmed) {
        let classic = &c[1] == "text";
        let (mut start, mut dur) = (None, 0.0);
        for a in A.captures_iter(&c[2]) {
            let v: f64 = a[2].parse().unwrap_or(0.0);
            match &a[1] {
                "start" if classic => start = Some(v),
                "dur" if classic => dur = v,
                "t" if !classic => start = Some(v / 1000.0),
                "d" if !classic => dur = v / 1000.0,
                _ => {}
            }
        }
        let text = strip_tags(&c[3]);
        if let (Some(s), false) = (start, text.is_empty()) {
            out.push(Segment { start: s, end: s + dur, text });
        }
    }
    out
}

const HALLUCINATIONS: &[&str] = &[
    "谢谢观看", "感谢观看", "请不吝点赞", "字幕由", "字幕by", "订阅", "thanks for watching", "thank you for watching", "subtitles by", "amara.org",
];

pub fn clean(segments: Vec<Segment>) -> Vec<Segment> {
    static MUSIC: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"(?i)^\s*[\[\(（【]?\s*(music|音乐|applause|掌声|laughter|笑声|♪+)\s*[\]\)）】]?\s*$").unwrap());
    let mut out: Vec<Segment> = Vec::new();
    for s in segments {
        let text = s.text.replace('♪', "").replace("[]", "").replace("()", "").trim().to_string();
        if text.is_empty() || MUSIC.is_match(&text) {
            continue;
        }
        let low = text.to_lowercase();
        if s.end - s.start < 4.0 && text.chars().count() < 30 && HALLUCINATIONS.iter().any(|h| low.contains(h)) {
            continue;
        }
        if out.last().is_some_and(|p| p.text == text) {
            continue;
        }
        out.push(Segment { text, ..s });
    }
    out
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end().ends_with(['.', '?', '!', '。', '？', '！', '…', '"', '”'])
}

pub fn resegment(segments: Vec<Segment>) -> Vec<Segment> {
    let punctuated = segments.iter().filter(|s| ends_sentence(&s.text)).count() * 6 >= segments.len().max(1);
    let (max_len, max_secs) = if punctuated { (320, 30.0) } else { (180, 12.0) };
    let mut out: Vec<Segment> = Vec::new();
    let mut cur: Option<Segment> = None;
    for s in segments {
        match cur.as_mut() {
            Some(c) => {
                let gap = s.start - c.end;
                let cjk = s.text.chars().next().is_some_and(|ch| ch > '\u{2e80}');
                let too_long = c.text.chars().count() > max_len || s.end - c.start > max_secs;
                if (punctuated && ends_sentence(&c.text) && c.end - c.start > 1.2) || gap > 2.0 || too_long {
                    out.push(cur.take().unwrap());
                    cur = Some(s);
                } else {
                    if !cjk {
                        c.text.push(' ');
                    }
                    c.text.push_str(&s.text);
                    c.end = c.end.max(s.end);
                }
            }
            None => cur = Some(s),
        }
    }
    if let Some(c) = cur {
        out.push(c);
    }
    for i in 0..out.len().saturating_sub(1) {
        let next = out[i + 1].start;
        if out[i].end > next {
            out[i].end = next;
        }
    }
    out
}

#[allow(dead_code)]
pub fn split_timed(text: &str, start: f64, end: f64) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let mut raw: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let next = chars.get(i + 1).copied();
        let ends = match c {
            '。' | '？' | '！' | '；' => !matches!(next, Some('”' | '"')),
            '.' | '?' | '!' => next.is_none_or(char::is_whitespace),
            '"' | '”' => i > 0 && matches!(chars[i - 1], '.' | '?' | '!' | '。' | '？' | '！'),
            _ => false,
        };
        if ends {
            raw.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        raw.push(cur.trim().to_string());
    }
    let short = |t: &str| t.chars().count() < if t.chars().any(|c| c > '\u{2e80}') { 6 } else { 12 };
    let mut parts: Vec<String> = Vec::new();
    for r in raw.into_iter().filter(|r| !r.is_empty()) {
        match parts.last_mut() {
            Some(last) if short(&r) || short(last) => {
                if !last.ends_with(|c: char| c > '\u{2e80}') {
                    last.push(' ');
                }
                last.push_str(&r);
            }
            _ => parts.push(r),
        }
    }
    let total: usize = parts.iter().map(|p| p.chars().count()).sum::<usize>().max(1);
    let span = (end - start).max(0.0);
    let mut t = start;
    parts
        .into_iter()
        .map(|p| {
            let d = span * p.chars().count() as f64 / total as f64;
            let s = Segment { start: t, end: t + d, text: p };
            t += d;
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vtt() {
        let s = parse_cues("WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Joe>Hello there.\n\n2\n00:01:02,000 --> 00:01:04,000\nNext");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "Hello there.");
        assert!((s[1].start - 62.0).abs() < 1e-6);
    }

    #[test]
    fn srv3() {
        let s = parse_youtube(r#"<timedtext><body><p t="320" d="1000">[Music]</p><p t="18800" d="7160"><s>We&#39;re</s><s t="239"> no</s></p></body></timedtext>"#);
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].text, "We're no");
        assert_eq!(clean(s).len(), 1);
    }

    #[test]
    fn timed_split() {
        let s = split_timed("This is the first sentence. And a second one here? Yes. 第三句中文内容在这里。", 10.0, 40.0);
        assert_eq!(s.len(), 3);
        assert_eq!(s[1].text, "And a second one here? Yes.");
        assert!((s[0].start - 10.0).abs() < 1e-9 && (s[2].end - 40.0).abs() < 1e-6);
    }

    #[test]
    fn merge() {
        let segs = vec![
            Segment { start: 0.0, end: 2.0, text: "so what we found".into() },
            Segment { start: 2.0, end: 4.0, text: "is that it works".into() },
            Segment { start: 10.0, end: 12.0, text: "next idea".into() },
        ];
        let m = resegment(segs);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].text, "so what we found is that it works");
    }
}
