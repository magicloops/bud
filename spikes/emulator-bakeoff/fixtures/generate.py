#!/usr/bin/env python3
"""Generate the synthetic fixtures for the emulator bake-off.

Run from the fixtures/ directory:  python3 generate.py
Produces: osc133-session.raw, utf8-wide.raw, scroll-regions.raw, flood.raw
(altscreen-vim.raw and repl-python.raw are recorded via script(1); see README.md)

All fixtures are raw byte streams as a PTY-attached program would emit them
(CRLF line endings, real escape sequences).
"""
import os

ESC = b"\x1b"
ST = ESC + b"\\"          # string terminator
BEL = b"\x07"             # alternative OSC terminator
CSI = ESC + b"["
OSC = ESC + b"]"

def sgr(*codes):
    return CSI + ";".join(str(c) for c in codes).encode() + b"m"

RESET = sgr(0)
BOLD = sgr(1)
RED = sgr(31)
GREEN = sgr(32)
BLUE = sgr(34)
CYAN = sgr(36)

CRLF = b"\r\n"

def osc133(payload, term=ST):
    return OSC + b"133;" + payload + term


# ---------------------------------------------------------------- osc133-session
def gen_osc133():
    out = bytearray()

    def prompt():
        out.extend(osc133(b"A"))                       # prompt start
        out.extend(BOLD + GREEN + b"user@host" + RESET + b":" +
                   BOLD + BLUE + b"~/proj" + RESET + b"$ ")
        out.extend(osc133(b"B"))                       # end of prompt / start of input

    # --- command 1: ls -la, exit 0 ------------------------------------
    prompt()
    out.extend(b"ls -la\r\n")                          # echoed input
    out.extend(osc133(b"C"))                           # start of output
    out.extend(b"total 24" + CRLF)
    out.extend(b"drwxr-xr-x   5 user  staff   160 Aug 14 10:00 " +
               BOLD + BLUE + b"." + RESET + CRLF)
    out.extend(b"drwxr-xr-x  12 user  staff   384 Aug 14 09:58 " +
               BOLD + BLUE + b".." + RESET + CRLF)
    out.extend(b"-rw-r--r--   1 user  staff  1204 Aug 14 10:00 Cargo.toml" + CRLF)
    out.extend(b"drwxr-xr-x   3 user  staff    96 Aug 14 10:00 " +
               BOLD + BLUE + b"src" + RESET + CRLF)
    out.extend(b"-rwxr-xr-x   1 user  staff   512 Aug 14 09:59 " +
               BOLD + GREEN + b"run.sh" + RESET + CRLF)
    out.extend(osc133(b"D;0", term=BEL))               # command done, exit 0 (BEL-terminated)

    # --- command 2: cat missing.txt, exit 1 ----------------------------
    prompt()
    out.extend(b"cat missing.txt\r\n")
    out.extend(osc133(b"C"))
    out.extend(RED + b"cat: missing.txt: No such file or directory" + RESET + CRLF)
    out.extend(osc133(b"D;1"))                          # command done, exit 1 (ST-terminated)

    # --- command 3: multi-line loop output, exit 0 ---------------------
    prompt()
    out.extend(b"for i in 1 2 3 4 5; do echo \"line $i\"; done\r\n")
    out.extend(osc133(b"C"))
    for i in range(1, 6):
        out.extend(CYAN + b"line " + str(i).encode() + RESET + CRLF)
    out.extend(osc133(b"D;0"))

    # --- trailing fresh prompt -----------------------------------------
    prompt()
    return bytes(out)


# ---------------------------------------------------------------- utf8-wide
def gen_utf8():
    out = bytearray()
    out.extend("CJK wide: 日本語テスト 中文测试 한국어".encode() + CRLF)
    out.extend("emoji: 🚀 🎉 ok".encode() + CRLF)
    out.extend("zwj: 👩‍💻 flag: 🇺🇸".encode() + CRLF)
    out.extend("combining: é ä ñ (e-acute, a-umlaut, n-tilde)".encode() + CRLF)
    out.extend("mixed: aあbいc漢d字e ok".encode() + CRLF)
    # a line of 100 wide chars on an 80-col terminal: forces wrapping of wide cells
    out.extend(("漢" * 100).encode() + CRLF)

    # Pad with ASCII lines so that a 4-byte emoji straddles the absolute byte
    # offset 16384 (a 4096-byte chunk boundary in the runner). The emoji
    # U+1F600 (F0 9F 98 80) is placed to start at offset 16382, so bytes
    # 16382..16383 land in one chunk and 16384..16385 in the next.
    target = 16382
    pad_line = b"padding " * 8 + CRLF  # 66 bytes
    while len(out) + len(pad_line) <= target:
        out.extend(pad_line)
    remaining = target - len(out)
    if remaining:
        out.extend(b"x" * (remaining - 2) + CRLF if remaining >= 2 else b"x" * remaining)
    assert len(out) == target, f"padding math off: {len(out)} != {target}"
    out.extend("😀".encode())  # bytes 16382..16385 inclusive; split at 16384
    out.extend(" <- this emoji straddles byte 16384".encode() + CRLF)
    out.extend(b"end of utf8 fixture" + CRLF)
    return bytes(out)


# ---------------------------------------------------------------- scroll-regions
def gen_scroll_regions():
    out = bytearray()
    out.extend(CSI + b"2J" + CSI + b"H")                     # clear, home
    out.extend(BOLD + b"=== fixed header line 1 ===" + RESET + CRLF)
    out.extend(b"=== fixed header line 2 ===" + CRLF)
    out.extend(b"=== fixed header line 3 ===" + CRLF)
    out.extend(b"---------------------------------" + CRLF)
    out.extend(CSI + b"5;20r")                               # DECSTBM: region rows 5..20
    out.extend(CSI + b"5;1H")                                # move into region
    for i in range(1, 41):                                   # 40 lines -> scrolls inside region
        out.extend(f"region line {i:02d}".encode() + CRLF)
    out.extend(CSI + b"21;1H" + b"=== fixed footer below region ===")
    out.extend(CSI + b"r")                                   # reset margins (DECSTBM default)
    out.extend(CSI + b"24;1H" + CRLF)
    for i in range(1, 61):                                   # full-screen scroll -> scrollback
        out.extend(f"scrollback filler {i:03d}".encode() + CRLF)
    out.extend(b"last line of scroll-regions fixture" + CRLF)
    return bytes(out)


# ---------------------------------------------------------------- flood
def gen_flood():
    # seq 1 500000 with CRLF line endings, ~4.3 MB — throughput measurement.
    return b"".join(str(i).encode() + CRLF for i in range(1, 500001))


# ---------------------------------------------------------------- synthetic alt-screen fallback
def gen_altscreen_synthetic():
    """Synthetic vim-like alt-screen session; used only if script(1) recording fails."""
    out = bytearray()
    out.extend(b"$ vim notes.txt\r\n")
    out.extend(CSI + b"?1049h")                              # enter alt screen
    out.extend(CSI + b"2J" + CSI + b"H")
    out.extend(b"hello from the editor" + CRLF)
    out.extend(b"second line of the file" + CRLF)
    for row in range(3, 24):
        out.extend(CSI + f"{row};1H".encode() + BLUE + b"~" + RESET)
    out.extend(CSI + b"24;1H" + b"\"notes.txt\" 2L, 46B")
    out.extend(CSI + b"1;1H")                                # cursor to top-left
    out.extend(CSI + b"?1049l")                              # leave alt screen
    out.extend(b"$ ")
    return bytes(out)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for name, data in [
        ("osc133-session.raw", gen_osc133()),
        ("utf8-wide.raw", gen_utf8()),
        ("scroll-regions.raw", gen_scroll_regions()),
        ("flood.raw", gen_flood()),
    ]:
        with open(os.path.join(here, name), "wb") as f:
            f.write(data)
        print(f"{name}: {len(data)} bytes")
    # Only write the synthetic alt-screen fixture if a recorded one is absent.
    vim_path = os.path.join(here, "altscreen-vim.raw")
    if not os.path.exists(vim_path):
        data = gen_altscreen_synthetic()
        with open(vim_path, "wb") as f:
            f.write(data)
        print(f"altscreen-vim.raw (SYNTHETIC fallback): {len(data)} bytes")
