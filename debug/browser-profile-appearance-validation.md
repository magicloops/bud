# Debug: Profile appearance validation

On macOS, the first disposable Chrome check used:

```sh
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --user-data-dir=<temporary-directory> --use-mock-keychain --password-store=basic --no-first-run --no-default-browser-check --disable-background-networking --dump-dom about:blank
```

Python's subprocess runner raised `subprocess.TimeoutExpired` after 30 seconds
and killed that test child. This check inherited the host environment and relied
on dump-dom exiting; it did not establish preference acceptance or rejection.

Replaced it with the installed playwright-core's `launchPersistentContext` in a
fresh disposable directory, isolated HOME/PATH, and explicit context close. This
completed successfully with installed Chrome 152: the saved Preferences retained
all five seeded values, and Chrome populated Local State with `Bud Browser` and
`chrome://theme/IDR_PROFILE_AVATAR_44`. No live Bud profile was modified.

`cargo test --lib browser::profile::tests`: 3 passed (including customization
preservation and reset). `cargo build` and `git diff --check` passed.
