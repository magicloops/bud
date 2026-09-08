# Debug: Automation migration order

Generated migration 0029 and `pnpm --dir service db:push` proposed the delivery
foreign key before the new referenced data_domain_event owner uniqueness. Review
caught this before applying. Moved the generated uniqueness statement ahead of
foreign keys and applied that reviewed SQL transactionally to local PostgreSQL.
The push prompt had closed stdin (`write_stdin failed: stdin is closed for this
session`); process inspection confirmed no db-push process remained. No push SQL
was applied. The reviewed migration committed successfully; service build and
PostgreSQL publication/delivery constraint tests pass.
