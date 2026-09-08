# Debug: contact search matched JSON field names

## Reproduction and observed output

From `service/`:

```sh
BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/personal-data/contact-processor.test.ts src/personal-data/repository.test.ts src/personal-data/contacts.test.ts src/personal-data/parser.test.ts src/personal-data/routes.test.ts
```

The contact search assertion failed at contact-processor.test.ts:76: `2 !== 1` (expected 1, actual 2). Eleven other tests passed.

## Cause and proposed fix

Searching the serialized fields JSON matched property names such as `family_name` when querying `a`. Search only approved name/organization values and phone/email values. Keep bound SQL parameters and literal LIKE wildcard escaping. Rerun the focused suite and build.

## Resolution

Search now selects approved field values rather than matching property names. All twelve focused service tests, including the PostgreSQL search/wildcard assertions, passed.
