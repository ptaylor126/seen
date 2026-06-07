-- recommendation_comment_reactions + is_party_to_comment helper +
-- comment_reacted notification kind + notify_comment_reacted trigger.
--
-- One layer below recommendation_reactions: a reaction on a single
-- comment in a rec's thread. Both parties to the parent rec can read
-- AND write here (rec-level reactions are recipient-only as of
-- 20260607120000; comment reactions are deliberately not, so the
-- conversation feels two-sided). Same emoji set as rec-level reactions
-- — widening either side stays a one-line check change.
--
-- recommendation_comments and the comments_notify_commented trigger are
-- untouched. rec-level reactions and their recipient-only policies are
-- untouched.

-- ============================================================================
-- party predicate — comment-scoped. Mirrors is_party_to_rec exactly:
-- stable, security definer, search_path locked. Resolves comment_id to
-- its parent rec and checks the same (from_user_id, to_user_id) party.
-- A direct two-table join keeps it a single query; calling
-- is_party_to_rec from inside would add a function-call layer without
-- changing semantics.
-- ============================================================================

create or replace function public.is_party_to_comment(comment_id uuid)
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
        from public.recommendation_comments c
        join public.recommendations r on r.id = c.recommendation_id
        where c.id = comment_id
          and (r.from_user_id = me or r.to_user_id = me)
    );
end;
$$;

-- Policy expressions invoke this helper in the caller's role
-- (SECURITY DEFINER controls the function body, not who's permitted
-- to call it). Mirrors the grants on is_party_to_rec and
-- is_friend_of_auth.
grant execute on function public.is_party_to_comment(uuid) to authenticated;

-- ============================================================================
-- recommendation_comment_reactions — one row per (comment, user).
-- Same shape as recommendation_reactions one layer up: PK on
-- (comment_id, user_id) provides per-comment lookup via the leading
-- column; change = UPDATE, remove = DELETE. user_id ON DELETE CASCADE:
-- an anonymised emoji carries no value, so wipe rather than orphan.
-- ============================================================================

create table public.recommendation_comment_reactions (
    comment_id uuid not null
        references public.recommendation_comments(id) on delete cascade,
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    emoji text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (comment_id, user_id),
    constraint recommendation_comment_reactions_emoji_check
        check (emoji in ('👍','❤️','😂','😮','👀'))
);

create trigger recommendation_comment_reactions_set_updated_at
    before update on public.recommendation_comment_reactions
    for each row execute function public.set_updated_at();

alter table public.recommendation_comment_reactions enable row level security;

-- SELECT: any party to the parent rec sees all reactions on any of its
-- comments. Non-parties see nothing.
create policy "comment_reactions_select_party"
    on public.recommendation_comment_reactions
    for select
    to authenticated
    using (public.is_party_to_comment(comment_id));

-- INSERT: only your own row, and only on a comment whose parent rec
-- you're a party to. Both sender and recipient can react to comments —
-- the recipient-only restriction is rec-level only.
create policy "comment_reactions_insert_self_if_party"
    on public.recommendation_comment_reactions
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_comment(comment_id)
    );

-- UPDATE: change your emoji on your row. USING + WITH CHECK both
-- recipient-of-the-comment-party — same defence-in-depth shape as the
-- recipient policies on recommendation_reactions.
create policy "comment_reactions_update_own_if_party"
    on public.recommendation_comment_reactions
    for update
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_comment(comment_id)
    )
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_comment(comment_id)
    );

-- DELETE: remove your reaction.
create policy "comment_reactions_delete_own_if_party"
    on public.recommendation_comment_reactions
    for delete
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_comment(comment_id)
    );

grant select, insert, update, delete
    on public.recommendation_comment_reactions to authenticated;

-- ============================================================================
-- notifications — widen the kind CHECK to include the new kind.
-- 'friend_request' is intentionally still in the allowed set even
-- though the producing trigger was dropped in
-- 20260603120000_drop_friend_request_notification_trigger; tightening
-- the CHECK is a separate tech-debt item.
-- ============================================================================

alter table public.notifications
    drop constraint notifications_kind_check;

alter table public.notifications
    add constraint notifications_kind_check
    check (kind in (
        'rec_received',
        'rec_watched',
        'friend_request',
        'friend_accepted',
        'rec_reacted',
        'rec_commented',
        'comment_reacted'
    ));

-- ============================================================================
-- trigger — notify the comment's author when someone else reacts.
-- Mirrors notify_recommendation_reacted: fires on INSERT only (changes
-- and removals are silent); SECURITY DEFINER so the insert into
-- notifications bypasses the caller's RLS — same pattern as the
-- existing reaction/comment triggers, no service_role round-trip.
-- ============================================================================

create or replace function public.notify_comment_reacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    comment public.recommendation_comments%rowtype;
    rec public.recommendations%rowtype;
begin
    select * into comment from public.recommendation_comments where id = new.comment_id;
    if not found then
        return null;
    end if;

    -- Suppress self-reactions and reactions on comments whose author
    -- has been deleted (recommendation_comments.user_id is ON DELETE
    -- SET NULL, so a NULL author means there's no one to notify).
    if comment.user_id is null or comment.user_id = new.user_id then
        return null;
    end if;

    select * into rec from public.recommendations where id = comment.recommendation_id;
    if not found then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        comment.user_id,
        'comment_reacted',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'recommendation_id', comment.recommendation_id,
            'comment_id', new.comment_id,
            'emoji', new.emoji,
            'tmdb_id', rec.tmdb_id,
            'media_type', rec.media_type
        )
    );
    return null;
end;
$$;

create trigger comment_reactions_notify_reacted
    after insert on public.recommendation_comment_reactions
    for each row execute function public.notify_comment_reacted();
