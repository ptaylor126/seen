-- Restrict recommendation_reactions writes (INSERT/UPDATE/DELETE) to the
-- rec recipient only. Previously the write policies allowed either
-- party to react; product call is that only the to_user gets to react,
-- since the rec is *to* them and the reaction is feedback on receiving
-- it. The sender still SEES the recipient's reaction (SELECT remains
-- party-only) and still gets the rec_reacted notification — the
-- notify_recommendation_reacted trigger always targets the party that
-- isn't the reactor, which under the new model is always from_user.
--
-- recommendation_comments and the comments_notify_commented trigger are
-- intentionally untouched.

create or replace function public.is_recipient_of_rec(rec_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        return false;
    end if;
    return exists (
        select 1
        from public.recommendations
        where id = rec_id
          and to_user_id = me
    );
end;
$$;

-- Mirror the explicit grant pattern used for is_party_to_rec /
-- is_friend_of_auth — without EXECUTE, policy invocations under the
-- caller's role 42501 before RLS even evaluates the row.
grant execute on function public.is_recipient_of_rec(uuid) to authenticated;

-- Replace the three write policies. SELECT (reactions_select_party)
-- stays as is — both parties still see all reactions on the rec.

drop policy "reactions_insert_self_if_party" on public.recommendation_reactions;
drop policy "reactions_update_own" on public.recommendation_reactions;
drop policy "reactions_delete_own" on public.recommendation_reactions;

create policy "reactions_insert_self_if_recipient"
    on public.recommendation_reactions
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_recipient_of_rec(recommendation_id)
    );

-- UPDATE keeps both USING and WITH CHECK gated on recipient. Without
-- the recipient predicate on USING, a former recipient (e.g. if the rec
-- were ever re-routed — not possible today, defence in depth) could
-- still target their old row; without it on WITH CHECK they could in
-- principle reassign user_id. Both clauses get the same predicate.
create policy "reactions_update_own_if_recipient"
    on public.recommendation_reactions
    for update
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_recipient_of_rec(recommendation_id)
    )
    with check (
        user_id = (select auth.uid())
        and public.is_recipient_of_rec(recommendation_id)
    );

create policy "reactions_delete_own_if_recipient"
    on public.recommendation_reactions
    for delete
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_recipient_of_rec(recommendation_id)
    );

-- One-shot cleanup: any reactions previously written by the rec's
-- sender under the now-removed permissive policies. The new DELETE
-- policy is recipient-gated, so without this purge those rows would
-- remain SELECT-visible to both parties but un-DELETE-able by the
-- sender themselves — stuck data that misrepresents the new rule.
-- Runs as the migration role and bypasses RLS, so the new client
-- policies above don't block it. Pre-migration count against
-- production at write time: 1 row.
delete from public.recommendation_reactions r
using public.recommendations rec
where r.recommendation_id = rec.id
  and r.user_id = rec.from_user_id;
