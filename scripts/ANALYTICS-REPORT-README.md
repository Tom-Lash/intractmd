# Nightly Google Analytics Report

Emails a daily digest of GA4 traffic for www.intractmd.com to `tom@resolve.med`.

- **What it sends:** yesterday's users / sessions / page views / engagement with
  a day-over-day comparison, a last-7-days vs prior-7-days comparison, top
  pages, channels, sources, devices, countries and events, a 7-day daily trend,
  and (optionally) a short AI-written analysis paragraph.
- **When:** 03:00 UTC daily, one hour after the nightly test-suite email.
- **How:** `scripts/analytics-report.js`, scheduled from `server.js` and
  delivered through the same Resend account as the test-results email.

---

## One-time setup

The code is finished; these three steps are the parts that need your Google
account. Nothing sends until they're done.

### 1. Get the GA4 property ID

This is **not** the `G-JMVMREWQT1` measurement ID already in the page markup —
the Data API needs the numeric property ID.

Google Analytics → **Admin** → **Property Settings** → **Property ID**
(a 9-ish digit number, e.g. `398217465`).

### 2. Create a service account and download its key

1. <https://console.cloud.google.com/> → create or select a project.
2. **APIs & Services → Library** → search "Google Analytics Data API" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it something like `intractmd-analytics-reader`. No project roles are
   needed — GA permissions are granted separately in step 3.
4. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. Note the `client_email` inside it, e.g.
   `intractmd-analytics-reader@your-project.iam.gserviceaccount.com`.

### 3. Grant that service account read access to the GA property

Google Analytics → **Admin** → **Property access management** → **+** →
**Add users** → paste the `client_email` from step 2 → role **Viewer** →
uncheck "Notify new users by email" → **Add**.

### 4. Set the environment variables

Base64-encode the key file so it survives a paste into a dashboard field:

```sh
base64 -i ~/Downloads/your-service-account-key.json | tr -d '\n'
```

Then set these in Railway (**Variables** tab) and in your local `.env`:

| Variable | Value |
|---|---|
| `GA4_PROPERTY_ID` | the numeric ID from step 1 |
| `GA_SERVICE_ACCOUNT_JSON` | the base64 string from above |
| `RESEND_API_KEY` | already set — reused from the test-results email |
| `ANTHROPIC_API_KEY` | optional; adds the AI analysis paragraph |

Optional overrides: `ANALYTICS_REPORT_TO` (default `tom@resolve.med`),
`ANALYTICS_REPORT_FROM`, `ANALYTICS_REPORT_HOUR_UTC` (default `3`),
`ANALYTICS_REPORT=false` to disable without a deploy.

Locally you can skip the base64 step and point
`GOOGLE_APPLICATION_CREDENTIALS` at the unencoded `.json` file instead.

---

## Verifying it works

**Render the email without sending it** — writes
`logs/analytics-preview.html`, which you can open in a browser:

```sh
node scripts/analytics-report.js --dry-run
```

**Send a real one now:**

```sh
node scripts/analytics-report.js
```

**Trigger it on the deployed server:**

```sh
curl -X POST https://www.intractmd.com/api/admin/run-analytics-report \
  -H "X-Admin-Key: $ADMIN_API_KEY"
```

**Check status without re-querying Google:**

```sh
curl https://www.intractmd.com/api/admin/analytics-status \
  -H "X-Admin-Key: $ADMIN_API_KEY"
```

---

## Failure behaviour

Everything is defensive, because the job runs from a `setInterval` timer and an
uncaught throw there would kill the server process:

- Missing credentials, an unreachable GA API, or a bad property ID → the error
  is logged and the run returns `{ok: false}`. Nothing is emailed.
- A failed run does **not** claim the day, so the next 5-minute tick inside the
  03:00 UTC hour retries.
- `ANTHROPIC_API_KEY` unset or the API failing → the email still sends, without
  the analysis paragraph.
- `RESEND_API_KEY` unset → numbers are still pulled and written to
  `logs/analytics-latest.json`; the send is skipped.

## Files

| Path | Purpose |
|---|---|
| `scripts/analytics-report.js` | GA queries, email rendering, Resend delivery |
| `server.js` (§ NIGHTLY GOOGLE ANALYTICS REPORT) | scheduler + admin endpoints |
| `logs/analytics-latest.json` | last run's raw numbers |
| `logs/analytics-preview.html` | last `--dry-run` render |
