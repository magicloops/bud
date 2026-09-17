**I would start browser-first, but build a reusable remote-session layer—not just a browser viewer.** Make Bud-managed Chromium the initial supported environment, add attachment to a user’s existing browser as a second mode, and reserve operating-system control for an explicitly enabled fallback.

The central architectural change is this:

> **The browser session should belong to Bud, while agents and humans temporarily hold permission to control it.**

That is more important than whether the screen arrives through WebSockets, WebRTC, or VNC. Without shared session ownership and an enforced handoff, you can build a good viewer and still have the agent close the browser, navigate away while someone types a password, or resume using stale page state.

Also, **“use my real browser” and “share my whole desktop” are independent decisions**. You can attach to an existing Chrome session and expose only its page content. Chrome now documents a consent-based connection flow for existing sessions, in addition to traditional debugging ports. ([developer.chrome.com][1])

## 1. Separate the decisions that are currently bundled together

I would treat this as four independent choices:

| Decision                        | Alternatives                                                          | Recommended starting point                                                  |
| ------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Who owns the browser?**       | Bud-managed browser, user’s existing browser, hosted browser provider | Bud-managed, with an attachment interface for existing browsers             |
| **What does the user see?**     | Web page, browser window, whole desktop, reconstructed form           | Web page, with Bud’s own navigation and handoff controls                    |
| **How is input applied?**       | Browser protocol, extension, operating-system input                   | Browser protocol                                                            |
| **How are pixels transported?** | Images over WebSocket, WebRTC video, remote-desktop protocol          | Separate WebSocket media connection initially; measure before adding WebRTC |

This separation gives you useful combinations. For example, you could use browser-protocol input while streaming a native browser window, or use exactly the same mobile viewer for a managed browser and an attached personal browser.

The mobile interface should not need to know whether a session was created by Bud, attached through an extension, or hosted elsewhere.

## 2. The main implementation approaches

### A. Stream browser content and send input through CDP

**This is the approach I would use for the first version.**

For Chromium, the Chrome DevTools Protocol provides the basic pieces: page screenshots, experimental screencast frames, keyboard and pointer input, text insertion, navigation, and dialog-related events. A Rust host component can use those APIs and expose a much narrower viewer protocol to Bud’s clients.

Conceptually:

```text
Agent browser tools ───┐
                       ├── Bud session broker ── CDP ── Chromium
Human viewer input ────┘              │
                                     └── frames + session state → viewer
```

The advantages for Bud are substantial: you do not have to expose unrelated applications, coordinate with the system mouse, or build different capture implementations for macOS and Linux. Chrome’s headless mode also gives you a browser that can run without displaying its windows, rather than requiring a remotely accessible desktop. ([Chrome for Developers][2])

**The boundary is page content, not the entire browser application.** Treat browser chrome, extension popovers, operating-system permission sheets, password-manager UI, and biometric prompts as outside the guaranteed surface. Some interruptions can have dedicated handlers—for example, CDP can intercept file chooser requests—but that is not equivalent to streaming arbitrary native dialogs.

For this reason, describe the initial feature as **browser-page takeover**, not “anything you could do sitting at the computer.”

One important choice: launch the browser in the appropriate mode at session creation. Do not plan to switch from headless to headed by restarting it when the user intervenes. The whole purpose is to preserve the running session.

### B. Attach to the user’s existing browser

This is the most relevant alternative for someone using Bud on their Mac laptop and wanting existing logins, tabs, and browsing context.

There are two credible Chromium integration paths.

**Consent-based debugging attachment.** Chrome’s documented flow for Chrome 144 and later lets the user enable remote debugging through `chrome://inspect/#remote-debugging`. Chrome DevTools MCP can then request attachment using `--autoConnect`; Chrome displays a permission dialog for the connection. This supports using an existing session rather than launching a separate profile. ([developer.chrome.com][1])

However, that creates an onboarding and reconnection question: **can the required authorization be completed before the user is away from the laptop?** Do not assume an unattended reconnect can always be approved from the browser-page viewer you are trying to establish.

Also, distinguish this flow from the old command-line switches. Since Chrome 136, normal Chrome does not honor `--remote-debugging-port` or `--remote-debugging-pipe` against its default data directory; the documented switch-based route requires a non-default `--user-data-dir`. ([Chrome for Developers][3])

**A Bud browser extension.** An extension can attach to tabs through `chrome.debugger`, communicate with the host component, and provide an explicit “Share this tab with Bud” experience. The API exposes selected CDP domains, not every browser capability, and enterprise policies can block attachment. ([Chrome for Developers][4])

For video, an extension could also use `tabCapture`, although that API requires a user invocation, such as clicking the extension action. It should not be treated as an unrestricted daemon-triggered capture mechanism. ([Chrome for Developers][5])

**My assessment:** prototype consent-based attachment before deciding you need an extension. Build the extension when you need a better tab-selection experience, more persistent integration, or extension-specific capabilities.

In either case, account for the physical user. Bud can arbitrate its own agents and remote clients, but it cannot claim exclusive control of a personal tab while someone is also clicking that tab locally.

### C. Run a dedicated browser inside a remotely accessible desktop

Here, the browser runs in an isolated graphical environment, and you stream that environment rather than only its web content.

This is particularly attractive on Linux. Existing projects such as **Neko** provide a containerized virtual browser using WebRTC, while **Selkies** provides a broader remote-desktop streaming platform. They are worth evaluating before writing a custom graphical streaming stack. ([GitHub][6])

The important distinction is:

> You can provide full browser-window interaction without providing access to the user’s personal desktop.

That can cover browser menus and dialogs in the isolated environment while keeping unrelated host applications out of scope.

The trade-off is a heavier runtime and packaging story. It also does not automatically provide the user’s existing Mac browser profile or credentials. Moving a task into a container after it gets stuck is not the same as taking over the original session.

I would consider this a strong alternative for **Bud-managed Linux environments**, especially if your real workloads repeatedly require browser UI that CDP page streaming cannot expose.

### D. Capture the browser window—or the whole host desktop

There is a useful middle ground between page-only capture and full desktop sharing: **capture the browser application/window**, with explicit escalation when another window is needed.

On macOS, ScreenCaptureKit supports capture filters for displays, applications, and windows. Capture requires user consent; operating-system control also introduces accessibility authorization. ([Apple Developer][7])

I would implement this through a user-session helper connected to Bud, rather than assuming a background daemon alone provides everything required. Its support matrix would need to cover authorization, login state, sleep, locking, window movement, display changes, and foreground focus.

On Linux, the implementation depends on the display environment. The XDG Remote Desktop portal supports input and integration with screen capture through PipeWire, including permission/session persistence mechanisms. But a particular remote-desktop server is not universally portable across compositors: for example, wayvnc explicitly does not support GNOME, KDE, or Weston. ([Flatpak][8])

For an existing-protocol implementation, **noVNC** is a browser-side VNC client with mobile support and WebSocket transport. You still need a suitable host VNC server and, where necessary, a WebSocket-to-TCP bridge. **Apache Guacamole** is another integration route when a gateway supporting multiple remote-desktop protocols is useful. ([GitHub][9])

**My assessment:** integrate an existing stack for an early desktop fallback. Do not make writing a cross-platform remote-desktop server a prerequisite for browser takeover.

Also, “only showing a cropped browser window” is not automatically a security boundary. If input is injected globally, it can affect another application after a focus change.

### E. Use a hosted browser with an existing takeover viewer

Browserbase and Browserless already document human-in-the-loop viewing and control. Browserless’s LiveURL flow explicitly supports pausing automation, handing control to a person, and resuming afterward. Browserbase provides embeddable live views. ([Browserless Docs][10])

This is useful for a cloud-browser product mode or as a reference implementation.

It is not a direct solution to “take over the browser already running on this user’s laptop.” Choosing it changes where the browser lives, so you must separately solve access to host-local services, files, network identity, and any existing browser state.

There is also a relevant mobile caveat: Browserbase’s current documentation says mobile keyboards are not officially supported by its live viewer and require integrators to forward input themselves. An embeddable viewer does not necessarily deliver a finished mobile experience. ([docs.browserbase.com][11])

### F. Reconstruct the page—or just the required interaction—on the phone

A tempting approach is to extract the page’s fields and controls and render a native mobile interface.

For example:

```text
The browser needs your input

Account:  [                    ]
Password: [                    ]

[Submit to example.com]
```

I would distinguish **a useful enhancement** from **a replacement for remote viewing**.

A focused field editor can make text entry much better. Reconstructing arbitrary pages, however, means deciding how to preserve custom controls, validation, focus, cross-frame relationships, canvas content, and dynamically changing state. You would be building a second interpretation of the page.

My recommendation is **pixels as the authoritative view, with targeted semantic assistance**. Keep “edit the focused field” narrow and bind every action to the actual session, document, frame, and control.

Opening the same URL in the phone’s browser is not an alternative takeover mechanism: it creates another browsing session. Even exported authentication state is not a full migration of an active browser; Playwright, for example, separately documents storage limitations such as session storage. ([Playwright][12])

## 3. The most important Bud change: a session broker

I would introduce a host-side component that owns interactive sessions independently of individual agent processes.

Keep **stem responsible for process execution and supervision**. Put browser lifecycle, session identity, and control arbitration in Bud’s service/host layer rather than treating the browser as incidental output from a terminal session.

A conceptual session record would contain:

```text
InteractiveSession
  session_id
  host_id
  owner / authorization scope
  backend: managed-browser | attached-browser | desktop
  browser instance / profile reference
  available targets and active target
  controller: agent | human | nobody
  control_epoch
  viewport_revision
  privacy_mode
  lifecycle and reconnect state
```

These are suggested internal concepts, not a proposed public schema.

### Make every supported agent use the same session

Bud’s own browser tools, Codex’s configured browser tools, and Claude Code’s configured browser tools should resolve to a session that Bud knows about.

The practical integration choices are to provide a Bud-owned browser tool interface, configure existing tools to connect to a brokered browser endpoint, or implement an attachment adapter for a supported external integration.

**Do not rely on discovering an arbitrary agent-created browser after something goes wrong.** By then, its launch configuration, lifetime, and ownership may already prevent a reliable handoff.

Nor should you assume all automation connections are interchangeable. Playwright explicitly documents that `connectOverCDP` is Chromium-only and lower fidelity than its own protocol connection. Validate the actual operations your delegated tools need. ([Playwright][13])

For v1, I would make an explicit compatibility promise:

> Takeover is supported for browsers launched or attached through Bud’s supported browser integrations.

That is much more defensible than promising universal takeover of whatever browser any subprocess happens to use.

### Enforce handoff at the command boundary

Use a state transition resembling:

```text
AGENT_CONTROLLED
        ↓
HANDOFF_PENDING
        ↓
HUMAN_CONTROLLED
        ↓
RESUME_PENDING
        ↓
AGENT_CONTROLLED
```

When the user requests control, the broker should stop admitting new agent commands, drain or cancel outstanding work where possible, invalidate queued actions, and grant the human a new control epoch only after acknowledging the handoff.

On resume, require a fresh page observation. The agent should not continue with old coordinates, element handles, or assumptions about which tab is active.

Two details matter:

**Pause the agent, not the website.** Login pages, navigation, and OAuth callbacks still need to execute. Pausing automation cannot undo an action already submitted to a website, so the UI must not imply otherwise.

**A prompt saying “please stop” is not enforcement.** Blocking only pointer commands is also insufficient: a tool could navigate, evaluate JavaScript, or close a target. Gate the supported agent connection or tool boundary as a whole.

If the agent retains unrestricted host access, the broker is not a security sandbox against that agent. Stronger guarantees require an actual privilege boundary.

### Treat disconnection as loss of control—not consent to resume

I would allow multiple authorized viewers but only one remote controller.

Every input should carry the session, target, control epoch, and relevant viewport/document revision. Reject stale input, and never blindly replay unacknowledged clicks or text after reconnecting.

When the phone backgrounds or loses connectivity, expire its input lease and leave automation paused by default. Closing the viewer should not close the browser.

That behavior avoids a particularly bad failure: the user temporarily leaves Bud to retrieve a one-time code, and the agent resumes while the login is unfinished.

## 4. Transport: use your existing architecture, but keep media separate

Bud’s existing WebSocket communication layer is sufficient for a first implementation. I would use it for session creation, permissions, handoff state, notifications, and connection negotiation.

**I would not put continuous browser frames in the same queue as agent orchestration and terminal traffic.**

Instead, establish an on-demand session/media connection through your relay:

```text
Bud client
    ↕ session/media connection
Bud relay
    ↕ outbound connection from host
Host session broker
    ↕
Browser adapter
```

This preserves the outbound-connection model without requiring users to expose debugging ports.

### Start with image frames over a separate WebSocket

For short interventions, this is a reasonable first transport to validate.

CDP’s `Page.startScreencast` emits compressed image frames and uses `Page.screencastFrameAck`; it is an experimental API, so test supported browser versions rather than assuming an invariant streaming contract.

I would give the broker bounded queues, discard superseded unsent frames, stop capture when nobody is watching, and prioritize input/control messages over media.

Avoid an ever-growing frame backlog. WebSocket uses TCP; a viewer eventually receiving every old image is not a useful real-time experience. ([RFC Editor][14])

As an **illustration, not a performance estimate**, 100 KB images at 10 frames per second consume about 8 Mbps. Measure actual page content, host encoding cost, relay egress, and mobile responsiveness.

### Add WebRTC when the measurements justify it

WebRTC becomes more attractive for sustained interactive use, scrolling, motion, and broader desktop control. But it adds connection negotiation, codec and encoding decisions, and relay infrastructure. The WebRTC project’s own guidance notes that direct connectivity often fails and TURN servers are needed. ([WebRTC][15])

I would preserve WebSocket fallback even after adding WebRTC.

Crucially, keep the session and input protocol transport-independent. Moving from image frames to video should not require rewriting handoff, permissions, or agent integrations.

## 5. Mobile-first requires more than a portrait-sized stream

I would build one shared web viewer for mobile web and app embedding, while leaving room for a native input adapter where it improves keyboard behavior.

### Preserve the remote layout by default

Offer two distinct viewing modes:

**Preserve layout:** keep the browser’s current viewport and let the user zoom or pan locally.

**Fit to phone:** explicitly resize a Bud-managed browser viewport to a portrait layout.

My default for taking over an existing session would be preserve-layout. Otherwise, merely opening the viewer could change the page the agent was working on.

For a personal browser, avoid silently resizing the user’s actual window. For a managed browser, a portrait preset can be useful, but it is still Chromium running on the host—not an actual iPhone browser.

Also distinguish three operations in your implementation: resizing the remote page, reducing capture resolution, and zooming the local viewer. They should not accidentally trigger one another.

### Make keyboard input a first-class subsystem

A streamed image is not a local HTML input. You need a local input surface that activates the phone’s keyboard and forwards editing operations.

Do not design this as only `keydown`/`keyup` forwarding. Include committed text, composition, deletion, selection, paste, and explicit control keys. CDP has text-insertion and IME-related operations in addition to keyboard events. ([GitHub][16])

I would include an explicit keyboard button from the start and validate real devices with passwords, one-time codes, autofill, non-English composition, and edits in the middle of existing text.

For sensitive entry, bind the input operation to the intended focused field and document. A navigation or focus change should not silently redirect a buffered password elsewhere.

### Design touch behavior deliberately

For a desktop-style page, I would start with tap-to-click, swipes mapped to scrolling, local pinch-to-zoom, and an optional precision/trackpad mode.

Do not automatically turn every phone gesture into remote touch emulation. Viewing a desktop site from a phone does not necessarily mean changing the site’s interaction model.

Keep a small persistent control area showing the **host, current domain, selected tab, control owner, keyboard action, and “Return to agent” button**. Those controls should remain usable when the keyboard occupies half the screen.

## 6. Authentication has blockers that streaming alone will not solve

### Passwords and one-time codes are achievable—but autofill needs care

A human can enter credentials through the remote input channel without placing them in the agent conversation.

However, a login visually displayed inside Bud is not automatically a local login form for that website. Apple’s autofill integration uses app/website associations; do not promise ordinary site-matched autofill simply because the remote image shows that site. ([Apple Developer][17])

Support secure text entry and explicit credential selection/paste first. Treat richer password-manager integration as a separate capability.

### Passkeys and biometric prompts need their own design

Do not assume that displaying a remote passkey QR code lets a phone authenticate a distant computer. FIDO’s cross-device authentication uses Bluetooth proximity checks; ordinary screen streaming does not provide that proximity. ([FIDO Alliance][18])

There are specialized forwarding mechanisms. Chrome exposes `webAuthenticationProxy` specifically so remote-desktop software can intercept host-side WebAuthn requests and handle them on a local client. But that is a separate authentication integration, not something you get automatically from CDP input or a video stream. ([Chrome for Developers][19])

For v1, document which authentication methods work. Do not promise that full desktop sharing makes Touch ID, hardware-key presence, or arbitrary phone-held passkeys remotely usable.

### Popups, uploads, and permissions need explicit handling

An OAuth login may open another tab or window. Your session model must track the target set and let the human select the appropriate target; a viewer permanently tied to the original tab is too narrow.

For uploads, provide an intentional phone-to-host file-transfer flow rather than expecting the user to navigate the host filesystem from a phone. CDP file chooser interception gives you a starting point for integrating that flow.

For unsupported browser or system dialogs, show a clear capability limitation and an escalation route. Avoid silently granting permissions merely to keep automation moving.

## 7. Privacy and security should shape the first version

I would make **private human takeover** part of v1, with agent observation, screenshots, traces, and input logging suspended during sensitive entry.

Record that a handoff occurred and when it ended—not the password or a replay of the login screen.

But distinguish two promises:

> “Credentials are not sent to the model” is achievable through careful routing and logging controls.

> “Credentials are inaccessible to any privileged code on the host” is a much stronger isolation claim.

Debugging access is powerful. Chrome’s debugging-port restrictions were explicitly motivated by cookie theft, and Chrome DevTools MCP warns that connected clients can inspect and modify browser data. ([Chrome for Developers][3])

For the initial design, I would require narrowly scoped, short-lived viewer authorization; host-side enforcement of view versus control; explicit consent for personal profiles; and no public CDP or VNC endpoint. Keep clipboard sharing and desktop escalation off unless deliberately enabled.

A dedicated profile also deserves a clear label: **a persistent Bud profile preserves authenticated access**. Treat it as sensitive account state, not disposable browser cache.

Finally, decide whether Bud’s relay is allowed to see plaintext session content. TLS on each connection is not the same promise as encrypting content end-to-end between the host and phone.

## 8. Recommended implementation sequence

### First, validate the risky interactions

Before polishing the viewer, build one complete vertical slice:

**A real delegated agent uses a registered browser → the user takes control on a real phone → completes a login or selection → returns control → the agent re-observes and continues.**

Exercise a popup login, cross-origin frame, native select control, file upload, non-English text input, rotation, network interruption, and app backgrounding. Test through the relay, not only on a local network.

The decisive checks are session continuity, input correctness, enforced handoff, privacy, and successful agent resumption—not maximum frame rate.

### Ship a bounded browser-first release

I would include a Bud-managed Chromium session, explicit ephemeral/persistent profile modes, browser-page viewing over a dedicated WebSocket, mobile keyboard support, target switching, private takeover, and safe reconnect/resume behavior.

Support the specific agent/browser integrations you have validated. Do not initially promise arbitrary browser attachment, universal passkeys, or operating-system control.

### Add personal-browser attachment next

Evaluate Chrome’s consent-based attachment and a Bud extension against your actual onboarding needs. Keep the viewer and handoff experience identical.

Add clear scope controls for which browser or tabs are shared, and define how local activity interrupts remote control.

### Add desktop escalation and richer streaming selectively

Introduce window/desktop control when observed failures justify it, with separate setup and permissions. On Linux-managed environments, evaluate an isolated streamed browser desktop before exposing the host’s real desktop.

Add WebRTC when sustained usage, latency, or bandwidth measurements justify the extra infrastructure—not simply because it is the conventional streaming choice.

## Bottom line

**Build session ownership and handoff first; build browser-page takeover as the first adapter.**

That gives Bud a coherent foundation for its own browser tools, delegated agents, personal-browser attachment, and eventual desktop control.

The main reason to reverse the implementation order would be a launch requirement to support workflows that already depend on arbitrary native applications, non-Chromium browsers, or system-level dialogs. Otherwise, desktop-first introduces a large operating-system compatibility surface before you have solved the user’s immediate problem.

The first product should feel like: **“Bud needs your help in this browser. Open it, take over safely, finish the step, and hand it back.”** Not a miniature remote desktop that every mobile user must learn to operate.

[1]: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session "Let your Coding Agent debug your browser session with Chrome DevTools MCP  |  Blog  |  Chrome for Developers"
[2]: https://developer.chrome.com/docs/chromium/headless "Chrome Headless mode  |  Automation and testing  |  Chrome for Developers"
[3]: https://developer.chrome.com/blog/remote-debugging-port "Changes to remote debugging switches to improve security  |  Blog  |  Chrome for Developers"
[4]: https://developer.chrome.com/docs/extensions/reference/api/debugger "browser.debugger  |  API  |  Chrome for Developers"
[5]: https://developer.chrome.com/docs/extensions/reference/api/tabCapture "browser.tabCapture  |  API  |  Chrome for Developers"
[6]: https://github.com/m1k1o/neko "GitHub - m1k1o/neko: A self hosted virtual browser that runs in docker and uses WebRTC. · GitHub"
[7]: https://developer.apple.com/videos/play/wwdc2022/10156/ "Meet ScreenCaptureKit - WWDC22 - Videos - Apple Developer"
[8]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html "Remote Desktop - XDG Desktop Portal"
[9]: https://github.com/novnc/noVNC "GitHub - novnc/noVNC: VNC client web application · GitHub"
[10]: https://docs.browserless.io/baas/interactive-browser-sessions/hybrid-automation "Hybrid Automation | Browserless Documentation"
[11]: https://docs.browserbase.com/features/session-live-view "Session live view - Browserbase Documentation"
[12]: https://playwright.dev/docs/auth "Authentication | Playwright"
[13]: https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com "BrowserType - Playwright"
[14]: https://www.rfc-editor.org/rfc/rfc6455.html "www.rfc-editor.org"
[15]: https://webrtc.org/getting-started/turn-server "TURN server  |  WebRTC"
[16]: https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Input.pdl "devtools-protocol/pdl/domains/Input.pdl at master · ChromeDevTools/devtools-protocol · GitHub"
[17]: https://developer.apple.com/documentation/security/about-the-password-autofill-workflow?utm_source=chatgpt.com "About the Password AutoFill workflow - Apple Developer"
[18]: https://fidoalliance.org/passkeys/ "FIDO Passkeys: Passwordless Authentication | FIDO Alliance"
[19]: https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy "browser.webAuthenticationProxy  |  API  |  Chrome for Developers"
