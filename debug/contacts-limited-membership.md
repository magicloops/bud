# Debug: Limited Contacts membership mistaken for creation

With iOS limited access, grant access to an existing contact while keeping the
same authorization status. The current full-set diff labels the new identifier
incremental and live-eligible. That identifier could be newly shared rather than
newly created.

Apple documents that limited access returns shared contacts and that its access
picker changes this set: [WWDC24 API overview](https://developer.apple.com/videos/play/wwdc2024/10121/).
Our snapshot-only implementation cannot distinguish the cause of a membership
change. Treat a changed limited-access set as `access_change`, suppressing live
actions while retaining queries/history and explicit bootstrap. This also
suppresses genuinely new contacts first observed with limited access; disclose
that limitation in mobile settings. Full-access incremental detection is unchanged.

Validate expansion, reduction, replacement at equal count, field-only updates,
baseline and full-access additions. Physical picker/Settings behavior remains a
device acceptance item; no claim of actual creation time is introduced.
