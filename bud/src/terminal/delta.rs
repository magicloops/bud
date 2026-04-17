use serde_json::{json, Value};

use super::{
    AdditiveDeltaPayload, CaptureLogSummary, LOW_SIGNAL_SEPARATOR_MIN_RUN,
    MAX_CHANGED_WINDOW_LINES, MAX_VISIBLE_DELTA_BYTES, MAX_VISIBLE_DELTA_LINES,
};

pub(super) fn simple_hash(data: &[u8]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

pub(super) fn summarize_capture_for_log(content: &str, include_preview: bool) -> CaptureLogSummary {
    let lines: Vec<&str> = content.lines().collect();
    let line_count = lines.len();
    let last_non_empty_line = lines
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .copied()
        .unwrap_or_else(|| content.trim_end_matches(&['\r', '\n'][..]));

    CaptureLogSummary {
        hash: simple_hash(content.as_bytes()),
        line_count,
        last_non_empty_line: truncate_log_value(last_non_empty_line, 160),
        preview_head: include_preview.then(|| preview_lines(&lines, false)),
        preview_tail: include_preview.then(|| preview_lines(&lines, true)),
    }
}

pub(super) fn build_additive_delta_payload(
    baseline_capture: Option<&str>,
    current_capture: &str,
) -> AdditiveDeltaPayload {
    let current_lines: Vec<&str> = current_capture.lines().collect();
    let tail_fallback = |strategy: &'static str, changed: bool| {
        let excerpt = tail_excerpt_from_lines(&current_lines, MAX_VISIBLE_DELTA_LINES);
        let normalized_excerpt = strip_low_signal_delta_lines(&excerpt);
        let (text, truncated) =
            truncate_text_to_bytes(&normalized_excerpt, MAX_VISIBLE_DELTA_BYTES);
        AdditiveDeltaPayload {
            changed,
            text,
            truncated,
            strategy,
        }
    };

    let Some(baseline_capture) = baseline_capture else {
        if current_capture.is_empty() {
            return AdditiveDeltaPayload {
                changed: false,
                text: String::new(),
                truncated: false,
                strategy: "no_baseline_empty",
            };
        }
        return tail_fallback("initial_tail", true);
    };

    if baseline_capture == current_capture {
        return AdditiveDeltaPayload {
            changed: false,
            text: String::new(),
            truncated: false,
            strategy: "unchanged",
        };
    }

    let baseline_lines: Vec<&str> = baseline_capture.lines().collect();
    let prefix = common_prefix_line_count(&baseline_lines, &current_lines);
    let suffix = common_suffix_line_count(&baseline_lines, &current_lines, prefix);

    let current_middle_end = current_lines.len().saturating_sub(suffix);
    let current_middle = if prefix <= current_middle_end {
        &current_lines[prefix..current_middle_end]
    } else {
        &[][..]
    };

    let append_like = prefix == baseline_lines.len() && current_lines.len() >= baseline_lines.len();
    let mut strategy = "tail_fallback";
    let candidate = if append_like {
        strategy = "novel_suffix";
        current_lines[prefix..].join("\n")
    } else if !current_middle.is_empty()
        && (prefix > 0 || suffix > 0)
        && current_middle.len() <= MAX_CHANGED_WINDOW_LINES
    {
        strategy = "changed_window";
        current_middle.join("\n")
    } else if prefix < current_lines.len() {
        let suffix_candidate = current_lines[prefix..].join("\n");
        if !suffix_candidate.trim().is_empty()
            && suffix_candidate.lines().count() <= MAX_CHANGED_WINDOW_LINES * 2
        {
            strategy = "suffix_fallback";
            suffix_candidate
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let candidate = strip_low_signal_delta_lines(&candidate);
    if candidate.trim().is_empty() && !current_capture.is_empty() {
        return tail_fallback("tail_fallback", true);
    }

    let (text, truncated) = truncate_text_to_bytes(&candidate, MAX_VISIBLE_DELTA_BYTES);
    AdditiveDeltaPayload {
        changed: true,
        text,
        truncated,
        strategy,
    }
}

pub(super) fn build_delta_payload_json(delta: &AdditiveDeltaPayload) -> Value {
    json!({
        "changed": delta.changed,
        "text": delta.text,
        "truncated": delta.truncated,
    })
}

fn preview_lines(lines: &[&str], from_end: bool) -> String {
    let preview_count = 2;
    let selected: Vec<&str> = if from_end {
        lines
            .iter()
            .rev()
            .take(preview_count)
            .copied()
            .collect::<Vec<&str>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        lines.iter().take(preview_count).copied().collect()
    };
    truncate_log_value(&selected.join(" | "), 240)
}

fn truncate_log_value(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<&str>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let truncated: String = normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect();
    format!("{truncated}...")
}

fn tail_excerpt_from_lines(lines: &[&str], max_lines: usize) -> String {
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn is_low_signal_separator_line(line: &str) -> bool {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    if first.is_alphanumeric() || first.is_whitespace() {
        return false;
    }

    let mut count = 1;
    for ch in chars {
        if ch != first {
            return false;
        }
        count += 1;
    }

    count >= LOW_SIGNAL_SEPARATOR_MIN_RUN
}

fn strip_low_signal_delta_lines(text: &str) -> String {
    let filtered: Vec<&str> = text
        .lines()
        .filter(|line| !is_low_signal_separator_line(line))
        .collect();

    let Some(start) = filtered.iter().position(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let end = filtered
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .unwrap_or(start);

    filtered[start..=end].join("\n")
}

fn truncate_text_to_bytes(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }

    if max_bytes <= 3 {
        return ("...".chars().take(max_bytes).collect(), true);
    }

    let keep_bytes = max_bytes.saturating_sub(3);
    let mut start = text.len().saturating_sub(keep_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }

    (format!("...{}", &text[start..]), true)
}

fn common_prefix_line_count<'a>(baseline: &[&'a str], current: &[&'a str]) -> usize {
    let limit = baseline.len().min(current.len());
    let mut count = 0;
    while count < limit && baseline[count] == current[count] {
        count += 1;
    }
    count
}

fn common_suffix_line_count<'a>(baseline: &[&'a str], current: &[&'a str], prefix: usize) -> usize {
    let baseline_remaining = baseline.len().saturating_sub(prefix);
    let current_remaining = current.len().saturating_sub(prefix);
    let limit = baseline_remaining.min(current_remaining);
    let mut count = 0;
    while count < limit
        && baseline[baseline.len() - 1 - count] == current[current.len() - 1 - count]
    {
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::build_additive_delta_payload;

    #[test]
    fn additive_delta_prefers_novel_suffix_for_append_like_changes() {
        let delta = build_additive_delta_payload(Some("line 1\nline 2"), "line 1\nline 2\nline 3");

        assert!(delta.changed);
        assert_eq!(delta.text, "line 3");
        assert!(!delta.truncated);
        assert_eq!(delta.strategy, "novel_suffix");
    }

    #[test]
    fn additive_delta_uses_changed_window_for_localized_rewrite() {
        let delta = build_additive_delta_payload(
            Some("alpha\nbeta\ngamma\ndelta"),
            "alpha\nbeta updated\ngamma updated\ndelta",
        );

        assert!(delta.changed);
        assert_eq!(delta.text, "beta updated\ngamma updated");
        assert!(!delta.truncated);
        assert_eq!(delta.strategy, "changed_window");
    }

    #[test]
    fn additive_delta_falls_back_to_tail_for_large_repaint() {
        let baseline = (0..50)
            .map(|index| format!("before {index}"))
            .collect::<Vec<String>>()
            .join("\n");
        let current = (0..50)
            .map(|index| format!("after {index}"))
            .collect::<Vec<String>>()
            .join("\n");

        let delta = build_additive_delta_payload(Some(&baseline), &current);

        assert!(delta.changed);
        assert_eq!(delta.strategy, "tail_fallback");
        assert!(delta.text.contains("after 49"));
    }

    #[test]
    fn additive_delta_strips_low_signal_separator_lines() {
        let delta = build_additive_delta_payload(
            Some("ready"),
            "ready\n────────────────────────\nDo you want to proceed?",
        );

        assert!(delta.changed);
        assert_eq!(delta.text, "Do you want to proceed?");
        assert_eq!(delta.strategy, "novel_suffix");
    }

    #[test]
    fn additive_delta_preserves_single_separator_glyph_lines() {
        let delta = build_additive_delta_payload(Some("ready"), "ready\n─\nnext");

        assert!(delta.changed);
        assert_eq!(delta.text, "─\nnext");
        assert_eq!(delta.strategy, "novel_suffix");
    }
}
