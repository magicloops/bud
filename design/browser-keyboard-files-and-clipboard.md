# Browser keyboard, file uploads and clipboard input

Status: **Proposed; not implemented.**

## Objective

Let the agent perform ordinary page keyboard actions and attach explicitly chosen
files. Let users supply files and clipboard content privately through the browser
pane. Keep these as browser operations, without adding general desktop automation
or treating either machine's clipboard as implicitly available.

Motivation: an agent correctly reported that it could not send Cmd+V or operate
the system file picker. Those are current interface limitations, not evidence that
the managed browser cannot support the underlying workflow.

Related: [browser roadmap](../plan/bud-owned-browser/phases.md),
[agent tools](../service/src/agent/browser-tools.ts),
[semantic helper](../bud/browser-helper/browser-helper.spec.md),
[daemon](../bud/src/browser/browser.spec.md),
[service](../service/src/browser/browser.spec.md),
[viewer](../web/src/features/browser/browser.spec.md).

## Current behavior

- Agent actions are navigate, click, focus, insert_text, fill and scroll. There
  is no agent keypress, clipboard or file-upload action.
- The private viewer supports committed text and a small editing-key allowlist.
  Its local text/IME bridge does not provide general remote shortcut forwarding.
- Text insertion is not a clipboard paste: it does not promise paste-event,
  image or file semantics. The viewer device and daemon can be different machines.
- Native file pickers, password dialogs and other OS UI are outside the browser
  interface. The existing helper already provides semantic page targeting; extend
  it rather than introducing another automation engine.

## Recommended delivery slices

1. **Agent page keys and daemon-local file attachment.** Extend browser_act using
   the existing broker, authority checks, serial page execution and helper.
2. **Private viewer files.** Add an explicit file-selection action and a bounded
   owner-scoped transfer to the daemon, then apply to a validated file input.
3. **Explicit clipboard payloads.** Start with user-supplied text/images only after
   validating the required paste behavior on representative sites. File attachment
   remains the default for files; native clipboard integration is not a prerequisite.

Each slice should be independently useful. Do not build a generic asset platform,
clipboard service or desktop-control layer to ship the first slice.

## Page keyboard actions

Proposed browser_act action `press_key` takes current target/observation identity,
one observed element reference or exact semantic locator, and a validated key plus
modifier list. Use the same exact-node resolution and freshness checks as click
and fill. Targeted actions establish focus explicitly instead of depending on an
unverified global active element. Keep this separate from whole-text insertion.

Normalize a small key vocabulary once: Enter, Escape, Tab, editing/navigation
keys and supported letter shortcuts. A `primary` modifier maps to the daemon OS,
not the viewer OS; explicit Meta/Control remain distinguishable. Reject unknown
combinations. Do not pass arbitrary strings into a generic automation API.

Dispatch one complete press with bounded execution and modifier cleanup. No public
key-down/key-up state machine. Verify focus and document before dispatch; preserve
unknown-outcome behavior if navigation/disconnection occurs afterward. An accepted
keypress is not proof of submission or navigation: the agent observes afterward.

Initial scope is page interaction, not Chrome menus, address-bar shortcuts, window
management or OS shortcuts. Clipboard shortcuts (copy/cut/paste) are excluded from
the first slice: adding Cmd+V alone would silently depend on the daemon's system
clipboard. They must not become an accidental clipboard read/write API.

## File attachment

Proposed browser_act action `set_files` targets a current observed HTML file input
and supplies explicit daemon-local paths. Resolve the input through the existing
semantic reference map and validate its type; do not assume accessible textbox
roles identify file inputs. Confirm snapshot representation of hidden file inputs
and label-driven upload controls before finalizing the schema. If no usable input
can be identified, return an actionable unsupported result rather than opening an
uncontrollable native picker or guessing a selector.

Use the browser automation file-input operation, preserving normal input/change
behavior. Support a bounded list for multiple inputs; an empty list explicitly
clears selection. Reject multiple files for single-file controls. Folder upload,
drag-and-drop-only sites and custom non-file-input upload widgets are deferred.

For daemon-local paths, reuse applicable host file-access policy and resolve on
the daemon, never on the service. Require explicit paths; no globbing, recursive
discovery or implicit clipboard/file reads. Validate regular files, permissions,
symlink resolution, count and aggregate size before application; reject directories
and special devices. Avoid validation/open races where practical by preparing a
bounded stable payload. Respect existing user authorization: attaching a file can
send it to the site immediately, even without a later Submit click.

For viewer-device files, the user chooses files in the **local viewer's** picker.
Transfer them through an authenticated, bounded data path and use opaque upload
handles; do not send bytes in tool arguments, chat SSE, provider history or ordinary
control messages. Audit existing file-transfer facilities before choosing reuse
versus one narrow browser transfer endpoint. Do not reverse a read-only file
viewer into an upload endpoint without an ownership review.

Temporary handles bind owner, Bud, thread, session generation and controller.
Use generated private storage names, retain only a sanitized display filename, and
clean up on consumption, cancellation, expiry and session end, with restart cleanup
for abandoned staging. Revalidate target/document and private controller after a
long transfer; navigation or return-to-agent must not attach files to a new page.
Do not hold the browser page lock while transferring bytes.

Private viewer uploads stay private: no agent-visible filenames or contents by
default. Explicit return permits subsequent ordinary page observations, which may
show an attached filename or the site's resulting content. Explain this boundary
in the transfer UI where it affects the user's choice.

## Clipboard behavior

Keep ordinary user text paste through the existing text bridge. Add image/file
paste only in response to an explicit paste or selection gesture in the active
private viewer. Never poll the clipboard, read it during observations, or sync it
bidirectionally. The agent can supply known text through fill/insert_text already.

Clipboard payloads need declared types and bounded sizes. Prefer plain text and
PNG/JPEG initially; defer HTML, rich text and arbitrary native formats. Reuse the
file-transfer path for binary data rather than inventing a parallel payload store.

Before implementing true paste, test the pinned browser/helper's support for
page-local paste semantics. A synthetic paste event may not behave like a trusted
paste, and an image upload is not equivalent to pasting into a rich editor. Return
an explicit unsupported result when semantics cannot be provided. Do not silently
fall back to reading or replacing the daemon's OS clipboard. System clipboard
access, if later needed, requires its own explicit product decision and consent.

## Ownership, execution and failure contract

- Resource ownership remains user → Bud → thread → browser session. Agent calls
  use the existing invocation authority; human input requires the owning signed-in
  viewer and current private-controller lease.
- New browser-facing transfers authorize before accepting bytes or resolving
  handles, and reauthorize before application. Cross-owner resource lookups return
  404; handles are not standalone authorization.
- Retain generation, control epoch, document and observation/focus fencing. Agent
  actions during private control use the existing inline wait/return flow. No
  alternate bypass via keypress or uploads.
- Apply under existing serialized page execution. Reuse action receipts and
  cancellation; never automatically replay a possibly applied keypress or upload.
  Report dispatch/application separately from the site's eventual outcome.
- Log only bounded operational metadata and canonical errors. Exclude clipboard
  contents, bytes, local paths, private filenames, tokens and raw page exceptions.
- No new durable transfer table by default. If implementation requires persisted
  staging metadata, stamp tenant/owner identities and follow the migration workflow.

## Validation and implementation decisions

Test keys on inputs, contenteditable, dialogs and iframe targets; duplicate names,
stale references, focus changes, navigation, modifier cleanup and lost ACKs. Confirm
Mac versus Linux primary-modifier behavior and unchanged Unicode/IME text entry.

Test files on hidden/visible inputs, single/multiple selection, replacement/clear,
missing/unreadable files, symlinks, special files, Unicode names, size limits and
immediate site upload. Test interrupted transfer, target navigation, takeover,
return, expiry, restart cleanup and cross-owner/other-controller handle rejection.

Use synthetic pages first, then actual-agent tasks and private viewer uploads.
Validate clipboard paste separately on rich editors; do not infer support from a
successful text insertion. Verify private bytes stay out of logs/transcripts and
that transfer load does not stall control renewal or terminal traffic.

Before implementing transfers, choose concrete count/size/expiry bounds and the
existing transport to reuse. Before clipboard work, establish a supported browser
mechanism and MIME matrix. These are implementation gates, not reasons to delay
the smaller page-key action.

## Documentation and rollout

Update agent tool schemas/guidance, helper/daemon/service/viewer specs and
docs/proto.md with actual implemented shapes. Add transfer ownership cases to
plan/init-auth/validation-checklist.md. Mobile can reuse the contract later;
native picker/paste and background behavior need separate real-device validation.

The browser feature is unreleased: use updated service, web, helper and daemon
together, without new backward-compatibility branches for these actions. Keep
existing unrelated deployed contracts intact. No code or wire change is made by
this design document.

## Won't-dos

- Native OS file-picker automation, general remote desktop or personal-profile access.
- Automatic system clipboard reads, clipboard mirroring or hidden clipboard writes.
- Arbitrary JavaScript/CDP, a browser REPL, broad keyboard macros or held-key APIs.
- Automatic mutation retries, automatic form submission after file selection, or
  claims that dispatch success means a website accepted an upload.
- A new tool family, permission framework, persistent upload library or background
  transfer system before the narrow workflow requires one.
