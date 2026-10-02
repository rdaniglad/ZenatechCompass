# Setting up Compass on Supabase

About 15 minutes. You need your Supabase project and a free Vercel account (or Netlify, or any host that serves plain web files).

## 1. Create the database (once)

1. Open `supabase/schema.sql` and check the line marked `>>> OWNER EMAIL <<<`. It invites **daniela@zenatech.com** as the first Admin. Change it if the owner should be someone else.
2. In Supabase: **SQL Editor → New query**, paste the whole file and click **Run**.
3. The result grid should list six checks, each marked **ok**.

You can run the file again later, for example after updating Compass. It updates things in place and keeps your data.

## 2. Configure sign-in

In Supabase, go to **Authentication**:

- **Sign In / Providers → Email**:
  - **Enable Email provider**: on.
  - **Confirm email**: on. This proves people own the email address they were invited with, so leave it on.
  - **Minimum password length**: 10.
- **Sign In / Providers → User Signups**: **Allow new users to sign up** stays on. Compass still only accepts emails an Admin has invited; the database refuses everyone else.
- **URL Configuration**:
  - **Site URL**: your Compass address, for example `https://zenatech-compass.vercel.app`. Until you deploy, use `http://localhost:8080`.
  - **Redirect URLs**: add `https://YOUR-DOMAIN/login.html` and `http://localhost:8080/login.html`. These are where confirmation and password-reset emails send people back.
- **Emails → SMTP Settings** (before inviting your team): Supabase's built-in email is only for testing and sends just a few emails per hour. Connect your company mail server or a service like Resend, Postmark or SendGrid so confirmation and reset emails arrive reliably.

## 3. Connect the app to your project

Edit `web/config.js`:

```js
supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',   // Project Settings → API → Project URL
supabaseKey: 'sb_publishable_…',                         // your publishable key (already filled in)
```

Both values are safe to publish. **Never** put the `service_role` or secret key in this file or in chat.

## 4. Try it on your computer (optional)

```
cd web
npx serve -l 8080
```

Or, if you have Python: `python -m http.server 8080`. Then open http://localhost:8080.

## 5. Put it online with Vercel

1. Go to vercel.com and sign in with GitHub (the **rdaniglad** account).
2. **Add New → Project**, import **rdaniglad/ZenatechCompass**.
3. Set **Root Directory** to `web` and **Framework Preset** to **Other**. Leave the build settings empty.
4. Click **Deploy**. You'll get an address like `https://zenatech-compass.vercel.app`.
5. Back in Supabase, put that address into **Site URL** and **Redirect URLs** (step 2).

From then on, every `git push` redeploys automatically.

## 6. Create your owner account

1. Open `https://YOUR-DOMAIN/login.html?invite=daniela@zenatech.com`.
2. Enter your name and a password.
3. Open the confirmation email and click the link. You're signed in as the owner, who is always an Admin.

## 7. Invite your team

In Compass go to **Permissions → + Invite people**, enter their email and choose a role. Send them the link it gives you. They create their account, confirm their email, and land in Compass with that role.

- **Forgot password:** people click **Forgot your password?** on the sign-in page and get an email. Admins can also send one with **Reset password** on Permissions.
- **Turn off:** blocks that person from all data immediately.

## Optional: AI suggestions on the Discover page

1. In Supabase: **Edge Functions → Deploy a new function**, name it `discover`, paste in `supabase/functions/discover/index.ts`, and deploy.
2. **Edge Functions → Secrets**: add `ANTHROPIC_API_KEY` with your key from console.anthropic.com.
3. In `web/config.js`, set `aiDiscover: true`.

## What protects the data

The rules in `supabase/schema.sql` are enforced by the database itself, so they hold even for someone who bypasses the web page:

| | Attendee | Manager | Admin |
|---|---|---|---|
| See events, roster, library, activity | ✓ | ✓ | ✓ |
| Join or leave an event team, update **own** travel | ✓ | ✓ | ✓ |
| Create and edit events, pack collateral | | ✓ | ✓ |
| Delete events | | | ✓ |
| Edit the roster | own link only | own link only | ✓ |
| Feedback reports | own only | everyone's | everyone's |
| Invite people, change roles, turn accounts off | | | ✓ |

- Nobody can read anything without signing in.
- Only invited emails can create an account.
- Turned-off accounts can't read or change anything.
- The owner is always an Admin and can't be turned off.
- Photos sit in a public storage bucket under random, unguessable names, so they display like normal images. Anyone who has a photo's exact link can open it.
