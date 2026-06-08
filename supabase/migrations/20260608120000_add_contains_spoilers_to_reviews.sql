-- Add contains_spoilers boolean to reviews. Defaults to false — most
-- reviews don't contain spoilers, and flipping the flag should be an
-- explicit author choice on the review composer. NOT NULL with a
-- DEFAULT backfills every existing row to false automatically, so no
-- separate UPDATE pass is needed.
--
-- No RLS change. The flag is a public-to-readers attribute (anyone who
-- can SELECT the review row sees whether it contains spoilers), not a
-- visibility setting. The existing reviews_select_own_or_visible_via_item
-- / reviews_insert_self / reviews_update_own / reviews_delete_own
-- policies already cover the read/write surface and don't need to
-- reference the new column.

alter table public.reviews
    add column contains_spoilers boolean not null default false;
