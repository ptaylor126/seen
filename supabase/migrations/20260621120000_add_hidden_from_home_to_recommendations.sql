-- "Hide from home" for received recommendations.
--
-- The home screen shows a recipient's actionable recs (pending + on their
-- watchlist). This flag lets the recipient remove a single rec from THAT
-- surface only — it stays in the inbox and stays actionable; nothing else
-- about the rec changes. Home queries filter `hidden_from_home = false`;
-- the inbox does not filter on it.
--
-- NOT null, default false → every existing rec is visible as before.
alter table public.recommendations
    add column hidden_from_home boolean not null default false;

-- No new RLS policy needed. The existing recipient-scoped UPDATE policy
-- (recommendations_update_recipient: USING/WITH CHECK to_user_id =
-- auth.uid(), from 20260518130612) already lets the recipient — and only
-- the recipient — write their own received rows. The per-column
-- immutability trigger (enforce_recommendation_immutability) locks only
-- the sender-set columns (id, from/to_user_id, tmdb_id, media_type, note,
-- sent_at), so it does not block this new recipient-controlled column.
-- The sender has no UPDATE policy, so they cannot touch it.
