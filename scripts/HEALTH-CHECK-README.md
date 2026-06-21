# IntractMD API Health Check

## What it checks

Runs four live API tests to verify all external services IntractMD depends on are reachable and returning valid data:

| Service | Test |
|---|---|
| **OpenFDA** | Fetches label data for "atorvastatin", confirms warnings/interactions fields present |
| **NLM RxNorm** | Resolves "warfarin" → RxCUI, confirms expected value `11289` |
| **MedlinePlus Connect** | Fetches a known drug topic, confirms feed structure present |
| **Anthropic Claude** | Makes a minimal Haiku call, confirms JSON parses correctly |

## How to run manually

```bash
# From the project root:
npm run health-check

# With API key (required for Claude test):
ANTHROPIC_API_KEY=sk-ant-... npm run health-check
```

Exit code `0` = all pass. Exit code `1` = one or more failures.

Results are saved to `logs/health-check-YYYY-MM-DD.json`.

## Scheduling (run weekly)

### Option A — Mac local cron (runs while your Mac is on)

Open crontab:
```bash
crontab -e
```

Add this line to run every Monday at 9am:
```
0 9 * * 1 cd /path/to/ddi-checker && ANTHROPIC_API_KEY=sk-ant-... npm run health-check >> /tmp/intractmd-health.log 2>&1
```

### Option B — cron-job.org (free, cloud-based, no machine required)

1. Go to [cron-job.org](https://cron-job.org) and create a free account
2. Add a new cron job that hits your health endpoint URL (see Option C below)
3. Set schedule to weekly
4. Enable email notifications on failure

### Option C — Expose a health endpoint (recommended for production)

Add a `GET /health/full` endpoint to `server.js` that runs the same checks and returns JSON. Then cron-job.org can hit `https://www.intractmd.com/health/full` weekly and alert you if it returns a non-200 response or `all_passed: false`.
