# MaxOut — 401(k) Contribution Planner

A mobile-first web app that plans all 26 biweekly paychecks: auto-caps at the IRS limit, tracks employer match (including match lost to front-loading), computes federal tax savings, compares strategies side by side, projects growth to retirement, and exports a PDF report.

**Try-before-signup:** the app is fully functional with no account — data saves to the device (localStorage). Creating an account syncs the plan to the cloud.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell, favicon (inline SVG), mobile-first layout |
| `styles.css` | Design system (ink navy / ledger green, Bricolage Grotesque + Inter + IBM Plex Mono) |
| `app.js` | Calculation engine + UI + auth + encryption + PDF |
| `irs-limits.json` | Annual IRS/SSA figures (see "IRS data" below) |
| `schema.sql` | Supabase database schema with Row Level Security |

## Quick start (no backend)

Push the folder to a GitHub repo and enable GitHub Pages — same workflow as ClearDebt. The app runs in device-only mode: everything works, the "Sign in" flow explains that accounts aren't configured yet.

## Enabling accounts + database (Supabase, ~10 minutes, free tier)

1. Create a project at supabase.com (choose a strong database password; region near your users).
2. In the dashboard: **SQL Editor → New query**, paste the contents of `schema.sql`, **Run**. This creates the `plans` table with Row Level Security so each user can only read/write their own row.
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
4. Paste both into the `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants at the top of `app.js`.
5. **Authentication → Providers → Email**: enabled by default. For a smoother demo you can turn off "Confirm email" (turn it back on for production).
6. Redeploy. The Sign in / Create account flow is now live.

The anon key is safe to ship in frontend code — it only grants what RLS policies allow.

## How the data is protected

Three layers:

1. **Transport**: all traffic is TLS (GitHub Pages and Supabase are HTTPS-only).
2. **At rest**: Supabase encrypts the Postgres volume with AES-256; Row Level Security means even a bug in the app's queries can't expose another user's rows.
3. **Zero-knowledge option**: if the user sets an encryption passphrase at signup, the plan is encrypted **in the browser** with AES-256-GCM (key derived via PBKDF2, 210,000 iterations of SHA-256, random salt + IV per save) before upload. The server stores only ciphertext. Trade-off: **a lost passphrase means unrecoverable data** — the UI says so explicitly.

Never put the `service_role` key in frontend code.

## IRS data: "automatic" updates, honestly

The IRS has **no official API** for contribution limits or brackets. The pattern that actually works:

- `irs-limits.json` holds every year's figures. The app fetches it fresh on every load (`cache: 'no-store'`), so **you update one file, every user gets it** — no code changes, no redeploy of logic.
- Each November, when the IRS publishes its COLA notice and SSA publishes the wage base, add a new year block to the JSON (copy the previous year and edit ~12 numbers). Sources: irs.gov (news release "401(k) limit increases..."), ssa.gov (contribution & benefit base), and the annual Revenue Procedure for brackets/standard deduction.
- If the fetch fails (offline), the app falls back to figures embedded in `app.js`.

Optional upgrade: point the fetch at `https://raw.githubusercontent.com/<you>/<repo>/main/irs-limits.json` so a single commit updates all deployments, or wire a scheduled GitHub Action that opens a PR reminder each November 1.

## Notes on the coaching content

The "Coaching corner" insights are rules-of-thumb from widely published guidance: Fidelity's 15% savings-rate guideline and age-based milestones (1× salary by 30 → 10× by 67), the universal "capture the full match first" advice, marginal-bracket framing for Roth vs. traditional, mega-backdoor mechanics, and SECURE 2.0's 2026 Roth catch-up mandate for high earners. I can't browse the web, so I've named sources rather than deep-linking — verify the exact Fidelity Viewpoints URLs before publishing, and keep the "education, not advice" disclaimer visible.

## Verification

The JS engine was tested against the Excel model (which was itself verified against an independent calculation): total gross, capped deferrals, match, Social Security cutoff, federal tax, scenario capping periods, front-load match loss, catch-up limits, and true-up behavior all reproduce to the cent.

## Ideas for v2

- Multiple named plans per account (drop the unique index in `schema.sql`)
- Household mode (two earners, MFJ optimization)
- State income tax tables
- HSA module alongside the 401(k)
- Email a PDF report via Supabase Edge Function
