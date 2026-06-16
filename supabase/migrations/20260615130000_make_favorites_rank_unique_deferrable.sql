-- Make favorites_user_media_rank_unique DEFERRABLE INITIALLY DEFERRED
-- so reorder_favorites can renumber multiple rows in a single UPDATE
-- without the per-row UNIQUE check colliding on a transient duplicate
-- rank. Verified on 2026-06-15 by reproducing in psql:
--
--   BEGIN;
--   UPDATE favorites SET rank = src.ord::integer
--   FROM unnest(ARRAY[id1, id2]::uuid[]) WITH ORDINALITY AS src(id, ord)
--   WHERE f.id = src.id;
--   -- threw 23505 mid-statement on
--   -- favorites_user_media_rank_unique
--   ROLLBACK;
--
-- The "single-statement UPDATE = atomic end-of-statement check"
-- assumption in 20260615120000_create_reorder_favorites_rpc.sql was
-- wrong for non-deferrable UNIQUE constraints — PG uses the unique
-- index to enforce the constraint, and the index is updated row-by-
-- row during the UPDATE; an intermediate duplicate trips it. DEFERRED
-- moves the check from "after each row write into the index" to
-- "after the transaction commits," which is after the multi-row
-- UPDATE has finished writing every row to its final rank.
--
-- INITIALLY DEFERRED (rather than DEFERRABLE INITIALLY IMMEDIATE +
-- explicit SET CONSTRAINTS DEFERRED in the reorder RPC) keeps the
-- reorder_favorites function body unchanged. Every RPC call is its
-- own transaction; the constraint defers automatically; the check
-- fires at commit on the final unique-rank state. No observable
-- side-effect on normal client INSERTs/UPDATEs — single-statement
-- autocommit transactions effectively check at the same instant
-- whether the constraint is IMMEDIATE or DEFERRED (the autocommit
-- is the transaction boundary).
--
-- TRADEOFF: DEFERRABLE unique constraints CANNOT be used as ON
-- CONFLICT arbiters per PG docs ("Unique indexes that are deferrable
-- cannot be used as arbiters with ON CONFLICT DO UPDATE"). The
-- previous src/lib/favorites.ts > addFavoriteAtRank used
-- .upsert({onConflict: 'user_id,media_type,rank'}) targeting THIS
-- constraint — that path will start throwing 42P10 once this
-- migration applies. The client is being rewritten in the same PR
-- as a SELECT-then-UPDATE-or-INSERT pattern (no ON CONFLICT, no
-- UPSERT). The two changes ship together; don't apply this
-- migration without the client rewrite.
--
-- favorites_user_media_tmdb_unique stays non-deferrable — it's
-- not involved in the rank swap, the caller pre-checks for tmdb
-- duplicates client-side, and widening the deferral surface
-- without need would relax DB-level guarantees unnecessarily.

alter table public.favorites
    drop constraint favorites_user_media_rank_unique;

alter table public.favorites
    add constraint favorites_user_media_rank_unique
    unique (user_id, media_type, rank)
    deferrable initially deferred;
