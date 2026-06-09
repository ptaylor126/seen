-- Companion grant for 20260609110000_create_titles_table. The
-- titles_select_authenticated RLS policy alone isn't sufficient under
-- TECHNICAL.md §2's two-layer permission model — without an explicit
-- table-level GRANT, client reads fail with 42501 before RLS ever
-- evaluates. Service role bypasses both layers, so the backfill is
-- unaffected by this gap, which is why it didn't surface immediately.
grant select on table public.titles to authenticated;
