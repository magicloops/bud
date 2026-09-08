# Debug: Duplicate settings card titles

## Environment and observations
- Web account settings renders both a small section label and a second title for each settings card.
- Username and Linked accounts repeat verbatim; Session also has an unnecessary Sign out title above its button.

## Proposed fix
- Keep the first label as a semantic heading and remove the second title.
- Preserve the username input label and existing account actions.
- Update the routes spec and validate with focused lint.
