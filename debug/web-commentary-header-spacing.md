# Web commentary header spacing

Streaming commentary hid the Bud label but retained its header and hover timestamp,
leaving excess space before the text compared with expanded completed commentary.
Remove the entire header for drafts and intermediate commentary. Keep headers for
completed final answers and other message roles. Remove the invisible header from
the spinner reservation too, so spinner and streaming text share one-line sizing.
Existing thread authorization, message identity and completion rules are unchanged.
Validate with render tests and build; visual spacing is checked in the local web UI.
