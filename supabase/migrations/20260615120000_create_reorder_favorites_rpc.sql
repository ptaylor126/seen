-- reorder_favorites: atomic renumber of a user's favorites in one
-- category. Takes the favorite ids in their new desired order and
-- assigns rank = array position (1..N) in a single UPDATE statement.
--
-- Why an RPC instead of client-side N UPDATEs: the
-- `favorites_user_media_rank_unique` UNIQUE on (user_id, media_type,
-- rank) means a naive client-side sequential rewrite — UPDATE rank=2
-- WHERE id=X, UPDATE rank=3 WHERE id=Y — collides when X's new rank
-- equals Y's old rank (the first UPDATE lands on a row already
-- occupying that slot). A single multi-row UPDATE inside Postgres is
-- atomic at end-of-statement: the UNIQUE constraint is checked AFTER
-- all rows are written, not row-by-row, so transient duplicate ranks
-- during the update are fine — only the final state matters.
--
-- Parameters prefixed p_* to sidestep the plpgsql #variable_conflict
-- pitfall that broke ensure_title on 2026-06-10 (parameter names
-- matching column names get substituted into ON CONFLICT col_lists).
-- This function uses no ON CONFLICT at all (straight UPDATE), but the
-- prefix is the right convention regardless and removes the trap
-- entirely.
--
-- Used by:
--   - drag-to-reorder on drop (full new ordering)
--   - auto-renormalize after remove (remaining ids in current order,
--     collapsing the gap left by the removed rank)
--   - opportunistic compaction on editor load when an existing gap
--     is detected (e.g. user removed rank 2 before this migration
--     landed, leaving 1, 3, 4 — first load renormalises to 1, 2, 3)
-- All callers pass the FULL list of ids for the category — partial
-- reorders are rejected by the function (see own_count check below).

create or replace function public.reorder_favorites(
    p_media_type text,
    p_ordered_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    n int := coalesce(array_length(p_ordered_ids, 1), 0);
    own_count int;
    matched_count int;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if p_media_type not in ('movie', 'tv') then
        raise exception 'invalid media_type';
    end if;
    if n = 0 then
        return; -- empty array = no-op; used after removing the last
                -- favorite in a category (nothing left to renumber).
    end if;
    if n > 5 then
        raise exception 'too many ids (max 5)';
    end if;

    -- Verify the array IS the caller's full list in this category:
    --   own_count = total favorites the caller has in the category
    --   matched_count = how many of those are referenced by the array
    -- Both equalling n means: array covers every owned favorite AND
    -- every id in the array belongs to the caller in this category.
    -- Catches: partial reorders (own_count > n), duplicate ids in
    -- the array (matched_count < n), foreign ids (matched_count < n),
    -- ids for the wrong category (matched_count < n).
    select count(*) into own_count
    from public.favorites
    where user_id = me and media_type = p_media_type;

    select count(*) into matched_count
    from public.favorites
    where user_id = me
      and media_type = p_media_type
      and id = any(p_ordered_ids);

    if own_count <> n then
        raise exception
            'reorder_favorites: have % favorites in category, got % ids',
            own_count, n;
    end if;
    if matched_count <> n then
        raise exception
            'reorder_favorites: one or more ids are not owned by caller in this category';
    end if;

    -- Atomic renumber. unnest WITH ORDINALITY emits (id, ord) pairs
    -- where ord is the 1-based array position (bigint, cast to
    -- integer for the rank column). The single UPDATE writes all
    -- new ranks at once; the UNIQUE constraint check fires at
    -- end-of-statement on the final state, never on intermediate
    -- rows — that's the key property that lets sibling rows swap
    -- ranks without colliding mid-statement.
    update public.favorites f
    set rank = src.ord::integer
    from unnest(p_ordered_ids) with ordinality as src(id, ord)
    where f.id = src.id
      and f.user_id = me
      and f.media_type = p_media_type;
end;
$$;

-- Mirrors the EXECUTE grant pattern on ensure_title /
-- is_friend_of_auth — without it, calls under the authenticated role
-- fail with 42501 before the function body runs.
grant execute on function public.reorder_favorites(text, uuid[])
    to authenticated;
