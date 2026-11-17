# Connected apps

Owner-scoped Google Calendar, Gmail and Drive consent in Settings and chat.
One Bud viewer can connect multiple Google identities, independently of Bud
sign-in. The service resolves the viewer, authorizes the target connection and
originating thread, and retains OAuth credentials. Dependencies include React,
lucide-react, the shared Button and credential-aware transport.

- `google-services.ts` defines service labels, account labels and read/full
  access. Readiness requires the server's effective access for the selected
  connection and service. A reconnect-required account must renew consent.
- `google-consent.ts` posts the exact selection, optional target connection ID
  and optional originating thread ID, and returns Google's authorization URL
  to the initiating view, which navigates only while its visit is active. Omitting the ID opens Google's account chooser.
  A 10-minute tab-local receipt binds the redirect to the owner, thread, transcript
  message, service, access and selected target. The first callback fixes its outcome.
  Conflicting callback parameters or a later return for another account cannot
  select an account. The callback notice reports a failed
  grant, missing permission or an existing account that needs targeted consent.
- `settings.tsx` lists enabled accounts and access levels under each service,
  offers full-access consent for a saved account or Add Google account, and
  targets upgrades and reconnects by ID. Each access row has an independent
  Revoke access action. Removing an account disconnects all its services.
  Unreadable credentials can be cleared even when Google setup is unavailable.
  Mutations serialize, fence earlier reads, reconcile the affected inventory
  after deletion, and abort on owner changes. Inventory refreshes on mount,
  on focus, and after Back restores a cached page. A cached restore hides prior
  accounts and fences pending requests until fresh inventory arrives.
- `google-connect-request.ts` parses consent only from structured Google tool
  evidence with an originating thread and explicit read/full access. An optional
  `connection_id` restricts the card to an existing account. Alternatively
  `add_account: true` requests the Google account chooser.
- `google-connect-card.tsx` requests the service and level needed for the
  current task. Targeted cards check only their named identity. Removed
  targets are unavailable. An explicit Add opens Google's chooser even when
  other accounts have access. If the chosen account is already saved but needs
  additional access, the card offers a targeted upgrade or reconnect for that email.
  Unbound cards with multiple identities let users choose an account or add
  another. A matching receipt allows the returned `google_connection_id` to
  preselect the account on the originating card. Inventory must still confirm
  the exact required grant before the card shows ready. Without a matching tab
  receipt, the user can choose an email manually. The user continues by messaging the chat with their
  chosen account. Restoring a cached chat with Back releases an abandoned receipt and
  reloads inventory before showing actions. Consent does not initiate a Google
  tool call.
- `google-connect-card.test.tsx` mounts the timeline, chat cards and Settings.
  It covers exact consent requests, new/existing identity selection, wrong or
  removed targets, duplicate clicks, owner/thread/account changes, recovery,
  revocation, confirmed deletion, callback inventory checks and browser Back.

[Google services setup and operation](../../../../docs/google-services.md)
