# Debug: Terminal Garbling on Agent Commands

## Environment
- OS / arch: macOS (observed prompt `MacBook-Pro-7:bud adam`)
- Bud/backend/web: unified session terminal branch, session-based agent execution
- DB: Postgres (local)
- LLM mode: real OpenAI Responses

## Repro steps
1. Open a new thread/session in the UI (session auto-creates and attaches).
2. Ask the agent to “list the current files” (agent runs `ls` via session writer).
3. Observe terminal output garbling on first agent command in the session.

## Observed
```
The default interactive shell is now zsh.
To update your account to use zsh, please run `chsh -s /bin/zsh`.
For more details, please visit https://support.apple.com/kb/HT208050.
H8\n'ok-Pro-7:bud adam$ _ cmd_01KB1CCH723THKYHRHCA6 

__BUD_CMD_START__ cmd_01KB1CCH723THKYHRHCAACA6H8
MacBook-Pro-7:bud adam$ cdCAA/code/bu '~MacBook-Pro-7:bud adam$ ls -lad'
bash: cd: ~/code/bud: No such file or directory
total 120
prin_-rw-r--r--@  1 adam  staff   2294 Nov 11 18:51 README.md
...
T__BUD_CMD_DONE__ cmd_01KB1CCH723THKYHRHCAACA6H8 0
MacBook-Pro-7:bud adam$
```
- Prompt prefix mutates (`MacBook-Pro-7` → `H8\n'ok-Pro-7`).
- Sentinel lines interleaved with garbled characters; newlines missing.
- Command line echoed with spurious characters (e.g., `cdCAA/code/bu '~MacBook-Pro-7:bud adam$ ls -lad'`).

## Expected
- Clean prompt/prefix, unaltered shell output.
- Sentinels on dedicated lines, no prompt corruption or merged lines.

## Hypotheses
1) **Escape and quoting in injected script**: Our sentinel script mixes printf/newlines and raw commands; combined with zsh/bash prompt/bindings, the `printf` sequences or unescaped command injection may be bleeding control chars and prompt contents (e.g., missing `\r\n`, shell expansion, or TERM settings). The `cd` line in the payload shows accidental concatenation (`cdCAA/code/bu '~...`), suggesting malformed string or missing separators.
2) **Binary/text boundaries and base64 framing**: We send a base64-encoded script as `session_input`; if carriage returns or line endings are stripped or doubled (CRLF vs LF) by the WebSocket/Bud bridge, the PTY may be receiving partial lines, causing prompts to merge with our sentinel markers and command text.
3) **Shell startup noise and prompt configuration**: The initial MOTD/zsh notice plus PS1 may be interleaving with our injected start/done sentinels; without a leading newline or a `stty -echo`/`set +o` guard, echoed input and prompt redraws could be corrupting the transcript. A missing `reset` or `tput rs1` on attach might leave the terminal in a weird state.
4) **PTY control characters and missing CRs**: We inject only `\n` newlines; PTY expects CRLF for clean line boundaries. Without carriage returns, prompts and sentinels may overwrite parts of previous lines, producing mangled prefixes.
5) **Shell prompt reflow after errors**: Failed `cd` (e.g., `~/code/bud` missing) triggers an error line, then the prompt redraws; our printf sentinels may run before/after prompt repaint, causing fragments like `H8\n'ok-Pro-7` or `cd "~/cRde/bud"` in the transcript.
6) **Buffered/partial reads**: The PTY reader on Bud chunks data into 16KB frames; if sentinel boundaries fall mid-chunk and the terminal writes without processing full lines, the UI concatenates fragments (e.g., `T__BUD_CMD_DONE__...$?` mid-output).

## Proposed next checks (not executed yet)
- Inspect the exact script we inject (after base64 decode) for line endings/quoting; ensure commands are separated by `\n` and prefixed with a newline.
- Capture raw `session_log` bytes for the first command to see if CR/LF are present and whether prompts are echoed twice.
- Try a minimal script with explicit `\r\n`, `set +o promptvars`, and a guarded `cd` to see if prompt remains intact.
- Added logging in Bud (session input text preview) and agent (sentinel script size) to inspect what reaches the PTY; gather logs from a repro session to confirm whether the injected script or transport is corrupting the prompt.

## Update (fix applied)
- Agent now builds the injected script with double-quoted cwd (`cd "~/code/bud"`) so `~` expands and avoids single-quote blocking shell expansion. Sentinel lines unchanged. Retest to see if prompt corruption resolves with the updated script.
 - Bud logs confirm the exact injected script is clean (printf + cd + command + sentinels), so corruption likely happens inside the PTY/shell (missing CRs, prompt redraw after errors, or partial chunking). Next attempt: switch injected newlines to `\r\n`, add a leading newline, and guard `cd` with `|| true` to avoid error-induced prompt reflow; optionally disable echo for the injected block.
