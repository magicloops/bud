//! Semantic key names → PTY byte sequences (design D9). Replaces tmux
//! `send-keys` vocabulary. Mode-aware via [`crate::emu::KeyModes`] (DECCKM
//! application cursor keys, keypad). Multi-line literal text should be sent
//! via [`encode_paste`] so bracketed-paste-aware apps (and REPLs) receive it
//! atomically instead of as synthesized Enter presses.
//!
//! Notes on mode handling:
//! - Arrows and Home/End honor DECCKM (`application_cursor`): SS3 (`ESC O x`)
//!   when set, CSI (`ESC [ x`) otherwise.
//! - `application_keypad` (DECPAM/DECPNM) only affects *numpad* keys, which
//!   the [`Key`] vocabulary does not currently expose; the flag is plumbed so
//!   numpad keys can be added without an API change.

use crate::emu::KeyModes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Enter,
    Tab,
    BackTab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    /// Ctrl+<ascii letter or symbol>, lowercase canonical (`Ctrl('c')`).
    Ctrl(char),
    /// Alt/Meta+<char> (ESC prefix encoding).
    Alt(char),
    /// F1–F12.
    F(u8),
    Space,
}

/// Parse backend-neutral names: `enter`, `escape`, `tab`, `shift+tab`, `up`,
/// `pageup`/`page_up`, `f5`, `ctrl+c`, `alt+x`, `delete`, `space`, …
/// Case-insensitive; `C-c`-style tmux notation is NOT accepted (that vocabulary
/// dies with the tmux backend). Bare single characters are NOT keys — literal
/// text goes through [`encode_paste`].
///
/// Accepted aliases: `return` (Enter), `esc` (Escape), `del` (Delete),
/// `shift+tab`/`backtab` (BackTab), `pgup`/`page_up` (PageUp),
/// `pgdn`/`page_down` (PageDown), `control+` (`ctrl+`), `meta+` (`alt+`).
pub fn parse_key_name(name: &str) -> Option<Key> {
    let name = name.trim().to_ascii_lowercase();
    let key = match name.as_str() {
        "enter" | "return" => Key::Enter,
        "tab" => Key::Tab,
        "backtab" | "shift+tab" => Key::BackTab,
        "backspace" => Key::Backspace,
        "escape" | "esc" => Key::Escape,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" | "pgup" => Key::PageUp,
        "pagedown" | "page_down" | "pgdn" => Key::PageDown,
        "insert" => Key::Insert,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        other => {
            if let Some(rest) = other
                .strip_prefix("ctrl+")
                .or_else(|| other.strip_prefix("control+"))
            {
                return parse_mod_char(rest).map(Key::Ctrl);
            }
            if let Some(rest) = other
                .strip_prefix("alt+")
                .or_else(|| other.strip_prefix("meta+"))
            {
                return parse_mod_char(rest).map(Key::Alt);
            }
            if let Some(n) = other.strip_prefix('f') {
                let n: u8 = n.parse().ok()?;
                if (1..=12).contains(&n) {
                    return Some(Key::F(n));
                }
            }
            return None;
        }
    };
    Some(key)
}

/// The `<char>` half of `ctrl+<char>` / `alt+<char>`: a single character, or
/// the word `space`.
fn parse_mod_char(rest: &str) -> Option<char> {
    if rest == "space" {
        return Some(' ');
    }
    let mut chars = rest.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some(c)
}

/// Encode a key under the given terminal modes.
pub fn encode_key(key: Key, modes: KeyModes) -> Vec<u8> {
    match key {
        Key::Enter => vec![b'\r'],
        Key::Tab => vec![b'\t'],
        Key::BackTab => b"\x1b[Z".to_vec(),
        Key::Backspace => vec![0x7f],
        Key::Escape => vec![0x1b],
        Key::Space => vec![b' '],
        Key::Up => cursor_key(b'A', modes),
        Key::Down => cursor_key(b'B', modes),
        Key::Right => cursor_key(b'C', modes),
        Key::Left => cursor_key(b'D', modes),
        Key::Home => cursor_key(b'H', modes),
        Key::End => cursor_key(b'F', modes),
        Key::PageUp => b"\x1b[5~".to_vec(),
        Key::PageDown => b"\x1b[6~".to_vec(),
        Key::Insert => b"\x1b[2~".to_vec(),
        Key::Delete => b"\x1b[3~".to_vec(),
        Key::F(n) => fn_key(n),
        Key::Ctrl(c) => ctrl_key(c),
        Key::Alt(c) => {
            let mut out = vec![0x1b];
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            out
        }
    }
}

/// Arrows and Home/End: SS3 under DECCKM application cursor mode, CSI otherwise.
fn cursor_key(final_byte: u8, modes: KeyModes) -> Vec<u8> {
    if modes.application_cursor {
        vec![0x1b, b'O', final_byte]
    } else {
        vec![0x1b, b'[', final_byte]
    }
}

/// F1–F4 are SS3 `OP`..`OS`; F5+ are CSI `<n>~` with the xterm numbering gaps.
fn fn_key(n: u8) -> Vec<u8> {
    match n {
        1 => b"\x1bOP".to_vec(),
        2 => b"\x1bOQ".to_vec(),
        3 => b"\x1bOR".to_vec(),
        4 => b"\x1bOS".to_vec(),
        5 => b"\x1b[15~".to_vec(),
        6 => b"\x1b[17~".to_vec(),
        7 => b"\x1b[18~".to_vec(),
        8 => b"\x1b[19~".to_vec(),
        9 => b"\x1b[20~".to_vec(),
        10 => b"\x1b[21~".to_vec(),
        11 => b"\x1b[23~".to_vec(),
        12 => b"\x1b[24~".to_vec(),
        // Out of the F1-F12 vocabulary; nothing sane to emit.
        _ => Vec::new(),
    }
}

/// Ctrl chords: letters mask to C0 (`c & 0x1f`); the standard punctuation
/// mappings cover the rest of the C0 range. Characters with no control
/// mapping pass through unmodified (no chord synthesized).
fn ctrl_key(c: char) -> Vec<u8> {
    let c = c.to_ascii_lowercase();
    match c {
        ' ' | '@' => vec![0x00],
        '[' => vec![0x1b],
        '\\' => vec![0x1c],
        ']' => vec![0x1d],
        '^' => vec![0x1e],
        '_' | '/' => vec![0x1f],
        '?' => vec![0x7f],
        'a'..='z' => vec![c as u8 & 0x1f],
        other => {
            let mut buf = [0u8; 4];
            other.encode_utf8(&mut buf).as_bytes().to_vec()
        }
    }
}

/// Encode literal text for the PTY. Wraps in `ESC[200~ … ESC[201~` when the
/// application has bracketed paste on AND the text is multi-line or
/// `force_paste` is set. Normalizes `\n` → `\r` outside bracketed paste
/// (terminal Enter is CR).
pub fn encode_paste(text: &str, modes: KeyModes, force_paste: bool) -> Vec<u8> {
    let multi_line = text.contains('\n') || text.contains('\r');
    if modes.bracketed_paste && (multi_line || force_paste) {
        let mut out = Vec::with_capacity(text.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        // \r\n and \n both become a single \r (terminal Enter).
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn km(application_cursor: bool, application_keypad: bool, bracketed_paste: bool) -> KeyModes {
        KeyModes {
            application_cursor,
            application_keypad,
            bracketed_paste,
        }
    }

    #[test]
    fn parse_named_keys() {
        let table: &[(&str, Key)] = &[
            ("enter", Key::Enter),
            ("ENTER", Key::Enter),
            ("return", Key::Enter),
            ("tab", Key::Tab),
            ("backtab", Key::BackTab),
            ("shift+tab", Key::BackTab),
            ("Shift+Tab", Key::BackTab),
            ("backspace", Key::Backspace),
            ("escape", Key::Escape),
            ("esc", Key::Escape),
            ("up", Key::Up),
            ("down", Key::Down),
            ("left", Key::Left),
            ("right", Key::Right),
            ("home", Key::Home),
            ("end", Key::End),
            ("pageup", Key::PageUp),
            ("page_up", Key::PageUp),
            ("pgup", Key::PageUp),
            ("pagedown", Key::PageDown),
            ("page_down", Key::PageDown),
            ("pgdn", Key::PageDown),
            ("insert", Key::Insert),
            ("delete", Key::Delete),
            ("del", Key::Delete),
            ("space", Key::Space),
            ("f1", Key::F(1)),
            ("F5", Key::F(5)),
            ("f12", Key::F(12)),
            ("ctrl+c", Key::Ctrl('c')),
            ("CTRL+C", Key::Ctrl('c')),
            ("control+c", Key::Ctrl('c')),
            ("ctrl+space", Key::Ctrl(' ')),
            ("ctrl+[", Key::Ctrl('[')),
            ("alt+x", Key::Alt('x')),
            ("meta+x", Key::Alt('x')),
            ("alt+space", Key::Alt(' ')),
            (" enter ", Key::Enter),
        ];
        for (name, expected) in table {
            assert_eq!(parse_key_name(name), Some(*expected), "name {name:?}");
        }
    }

    #[test]
    fn parse_rejections() {
        // tmux C-c notation, bare chars, unknown names, out-of-range F keys.
        for bad in [
            "C-c", "M-x", "c", "x", "", "ctrl+", "ctrl+ab", "alt+", "f0", "f13", "f99", "shift+a",
            "super+x", "enter+", "ctrl-c",
        ] {
            assert_eq!(parse_key_name(bad), None, "name {bad:?}");
        }
    }

    #[test]
    fn encode_simple_keys() {
        let m = km(false, false, false);
        let table: &[(Key, &[u8])] = &[
            (Key::Enter, b"\r"),
            (Key::Tab, b"\t"),
            (Key::BackTab, b"\x1b[Z"),
            (Key::Backspace, b"\x7f"),
            (Key::Escape, b"\x1b"),
            (Key::Space, b" "),
            (Key::PageUp, b"\x1b[5~"),
            (Key::PageDown, b"\x1b[6~"),
            (Key::Insert, b"\x1b[2~"),
            (Key::Delete, b"\x1b[3~"),
        ];
        for (key, expected) in table {
            assert_eq!(encode_key(*key, m), *expected, "key {key:?}");
        }
    }

    #[test]
    fn encode_cursor_keys_honor_decckm() {
        let normal = km(false, false, false);
        let app = km(true, false, false);
        let table: &[(Key, &[u8], &[u8])] = &[
            (Key::Up, b"\x1b[A", b"\x1bOA"),
            (Key::Down, b"\x1b[B", b"\x1bOB"),
            (Key::Right, b"\x1b[C", b"\x1bOC"),
            (Key::Left, b"\x1b[D", b"\x1bOD"),
            (Key::Home, b"\x1b[H", b"\x1bOH"),
            (Key::End, b"\x1b[F", b"\x1bOF"),
        ];
        for (key, csi, ss3) in table {
            assert_eq!(encode_key(*key, normal), *csi, "key {key:?} normal");
            assert_eq!(encode_key(*key, app), *ss3, "key {key:?} app-cursor");
        }
        // Non-cursor keys are unaffected by DECCKM.
        assert_eq!(encode_key(Key::PageUp, app), b"\x1b[5~");
    }

    #[test]
    fn encode_function_keys() {
        let m = km(false, false, false);
        let table: &[(u8, &[u8])] = &[
            (1, b"\x1bOP"),
            (2, b"\x1bOQ"),
            (3, b"\x1bOR"),
            (4, b"\x1bOS"),
            (5, b"\x1b[15~"),
            (6, b"\x1b[17~"),
            (7, b"\x1b[18~"),
            (8, b"\x1b[19~"),
            (9, b"\x1b[20~"),
            (10, b"\x1b[21~"),
            (11, b"\x1b[23~"),
            (12, b"\x1b[24~"),
        ];
        for (n, expected) in table {
            assert_eq!(encode_key(Key::F(*n), m), *expected, "F{n}");
        }
        assert!(encode_key(Key::F(13), m).is_empty());
    }

    #[test]
    fn encode_ctrl_chords() {
        let m = km(false, false, false);
        let table: &[(char, &[u8])] = &[
            ('a', b"\x01"),
            ('c', b"\x03"),
            ('z', b"\x1a"),
            ('C', b"\x03"), // uppercase normalizes
            (' ', b"\x00"),
            ('@', b"\x00"),
            ('[', b"\x1b"),
            ('\\', b"\x1c"),
            (']', b"\x1d"),
            ('^', b"\x1e"),
            ('_', b"\x1f"),
            ('/', b"\x1f"),
            ('?', b"\x7f"),
        ];
        for (c, expected) in table {
            assert_eq!(encode_key(Key::Ctrl(*c), m), *expected, "ctrl+{c:?}");
        }
        // No control mapping: passes through.
        assert_eq!(encode_key(Key::Ctrl('1'), m), b"1");
    }

    #[test]
    fn encode_alt_chords() {
        let m = km(false, false, false);
        assert_eq!(encode_key(Key::Alt('x'), m), b"\x1bx");
        assert_eq!(encode_key(Key::Alt('b'), m), b"\x1bb");
        // Multi-byte char after ESC prefix.
        assert_eq!(encode_key(Key::Alt('é'), m), b"\x1b\xc3\xa9");
    }

    #[test]
    fn paste_single_line_cr_normalized() {
        let m = km(false, false, false);
        assert_eq!(encode_paste("hello", m, false), b"hello");
        // Even with bracketed paste on: single line + no force = raw.
        let bp = km(false, false, true);
        assert_eq!(encode_paste("hello", bp, false), b"hello");
    }

    #[test]
    fn paste_multiline_without_bracketed_mode_normalizes_newlines() {
        let m = km(false, false, false);
        assert_eq!(encode_paste("a\nb\nc", m, false), b"a\rb\rc");
        assert_eq!(encode_paste("a\r\nb\r\n", m, false), b"a\rb\r");
        assert_eq!(encode_paste("a\rb", m, false), b"a\rb");
        // force_paste can't wrap when the app never enabled bracketed paste.
        assert_eq!(encode_paste("a\nb", m, true), b"a\rb");
    }

    #[test]
    fn paste_bracketed_when_enabled_and_multiline_or_forced() {
        let bp = km(false, false, true);
        assert_eq!(
            encode_paste("a\nb", bp, false),
            b"\x1b[200~a\nb\x1b[201~".to_vec()
        );
        // Text is verbatim inside the brackets (no CR normalization).
        assert_eq!(
            encode_paste("a\r\nb", bp, false),
            b"\x1b[200~a\r\nb\x1b[201~".to_vec()
        );
        // force_paste wraps even single-line text.
        assert_eq!(
            encode_paste("single", bp, true),
            b"\x1b[200~single\x1b[201~".to_vec()
        );
    }
}
