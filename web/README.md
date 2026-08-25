# Math Facts Web App

This folder is the new public, invite-only web version of the desktop app. It keeps the fluency thresholds, timed retries, mastery scoring, addition, and multiplication while replacing legacy priority scheduling with FSRS. Answers are voice-only.

Scheduling uses FSRS, the modern scheduler supported by Anki. Wrong answers are recorded as Again, slow correct answers as Hard, normal correct answers as Good, and very fast correct answers as Easy. FSRS uses a 90% desired-retention target and stores independent scheduling state for every learner and math fact.

## What you need

1. A GitHub account at https://github.com/signup.
2. Node.js LTS from https://nodejs.org. Accept the default installer options, then open a new PowerShell window and verify with `node --version` and `npm --version`.
3. A Supabase account at https://supabase.com/dashboard/sign-up.
4. A Vercel account at https://vercel.com/signup. Choose **Continue with GitHub** so deployments can connect directly to the code repository.
5. Chrome or Edge for desktop testing. Allow microphone access when asked.

## Run it locally

From this `web` directory:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. Without Supabase variables, the app runs as a local preview only. It deliberately switches to account sign-in once Supabase is configured.

## Set up Supabase

1. Create a new Supabase project. Pick a strong database password and save it somewhere secure.
2. In **SQL Editor**, run the files in `supabase/migrations` in numeric order. For a new project, `001_initial_schema.sql` creates the full schema; the later migrations are idempotent compatibility updates.
3. In **Authentication > URL Configuration**, set the Site URL to `http://localhost:3000` for local work. Add `http://localhost:3000/auth/callback` to Redirect URLs.
4. In **Authentication > Providers > Email**, keep email enabled, require email confirmation, and disable public/self-service sign-ups. Invitations created by an administrator still work.
5. In **Project Settings > API**, copy the Project URL and the publishable/anon key. In **Project Settings > API Keys**, copy the `service_role` key. The service-role key is server-only: never put it in a `NEXT_PUBLIC_` variable, commit it, or paste it into a browser console.
6. Put the three values into `.env.local` using the field names in `.env.example`.
7. Create the first administrator: in **Authentication > Users**, invite your own email address. Accept the invitation, set a password, then run the commented `update public.profiles ...` statement at the bottom of the migration with your email. From then on, the app's **Invite learner** form sends invitations itself.

Administrators get a **Users** view where they can send invitations, list accounts, inspect each learner's session history, and permanently delete non-administrator accounts. Deleting an account also deletes its progress, sessions, attempts, and voice mappings.

## Put the code on GitHub

1. Sign in at GitHub and verify your email address.
2. Click the plus icon, select **New repository**, name it `math-facts-web`, make it **Private**, and leave the initialization checkboxes off. Copy the repository URL GitHub shows.
3. In PowerShell, from this `web` directory, run the following. Replace the URL with your own copied URL.

```powershell
git init
git add .
git commit -m "Initial Math Facts web app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/math-facts-web.git
git push -u origin main
```

GitHub may ask you to sign in through a browser. Do not add `.env.local` to Git; it is already excluded by `.gitignore`.

## Deploy with Vercel

1. Sign in to Vercel with GitHub, then select **Add New > Project**.
2. Import the `math-facts-web` repository. Vercel detects Next.js automatically.
3. Under Environment Variables, add the same three values from `.env.local` for Production, Preview, and Development. Keep `SUPABASE_SERVICE_ROLE_KEY` private.
4. Deploy. Vercel gives you a URL such as `https://math-facts-web.vercel.app`.
5. Return to Supabase **Authentication > URL Configuration**. Change Site URL to the Vercel URL and add `https://YOUR-DOMAIN/auth/callback` as a redirect URL. Keep the localhost URLs too.
6. Redeploy in Vercel so the invitation route uses the production domain.
7. Test the complete loop: sign in as the administrator, invite a second email, accept the email invitation, set a password, sign in, complete a session on one computer, then confirm it appears after signing in on another.

Vercel Pro and Supabase Pro are reasonable paid production choices once usage justifies them. Start with their current free tiers only if their current limits fit your expected number of users and sessions; review the current pricing pages before choosing a plan.

## Speech and offline behavior

The included recognizer uses the browser's Web Speech API. It has no paid speech API and does not send audio to this app's server. Chrome and Edge on desktop are the intended V1 browsers. Browser support and whether recognition is processed locally vary by browser and installed language packs; test the exact target machines before launch. MDN documents both the limited cross-browser availability and the newer optional on-device recognition path: https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API

The app shell and latest local progress are cached for offline use. Sessions completed offline remain in local browser storage and are synchronized on a later online session. In V1, speech itself may still need a connection depending on the browser. That is the honest trade-off for a no-paid-API launch.

For true offline voice in V2, replace the browser recognizer with a WebAssembly model. `vosk-browser` is the closest direct migration of the existing Vosk approach, but its model must be downloaded and cached per device: https://github.com/ccoreilly/vosk-browser. I recommend doing this only after testing browser recognition with real adult users; it raises first-load size, memory use, and support burden substantially.

## Before inviting public users

- Add a simple privacy policy that explains microphone use, whether audio leaves the browser, account data stored, retention, and a contact email.
- Add a Terms of Use page and a support/contact route.
- Test microphone permission, no-speech timeouts, and recognition mistakes in Chrome and Edge on several laptops.
- Keep the deployment private until the invite flow and first-admin setup have been tested end to end.

## Project structure

- `app/`: Next.js pages, invitation endpoint, global styles.
- `components/math-facts-app.tsx`: voice-only practice flow and desktop UI.
- `lib/learning.ts`: port of the desktop fluency algorithm.
- `lib/cloud-progress.ts`: Supabase cross-device synchronization.
- `supabase/migrations/001_initial_schema.sql`: account, progress, session, and RLS schema.
