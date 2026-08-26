# Math Facts Web App

This folder is the new public, invite-only web version of the desktop app. It keeps the same fact ranges, fluency thresholds, timed retries, mastery scoring, and learning progression for addition, subtraction, and multiplication. Answers are voice-only.

Scheduling follows the desktop fluency model. Wrong answers are recorded as Again, slow correct answers as Hard, normal correct answers as Good, and very fast correct answers as Easy. Only a wrong answer demotes a fact; slow correct answers remain correct and receive a later within-session retry. Across sessions, both apps use FSRS at 90% desired retention: due reviews are selected first, followed by new facts and then future reviews. The fluency score breaks ties within those FSRS groups.

Online access has three levels:

- `impleader@gmail.com` is the sole bootstrap administrator and can use Google sign-in without an invitation.
- Invited users sign in with their email and chosen password, or with Google when the Google account uses the invited email. Users can create and delete their own student profiles.
- Students have no login. After an account owner signs in, a student selects their name from the dropdown. Students can choose facts and settings, practice, and view their own history; only the signed-in user or administrator can create or delete student profiles.

Browser sessions persist across restarts and refresh automatically. They end only when the account signs out or Supabase invalidates the session.

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
2. In **SQL Editor**, run every file in `supabase/migrations` in numeric order, including `007_account_student_hierarchy.sql`. The last migration promotes an existing `impleader@gmail.com` profile and also makes a first-time Google sign-in by that address an active administrator.
3. In **Authentication > URL Configuration**, set the Site URL to `http://localhost:3000` for local work. Add `http://localhost:3000/auth/callback` to Redirect URLs.
4. In **Authentication > Providers > Email**, keep email enabled, require email confirmation, and disable public/self-service sign-ups. Administrator invitations still work.
5. In Google Cloud, create an OAuth web client. In Supabase **Authentication > Providers > Google**, copy Supabase's callback URL into the Google client's authorized redirect URIs, then put the Google client ID and secret into the Supabase provider settings. Add your local and deployed `/auth/callback` URLs to Supabase's redirect allow list.
6. In **Project Settings > API**, copy the Project URL and the publishable/anon key. In **Project Settings > API Keys**, copy the `service_role` key. The service-role key is server-only: never put it in a `NEXT_PUBLIC_` variable, commit it, or paste it into a browser console.
7. Put the three values into `.env.local` using the field names in `.env.example`.
8. Sign in with Google as `impleader@gmail.com`. This creates or activates the administrator automatically. Use the **Admin** view to invite other users.

Administrators get an **Admin** view where they can send invitations, list accounts, create or remove students under any account, inspect each student's session history, and permanently delete non-administrator accounts. Deleting an account or student also deletes the associated progress, sessions, attempts, and voice mappings.

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
7. Test the complete loop: sign in to Google as `impleader@gmail.com`, invite a second email, accept the email invitation, set a password, create a student, complete a session, refresh the browser to verify the login persists, and confirm the student's session appears in the administrator view.

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

- `app/`: Next.js pages, invitation, student, and administrator endpoints, and global styles.
- `components/math-facts-app.tsx`: voice-only practice flow and desktop UI.
- `lib/learning.ts` and `lib/fsrs-scheduler.ts`: shared fluency grading and FSRS review ordering.
- `lib/cloud-progress.ts`: Supabase cross-device synchronization.
- `supabase/migrations/`: account, student, progress, session, invitation, and row-level-security schema.
