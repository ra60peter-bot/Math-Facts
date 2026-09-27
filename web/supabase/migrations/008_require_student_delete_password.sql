-- Student deletion must use the server route, which reauthenticates the
-- acting account with its password before using the service-role client.
-- Prevent bypassing that route through the public Supabase REST API.
revoke delete on table public.students from public, anon, authenticated;
drop policy if exists "accounts delete permitted students" on public.students;
