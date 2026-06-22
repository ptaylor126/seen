-- Record the manually-applied grant backing the H-1 hardening of the
-- send-push-notification Edge Function.
--
-- As part of H-1, send-push-notification no longer trusts the webhook
-- request body — it re-fetches the notification row from the DB by id with
-- the service-role client and builds the push from THAT row. That read
-- needs SELECT on public.notifications for service_role. (service_role has
-- no privileges on public.* by default on this project — see the prior
-- scoped-grant migrations, e.g. 20260610100000.)
--
-- ALREADY APPLIED via the dashboard; recorded here so the H-1 setup is
-- reproducible from migrations. Idempotent — re-granting is a no-op.

grant select on public.notifications to service_role;
