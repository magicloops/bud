//! Pre-emulator raw-stream scanner: OSC 133 (FinalTerm command lifecycle),
//! OSC 7 (cwd), and alternate-screen switches (design D6a — deliberately
//! emulator-agnostic so a D5 change never touches semantics).
//!
//! Stateful across arbitrary chunk boundaries: a marker split anywhere (even
//! mid-escape, mid-UTF-8) must still be recognized — this is a hard requirement
//! with tests (the daemon feeds network-chunked bytes). Implementation may use
//! a dedicated `vte::Parser` with a custom `Perform`, or a hand-rolled matcher;
//! it must NOT allocate unboundedly on hostile input (cap OSC accumulation).
//!
//! Implementation: a dedicated `vte::Parser` (independent of the emulator's)
//! advanced one byte at a time so each dispatch callback knows the absolute
//! offset of the byte it fired on. `vte::Parser`'s OSC buffer is a fixed
//! 1024-byte inline array (`MAX_OSC_RAW`); bytes past the cap are dropped by
//! vte itself, so hostile unterminated OSC streams cannot OOM the scanner.
//!
//! Offset semantics: [`ScanEvent::at_offset`] is the offset of the byte AFTER
//! the sequence terminator. For BEL-terminated OSC that is the byte after the
//! `0x07`; for ST-terminated OSC, vte dispatches on the `ESC` of `ESC \`, so
//! the offset is dispatch-position + 2 (best effort if the input is malformed
//! and the `ESC` is not actually followed by `\`).

/// A semantic marker found in the stream, tagged with the absolute stream
/// offset of the byte AFTER the marker's terminator (i.e. where the region it
/// announces begins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanEvent {
    pub at_offset: u64,
    pub kind: ScanKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanKind {
    /// OSC 133;A — prompt start.
    PromptStart,
    /// OSC 133;B — command input start (user typing region).
    CommandInputStart,
    /// OSC 133;C — command output start.
    CommandOutputStart,
    /// OSC 133;D[;exit] — command finished.
    CommandEnd { exit_code: Option<i32> },
    /// OSC 7;file://host/path — cwd report (percent-decoded path).
    Cwd { path: String },
    /// DECSET ?1049h / ?47h / ?1047h.
    AltScreenEnter,
    /// DECRST ?1049l / ?47l / ?1047l.
    AltScreenLeave,
    /// DECSET/DECRST ?2004 — the application toggled bracketed paste. A
    /// mid-command ENABLE is a crisp "the child is interactive" signal
    /// (shells disable ?2004 while a foreground command runs).
    BracketedPasteSet { enabled: bool },
}

pub struct Scanner {
    parser: vte::Parser,
    perform: ScanPerform,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            parser: vte::Parser::new(),
            perform: ScanPerform::default(),
        }
    }

    /// Scan `bytes` whose first byte sits at absolute stream offset `base`.
    /// Returns events in stream order. Chunks MUST be fed in order without gaps
    /// (offsets are the session output stream's).
    pub fn scan(&mut self, base: u64, bytes: &[u8]) -> Vec<ScanEvent> {
        // Byte-by-byte so `Perform` callbacks know the exact position of the
        // byte that triggered the dispatch (vte exposes no position API).
        for (i, byte) in bytes.iter().enumerate() {
            self.perform.pos = base + i as u64;
            self.parser
                .advance(&mut self.perform, std::slice::from_ref(byte));
        }
        std::mem::take(&mut self.perform.events)
    }
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct ScanPerform {
    /// Absolute offset of the byte currently being fed to the parser.
    pos: u64,
    events: Vec<ScanEvent>,
}

impl ScanPerform {
    fn push(&mut self, at_offset: u64, kind: ScanKind) {
        self.events.push(ScanEvent { at_offset, kind });
    }
}

impl vte::Perform for ScanPerform {
    fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
        // BEL: dispatch fires on the 0x07 terminator itself → after = pos + 1.
        // ST: vte dispatches on the ESC of "ESC \" → after = pos + 2.
        let at = self.pos + if bell_terminated { 1 } else { 2 };
        let Some(first) = params.first() else { return };
        if *first == b"133" {
            // vte pre-splits OSC params on ';': "133;D;1" → ["133","D","1"].
            match params.get(1) {
                Some(p) if *p == b"A" => self.push(at, ScanKind::PromptStart),
                Some(p) if *p == b"B" => self.push(at, ScanKind::CommandInputStart),
                Some(p) if *p == b"C" => self.push(at, ScanKind::CommandOutputStart),
                Some(p) if *p == b"D" => {
                    let exit_code = params
                        .get(2)
                        .and_then(|c| std::str::from_utf8(c).ok())
                        .and_then(|s| s.trim().parse::<i32>().ok());
                    self.push(at, ScanKind::CommandEnd { exit_code });
                }
                _ => {}
            }
        } else if *first == b"7" {
            // Re-join remaining params: the path itself may contain ';'.
            let url = params[1..]
                .iter()
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect::<Vec<_>>()
                .join(";");
            if let Some(path) = file_url_path(&url) {
                self.push(at, ScanKind::Cwd { path });
            }
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        // DECSET/DECRST private modes: CSI ? <params> h|l. The '?' private
        // marker arrives via `intermediates`. Params may be multiple
        // (e.g. "?1049;2004h").
        if ignore || intermediates.len() != 1 || intermediates[0] != b'?' {
            return;
        }
        let enabled = match action {
            'h' => true,
            'l' => false,
            _ => return,
        };
        let kind = if enabled {
            ScanKind::AltScreenEnter
        } else {
            ScanKind::AltScreenLeave
        };
        // Dispatch fires on the final byte → after-terminator = pos + 1.
        let at = self.pos + 1;
        for param in params.iter() {
            match param.first().copied() {
                Some(47 | 1047 | 1049) => self.push(at, kind.clone()),
                Some(2004) => self.push(at, ScanKind::BracketedPasteSet { enabled }),
                _ => {}
            }
        }
    }
}

/// Best-effort `file://` URL → percent-decoded path. Tolerates `file://host/p`,
/// `file:///p` (empty host), and `file:/p`; a bare path with no scheme is
/// accepted as-is. Returns `None` when no path component survives.
fn file_url_path(url: &str) -> Option<String> {
    let raw = if let Some(rest) = url.strip_prefix("file://") {
        // rest = "host/path" or "/path" (empty host); drop the authority.
        match rest.find('/') {
            Some(idx) => &rest[idx..],
            None => "",
        }
    } else if let Some(rest) = url.strip_prefix("file:") {
        rest
    } else {
        url
    };
    if raw.is_empty() {
        return None;
    }
    Some(percent_decode(raw))
}

/// Decode `%XX` escapes to bytes, then interpret as UTF-8 (lossy).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_all(bytes: &[u8]) -> Vec<ScanEvent> {
        Scanner::new().scan(0, bytes)
    }

    #[test]
    fn osc133_bel_terminated_offset() {
        // "\x1b]133;A\x07" is 8 bytes; the byte after the BEL is offset 8.
        let events = scan_all(b"\x1b]133;A\x07next");
        assert_eq!(
            events,
            vec![ScanEvent {
                at_offset: 8,
                kind: ScanKind::PromptStart
            }]
        );
    }

    #[test]
    fn osc133_st_terminated_offset() {
        // "\x1b]133;B\x1b\\" is 9 bytes; the byte after ESC \ is offset 9.
        let events = scan_all(b"\x1b]133;B\x1b\\next");
        assert_eq!(
            events,
            vec![ScanEvent {
                at_offset: 9,
                kind: ScanKind::CommandInputStart
            }]
        );
    }

    #[test]
    fn osc133_d_with_and_without_exit_code() {
        let events = scan_all(b"\x1b]133;D;1\x07\x1b]133;D\x07\x1b]133;D;0\x1b\\");
        assert_eq!(
            events.iter().map(|e| &e.kind).collect::<Vec<_>>(),
            vec![
                &ScanKind::CommandEnd { exit_code: Some(1) },
                &ScanKind::CommandEnd { exit_code: None },
                &ScanKind::CommandEnd { exit_code: Some(0) },
            ]
        );
        // Unparsable exit code degrades to None.
        let events = scan_all(b"\x1b]133;D;xyz\x07");
        assert_eq!(events[0].kind, ScanKind::CommandEnd { exit_code: None });
    }

    #[test]
    fn osc133_extra_params_on_a_are_tolerated() {
        // FinalTerm extensions like "A;cl=m" still mean prompt start.
        let events = scan_all(b"\x1b]133;A;cl=m\x07");
        assert_eq!(events[0].kind, ScanKind::PromptStart);
    }

    #[test]
    fn osc133_c_marker() {
        let events = scan_all(b"\x1b]133;C\x07");
        assert_eq!(events[0].kind, ScanKind::CommandOutputStart);
        assert_eq!(events[0].at_offset, 8);
    }

    #[test]
    fn osc7_variants() {
        let cases: &[(&[u8], &str)] = &[
            (
                b"\x1b]7;file://myhost/Users/adam/proj\x07",
                "/Users/adam/proj",
            ),
            (b"\x1b]7;file:///Users/adam\x07", "/Users/adam"),
            (b"\x1b]7;file:/Users/adam\x07", "/Users/adam"),
            (b"\x1b]7;/plain/path\x07", "/plain/path"),
            (b"\x1b]7;file://h/with%20space/a%2Fb\x07", "/with space/a/b"),
        ];
        for (bytes, expected) in cases {
            let events = scan_all(bytes);
            assert_eq!(
                events,
                vec![ScanEvent {
                    at_offset: bytes.len() as u64,
                    kind: ScanKind::Cwd {
                        path: (*expected).into()
                    }
                }],
                "input {:?}",
                String::from_utf8_lossy(bytes)
            );
        }
        // Path containing ';' survives vte's param splitting via re-join.
        let events = scan_all(b"\x1b]7;file://h/a;b/c\x07");
        assert_eq!(
            events[0].kind,
            ScanKind::Cwd {
                path: "/a;b/c".into()
            }
        );
        // No path at all: no event.
        assert!(scan_all(b"\x1b]7;file://\x07").is_empty());
        assert!(scan_all(b"\x1b]7;\x07").is_empty());
    }

    #[test]
    fn altscreen_decset_decrst_all_forms() {
        for (bytes, kind) in [
            (b"\x1b[?1049h".as_slice(), ScanKind::AltScreenEnter),
            (b"\x1b[?1049l", ScanKind::AltScreenLeave),
            (b"\x1b[?1047h", ScanKind::AltScreenEnter),
            (b"\x1b[?1047l", ScanKind::AltScreenLeave),
            (b"\x1b[?47h", ScanKind::AltScreenEnter),
            (b"\x1b[?47l", ScanKind::AltScreenLeave),
        ] {
            let events = scan_all(bytes);
            assert_eq!(
                events,
                vec![ScanEvent {
                    at_offset: bytes.len() as u64,
                    kind: kind.clone()
                }],
                "input {:?}",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    #[test]
    fn altscreen_multi_param_decset() {
        // vim commonly sets several private modes in one CSI.
        let events = scan_all(b"\x1b[?1049;2004h");
        assert_eq!(
            events,
            vec![
                ScanEvent {
                    at_offset: 13,
                    kind: ScanKind::AltScreenEnter
                },
                ScanEvent {
                    at_offset: 13,
                    kind: ScanKind::BracketedPasteSet { enabled: true }
                },
            ]
        );
        // Bracketed paste toggles are reported on their own (mid-command
        // enable = interactivity signal); other private modes stay silent.
        assert_eq!(
            scan_all(b"\x1b[?2004h\x1b[?1h\x1b[?25l"),
            vec![ScanEvent {
                at_offset: 8,
                kind: ScanKind::BracketedPasteSet { enabled: true }
            }]
        );
        // Non-private CSI with the same numbers: nothing.
        assert!(scan_all(b"\x1b[1049h").is_empty());
    }

    #[test]
    fn plain_text_and_unrelated_sequences_yield_nothing() {
        assert!(scan_all(b"hello world\r\n\x1b[31mred\x1b[0m\x1b]0;title\x07").is_empty());
    }

    #[test]
    fn split_at_every_boundary_matches_whole_feed() {
        let input: &[u8] =
            b"pre\x1b]133;A\x07mid\x1b[?1049h\x1b]7;file:///tmp\x1b\\post\x1b]133;D;7\x07";
        let expected = scan_all(input);
        assert_eq!(expected.len(), 4);
        for split in 0..=input.len() {
            let mut scanner = Scanner::new();
            let mut events = scanner.scan(0, &input[..split]);
            events.extend(scanner.scan(split as u64, &input[split..]));
            assert_eq!(events, expected, "split at {split}");
        }
        // One-byte-at-a-time feed.
        let mut scanner = Scanner::new();
        let mut events = Vec::new();
        for (i, b) in input.iter().enumerate() {
            events.extend(scanner.scan(i as u64, std::slice::from_ref(b)));
        }
        assert_eq!(events, expected);
    }

    #[test]
    fn nonzero_base_offsets() {
        let mut scanner = Scanner::new();
        let events = scanner.scan(1000, b"\x1b]133;A\x07");
        assert_eq!(events[0].at_offset, 1008);
    }

    #[test]
    fn hostile_unterminated_osc_does_not_blow_up() {
        // vte caps OSC accumulation at its fixed 1024-byte internal buffer;
        // a megabyte of unterminated OSC payload must complete and yield
        // nothing (and, once finally terminated, must not misreport).
        let mut scanner = Scanner::new();
        let mut junk = b"\x1b]133;".to_vec();
        junk.extend(std::iter::repeat_n(b'x', 1_000_000));
        assert!(scanner.scan(0, &junk).is_empty());
        let events = scanner.scan(junk.len() as u64, b"\x07\x1b]133;A\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, ScanKind::PromptStart);
    }
}
