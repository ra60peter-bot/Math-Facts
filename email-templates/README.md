# Math Facts authentication emails

Status: applied to production Supabase on September 28, 2026. The account owner entered and saved the Gmail SMTP credential. Custom SMTP is enabled; Invite user and Reset password subjects/bodies were saved and reloaded to verify persistence. The dashboard confirms 30 emails/hour. No invitation/test email has been sent by the assistant; inbox delivery and the full acceptance flow still need a recipient test.

Supabase project: `xfpfdnnkscalmwmgwhcm`.

## Gmail SMTP

- Sender name: `Math Facts`
- Sender email / username: `auto.mathfacts@gmail.com`
- Host: `smtp.gmail.com`
- Port: `465` (SSL)
- Minimum interval per recipient: `60` seconds (unchanged)
- Password: Google app password created under `auto.mathfacts@gmail.com`, entered directly into Supabase; never put it in this repository or chat. An app password from `impleader@gmail.com` will not work for this sender. The app administrator remains `impleader@gmail.com`; this change is only for outgoing email.
- Verified Supabase limit: 30 emails/hour after enabling SMTP. This removes the two/hour bottleneck; increase only as needed within Google's limits.

## Applied templates

In Authentication > Emails > Templates:

| Template | Subject | Body |
| --- | --- | --- |
| Invite user | You're invited to Math Facts - set up your family's account | `invite.html` |
| Reset password | Math Facts - set up or reset your password | `recovery.html` |

Preserve the `{{ .ConfirmationURL }}` placeholders. Supabase supplies the recipient-specific secure link; do not substitute the homepage URL. Existing app callbacks and invitation authorization remain unchanged. The existing invitation endpoint sends the Reset password template for previously created profiles, so that template intentionally covers both use cases.

Next verification: send an invitation to a user-chosen test address and confirm sender, subject, link, password creation, and student setup. Changing templates and settings does not require a Vercel app deployment.
