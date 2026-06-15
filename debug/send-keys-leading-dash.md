# Debug: `tmux send-keys` Leading Dash Literal Failure

## Environment

- OS / arch / versions: macOS local development host; tmux 3.6a observed during reproduction
- DB connection style: not involved
- LLM mode: not involved; failure occurs after service has already dispatched a `terminal_send` frame

## Repro Steps

1. Send multiline markdown through `terminal.send` where one line starts with a markdown bullet, for example:

   ```md
   - `npm run dev` starts the local development server.
   ```

2. The service forwards the text unchanged as Bud wire `terminal_send.text`.
3. The daemon normalizes and splits multiline text into individual line segments.
4. The daemon dispatches each segment through `tmux send-keys -t <session> -l <segment>`.

Local tmux reproduction:

```bash
tmux send-keys -t bud_dash_repro_01 -l '- `npm run dev` starts the local development server.'
```

## Observed

tmux reports:

```text
command send-keys: invalid flag -
```

The daemon then returns `terminal_send_result.error = "send_keys_failed"`, and the service rejects the pending send with `send_keys_failed`.

## Expected

Literal text beginning with `-` should be typed into the pane unchanged. The daemon should not let tmux parse the text segment as a command option.

## Hypotheses

- Root cause: `tmux send-keys -l` still parses following option-shaped arguments unless option parsing is terminated.
- Confirmed mitigation: pass `--` before the literal text argument:

  ```bash
  tmux send-keys -t bud_dash_repro_01 -l -- '- `npm run dev` starts the local development server.'
  ```

## Proposed Fix

- Update `bud/src/terminal/tmux.rs` literal-text dispatch to use `tmux send-keys -t <session> -l -- <text>`.
- Add daemon unit coverage for the constructed argument vector, including normal text, markdown bullets, `--flag-like`, and `-t`.
- Update daemon terminal specs and the scoped plan under `plan/fix-send-keys-parse/`.

Spec files affected:

- `bud/src/terminal/terminal.spec.md`
- `bud/src/src.spec.md`
