# Debug: stable Terminal toolbar position

## Observed
In the web workspace, conditional Browser and File buttons appear to the right
of Terminal, moving Terminal left as those views become available.

## Fix
Render Terminal last in the existing right-aligned toolbar. Web, Browser and File
remain to its left, including in narrow layouts. Keep the existing actions and
availability conditions.

Related spec: `web/src/components/workbench/workbench.spec.md`.

Web view now also requires the thread’s existing authorized proxy attachment.
New threads omit it; detaching the proxy removes it. Transport outages do not
hide an attached proxy’s recovery controls. No new reads or permissions are added.
