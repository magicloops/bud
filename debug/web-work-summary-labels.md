# Debug: Web work summary labels

The work disclosure reused the latest item title even for completed sections.
Reasoning titles stripped leading Markdown markers only, leaving closing `**`
visible in both section and item buttons.

Fix: strip lightweight title decoration on both ends and paired inline emphasis.
Completed activity sections describe their reasoning/tool counts; live sections
retain the latest action so ongoing work stays visible. Keep original Markdown
in expanded details, existing disclosure state and lazy detail mounting.

Validate decorated/plain titles, mixed and single-kind completed counts, and live
latest-action labels in the existing work-group render tests. Update the workbench
spec. No service, transcript, timing or mobile changes.
