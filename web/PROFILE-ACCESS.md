# Account owner and student access

The first visit on an unrecognized browser requires the invited account owner's sign-in. An invitation or password-reset link opens `/auth/callback`, requires matching new passwords (at least eight characters), then opens Students so the owner can add learners. Existing Google-only owners can use Set or reset password. Only the administrator retains Google management sign-in.

Once connected, a device opens a Who's practicing picker. Selecting an owner always opens a password form. Selecting a student opens only Practice and their own History. Students can select practice settings and inspect/sort question results, but cannot manage learners, delete history, invite adults, or inspect other learners through the API. Switch person locks management, clears the password and access token, and returns to the picker. Reload also locks access. Owners manage their own students; only administrators manage adult accounts or other owners' learners.

## Enforcement

- `access_devices` stores hashes of random, HttpOnly, SameSite=Lax device-cookie tokens; production cookies are Secure. Device trust lasts 90 days and exposes only that family's picker and student selection. Forget this device removes the device and its access grant. No password or Supabase owner credentials are saved in browser storage. Old `math-facts-auth` local storage is cleared during migration.
- A separate random eight-hour access grant is kept only in JavaScript memory and sent in `X-Math-Access`. There is one grant per device; selecting a student replaces any owner grant atomically. Requests validate both cookie and grant, the active owner profile, and the learner relationship. Mutations require the same Origin as the application.
- `/api/access` verifies owner passwords with Supabase Auth. It never returns Supabase access/refresh tokens to the shared browser. Only the Google connection bootstrap accepts a Supabase bearer token; ordinary Google owners still do not receive a management grant.
- Owner/admin API routes reject student grants. `/api/progress` is restricted to the selected learner and supports progress reads and recording only. The service supplies the owner ID, never the client.
- Migration `009_profile_access.sql` adds the private device/grant tables and `record_practice_session`. The function inserts a session and its question results atomically; repeated IDs cannot update existing history or attach it to another learner. Existing history-deletion behavior and automaticity state are unchanged.
- RLS is enabled on both new tables, with no anon/authenticated privileges. Only the server's service role can access these tables and recording function. Existing account/student RLS remains in place.

## Deployment and validation

Apply 009 after 008, before deploying the new app. No new environment variables are needed: existing Supabase URL, public key and server-only service-role key remain required. Keep production `/auth/callback` allowed in Supabase redirect configuration. No emails are sent automatically by the migration or deployment.

118 tests pass, including eleven new access tests covering grant rotation/revocation, cross-student denial, expired/blocked access, origin checks, password verification, Google restrictions, every management endpoint, and learner-scoped writes. Existing speech/scheduler tests remain unchanged. Browser QA with isolated sample API responses covered first owner login, picker, student-only navigation/history/details, repeated owner password entry, reload lock, owner management controls, and the light theme. No real passwords, emails or microphone input were used for QA. The actual database RPC was tested inside a rolled-back transaction, confirming insertion and immutable repeat submission. New database privileges were checked in production.

Limits: password-free profiles do not distinguish siblings on the same trusted device; anyone at that device can choose a listed student. They cannot unlock owner management without the password. Progress still uses existing local caching and one-learner-at-a-time snapshot sync. Failed uploads remain local for retry and do not block locking. The eight-hour access grant may require choosing a profile again during very long use. This is the configured online account flow; the existing unconfigured local-development mode remains separate.

