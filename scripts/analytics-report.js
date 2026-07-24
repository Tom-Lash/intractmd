// ════════════════════════════════════════════════════════════════════════════
// NIGHTLY GOOGLE ANALYTICS REPORT
// ════════════════════════════════════════════════════════════════════════════
// Pulls yesterday's GA4 numbers for www.intractmd.com, compares them against
// the day before and the trailing 7 days, and emails a digest via Resend.
//
// It mirrors the nightly test-results email in server.js: same Resend
// transport, same brand styling, and the same defensive posture — this runs
// from a setInterval timer, so nothing in here may throw or reject.
//
// Run standalone for a manual check:
//   node scripts/analytics-report.js            # send the email
//   node scripts/analytics-report.js --dry-run  # print JSON, send nothing
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// When run standalone (node scripts/analytics-report.js) nothing has loaded the
// .env yet, and the config constants below are read at module-load time — so
// the .env must be applied *before* them. In production this is a harmless
// no-op: server.js has already loaded dotenv, and a second call does not
// override existing values.
if (require.main === module) {
  try { require('dotenv').config(); } catch (e) { /* dotenv optional here */ }
}

const PROPERTY_ID = process.env.GA4_PROPERTY_ID || '';
const REPORT_TO = (process.env.ANALYTICS_REPORT_TO || 'tom@resolve.med')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const REPORT_FROM = process.env.ANALYTICS_REPORT_FROM || 'IntractMD Analytics <info@mail.resolve.med>';
const SITE_LABEL = process.env.ANALYTICS_SITE_LABEL || 'www.intractmd.com';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Brand palette, copied from the nightly test email so the two look related.
const NAVY = '#0D3B6E';
const CYAN = '#00B4D8';
const GREEN = '#2E7D4F';
const RED = '#A32D2D';
const GREY = '#666';

// ── Credentials ─────────────────────────────────────────────────────────────
// The service-account key is supplied either as GA_SERVICE_ACCOUNT_JSON (raw
// JSON or base64 — Railway's UI mangles multi-line values, so base64 is the
// safer form) or as a file path in GOOGLE_APPLICATION_CREDENTIALS.
function loadCredentials() {
  const raw = process.env.GA_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    // A key pasted through a dashboard usually arrives with literal "\n".
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return { credentials: { client_email: parsed.client_email, private_key: parsed.private_key } };
  }
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file && fs.existsSync(file)) return { keyFilename: file };
  throw new Error('No GA credentials: set GA_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
}

function getClient() {
  const { BetaAnalyticsDataClient } = require('@google-analytics/data');
  return new BetaAnalyticsDataClient(loadCredentials());
}

// ── Date helpers ────────────────────────────────────────────────────────────
// GA4 resolves relative dates in the property's own timezone, which is the
// definition we want — "yesterday" should mean yesterday to whoever reads the
// report, not yesterday in UTC.
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ── GA4 queries ─────────────────────────────────────────────────────────────
const TOTAL_METRICS = [
  'activeUsers', 'newUsers', 'sessions', 'engagedSessions',
  'screenPageViews', 'averageSessionDuration', 'engagementRate', 'eventCount',
];

async function runReport(client, request) {
  const [response] = await client.runReport(
    Object.assign({ property: 'properties/' + PROPERTY_ID }, request)
  );
  return response;
}

function firstRowMetrics(response, names) {
  const out = {};
  const row = response.rows && response.rows[0];
  names.forEach(function (name, i) {
    out[name] = row ? Number(row.metricValues[i].value) : 0;
  });
  return out;
}

async function pullTotals(client, startDate, endDate) {
  const res = await runReport(client, {
    dateRanges: [{ startDate: startDate, endDate: endDate }],
    metrics: TOTAL_METRICS.map(function (name) { return { name: name }; }),
  });
  return firstRowMetrics(res, TOTAL_METRICS);
}

// One breakdown query: a dimension plus a single ranking metric.
async function pullBreakdown(client, opts) {
  const res = await runReport(client, {
    dateRanges: [{ startDate: opts.startDate, endDate: opts.endDate }],
    dimensions: [{ name: opts.dimension }],
    metrics: [{ name: opts.metric }],
    orderBys: [{ metric: { metricName: opts.metric }, desc: true }],
    limit: opts.limit || 8,
  });
  return (res.rows || []).map(function (row) {
    return { label: row.dimensionValues[0].value, value: Number(row.metricValues[0].value) };
  });
}

async function pullDailyTrend(client, days) {
  const res = await runReport(client, {
    dateRanges: [{ startDate: daysAgo(days), endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: days + 1,
  });
  return (res.rows || []).map(function (row) {
    const d = row.dimensionValues[0].value; // YYYYMMDD
    return {
      date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      users: Number(row.metricValues[0].value),
      sessions: Number(row.metricValues[1].value),
    };
  });
}

/**
 * Collect every figure the email needs. Throws if GA is unreachable or the
 * property is misconfigured; callers are expected to catch.
 */
async function collectAnalytics() {
  if (!PROPERTY_ID) throw new Error('GA4_PROPERTY_ID is not set');
  const client = getClient();

  // The breakdowns cover the trailing 7 days rather than a single day: one
  // day of traffic on a site this size is too thin for a top-pages list to
  // mean anything.
  const weekStart = daysAgo(7);

  const [
    yesterday, dayBefore, week, priorWeek,
    topPages, channels, sources, devices, countries, events, trend,
  ] = await Promise.all([
    pullTotals(client, 'yesterday', 'yesterday'),
    pullTotals(client, '2daysAgo', '2daysAgo'),
    pullTotals(client, weekStart, 'yesterday'),
    pullTotals(client, daysAgo(14), daysAgo(8)),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'pagePath', metric: 'screenPageViews', limit: 8 }),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'sessionDefaultChannelGroup', metric: 'sessions', limit: 6 }),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'sessionSource', metric: 'sessions', limit: 6 }),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'deviceCategory', metric: 'sessions', limit: 4 }),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'country', metric: 'sessions', limit: 6 }),
    pullBreakdown(client, { startDate: weekStart, endDate: 'yesterday', dimension: 'eventName', metric: 'eventCount', limit: 8 }),
    pullDailyTrend(client, 7),
  ]);

  return {
    site: SITE_LABEL,
    property_id: PROPERTY_ID,
    generated_at: new Date().toISOString(),
    report_date: daysAgo(1),
    yesterday: yesterday,
    day_before: dayBefore,
    week: week,
    prior_week: priorWeek,
    top_pages: topPages,
    channels: channels,
    sources: sources,
    devices: devices,
    countries: countries,
    events: events,
    trend: trend,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────
function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function duration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function pct(ratio) {
  return (Number(ratio || 0) * 100).toFixed(1) + '%';
}

/** Percentage change, plus the arrow and colour used to render it. */
function delta(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) {
    if (c === 0) return { text: '—', color: GREY };
    return { text: 'new', color: GREEN };
  }
  const change = ((c - p) / p) * 100;
  const rounded = Math.round(change);
  if (rounded === 0) return { text: 'flat', color: GREY };
  const up = rounded > 0;
  return {
    text: (up ? '▲ ' : '▼ ') + Math.abs(rounded) + '%',
    // Up is good for every metric on this report, so the mapping is safe.
    color: up ? GREEN : RED,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Optional AI narrative ───────────────────────────────────────────────────
// A short "what changed and why it matters" paragraph. Entirely optional: with
// no ANTHROPIC_API_KEY the email simply omits the section.
async function buildNarrative(data) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const facts = {
    yesterday: data.yesterday,
    day_before: data.day_before,
    last_7_days: data.week,
    previous_7_days: data.prior_week,
    top_pages: data.top_pages.slice(0, 5),
    channels: data.channels,
    devices: data.devices,
    top_events: data.events.slice(0, 5),
  };

  const prompt =
    'You are analysing Google Analytics 4 data for ' + data.site + ', a drug-interaction '
    + 'checker used by clinicians and patients. Here is the data for ' + data.report_date + ':\n\n'
    + JSON.stringify(facts, null, 2)
    + '\n\nWrite 3-5 sentences of plain-prose analysis for the site owner. Lead with the single '
    + 'most important change. Name the specific numbers you are reasoning from. If a shift is too '
    + 'small to be meaningful at this traffic volume, say so rather than inventing a trend. '
    + 'End with one concrete thing worth looking at. No headings, no bullet points, no preamble.';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error('[Analytics] Narrative failed:', body && body.error && body.error.message);
      return null;
    }
    // Opus 4.8 can return a refusal instead of content — check before indexing.
    if (body.stop_reason === 'refusal') return null;
    const block = (body.content || []).find(function (b) { return b.type === 'text'; });
    return block ? block.text.trim() : null;
  } catch (e) {
    console.error('[Analytics] Narrative error:', e.message);
    return null;
  }
}

// ── Email body ──────────────────────────────────────────────────────────────
function statRow(label, current, previous, format) {
  const fmt = format || num;
  const d = delta(current, previous);
  return '<tr>'
    + '<td style="padding:9px 12px;border-bottom:1px solid #e5e5e5;color:#333">' + label + '</td>'
    + '<td style="padding:9px 12px;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:700;color:' + NAVY + '">' + fmt(current) + '</td>'
    + '<td style="padding:9px 12px;border-bottom:1px solid #e5e5e5;text-align:right;color:' + GREY + '">' + fmt(previous) + '</td>'
    + '<td style="padding:9px 12px;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:700;color:' + d.color + '">' + d.text + '</td>'
    + '</tr>';
}

function listTable(title, rows, valueLabel, format) {
  if (!rows || !rows.length) return '';
  const fmt = format || num;
  const max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
  const body = rows.map(function (r) {
    const width = Math.max(2, Math.round((r.value / max) * 100));
    return '<tr>'
      + '<td style="padding:6px 12px;border-bottom:1px solid #eee;color:#333;font-size:13px">'
      + escapeHtml(r.label) + '</td>'
      + '<td style="padding:6px 12px;border-bottom:1px solid #eee;width:120px">'
      // A plain background-coloured cell — the only bar chart every email
      // client renders identically.
      + '<div style="background:' + CYAN + ';height:8px;width:' + width + '%;border-radius:2px"></div>'
      + '</td>'
      + '<td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:' + NAVY + ';font-size:13px">'
      + fmt(r.value) + '</td>'
      + '</tr>';
  }).join('');

  return '<h3 style="color:' + NAVY + ';font-size:15px;margin:22px 0 8px">' + title + '</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px">'
    + '<tr style="background:#eef4fb">'
    + '<th style="padding:6px 12px;text-align:left;font-size:12px;color:' + GREY + '">Name</th>'
    + '<th style="padding:6px 12px"></th>'
    + '<th style="padding:6px 12px;text-align:right;font-size:12px;color:' + GREY + '">' + valueLabel + '</th>'
    + '</tr>' + body + '</table>';
}

function buildEmailHtml(data, narrative) {
  const y = data.yesterday;
  const p = data.day_before;
  const w = data.week;
  const pw = data.prior_week;

  const reportDate = new Date(data.report_date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const usersDelta = delta(y.activeUsers, p.activeUsers);

  const narrativeBlock = narrative
    ? '<div style="margin:0 0 20px;padding:14px 16px;background:#fff;border-left:4px solid ' + CYAN + ';border-radius:4px">'
      + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:' + GREY + ';margin-bottom:6px">Analysis</div>'
      + '<div style="font-size:14px;color:#333;line-height:1.55">' + escapeHtml(narrative) + '</div>'
      + '</div>'
    : '';

  const trendRows = (data.trend || []).map(function (d) {
    return '<tr>'
      + '<td style="padding:5px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333">' + d.date + '</td>'
      + '<td style="padding:5px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:' + NAVY + ';font-weight:700">' + num(d.users) + '</td>'
      + '<td style="padding:5px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:' + GREY + '">' + num(d.sessions) + '</td>'
      + '</tr>';
  }).join('');

  return '<div style="font-family:Calibri,Arial,sans-serif;max-width:640px;margin:0 auto">'

    + '<div style="background:' + NAVY + ';padding:24px 28px;border-radius:6px 6px 0 0">'
    + '<h1 style="color:' + CYAN + ';margin:0;font-size:22px">IntractMD™ Daily Analytics</h1>'
    + '<p style="color:#A8C8E8;margin:6px 0 0;font-size:14px">' + reportDate + ' &nbsp;·&nbsp; ' + escapeHtml(data.site) + '</p>'
    + '</div>'

    + '<div style="background:#f4f8fd;padding:24px 28px">'

    + '<h2 style="color:' + NAVY + ';margin:0 0 4px;font-size:26px">' + num(y.activeUsers) + ' users'
    + ' <span style="font-size:16px;color:' + usersDelta.color + '">' + usersDelta.text + '</span></h2>'
    + '<p style="margin:0 0 18px;font-size:13px;color:' + GREY + '">'
    + num(y.sessions) + ' sessions &nbsp;·&nbsp; ' + num(y.screenPageViews) + ' page views &nbsp;·&nbsp; '
    + duration(y.averageSessionDuration) + ' avg. session</p>'

    + narrativeBlock

    + '<h3 style="color:' + NAVY + ';font-size:15px;margin:0 0 8px">Yesterday vs. the day before</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px;font-size:14px">'
    + '<tr style="background:' + NAVY + ';color:#fff">'
    + '<th style="padding:8px 12px;text-align:left">Metric</th>'
    + '<th style="padding:8px 12px;text-align:right">Yesterday</th>'
    + '<th style="padding:8px 12px;text-align:right">Prev. day</th>'
    + '<th style="padding:8px 12px;text-align:right">Change</th>'
    + '</tr>'
    + statRow('Active users', y.activeUsers, p.activeUsers)
    + statRow('New users', y.newUsers, p.newUsers)
    + statRow('Sessions', y.sessions, p.sessions)
    + statRow('Engaged sessions', y.engagedSessions, p.engagedSessions)
    + statRow('Page views', y.screenPageViews, p.screenPageViews)
    + statRow('Events', y.eventCount, p.eventCount)
    + statRow('Engagement rate', y.engagementRate, p.engagementRate, pct)
    + statRow('Avg. session', y.averageSessionDuration, p.averageSessionDuration, duration)
    + '</table>'

    + '<h3 style="color:' + NAVY + ';font-size:15px;margin:22px 0 8px">Last 7 days vs. the 7 before</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px;font-size:14px">'
    + '<tr style="background:' + NAVY + ';color:#fff">'
    + '<th style="padding:8px 12px;text-align:left">Metric</th>'
    + '<th style="padding:8px 12px;text-align:right">Last 7d</th>'
    + '<th style="padding:8px 12px;text-align:right">Prior 7d</th>'
    + '<th style="padding:8px 12px;text-align:right">Change</th>'
    + '</tr>'
    + statRow('Active users', w.activeUsers, pw.activeUsers)
    + statRow('New users', w.newUsers, pw.newUsers)
    + statRow('Sessions', w.sessions, pw.sessions)
    + statRow('Page views', w.screenPageViews, pw.screenPageViews)
    + statRow('Engagement rate', w.engagementRate, pw.engagementRate, pct)
    + '</table>'

    + listTable('Top pages (7 days)', data.top_pages, 'Views')
    + listTable('Traffic channels (7 days)', data.channels, 'Sessions')
    + listTable('Top sources (7 days)', data.sources, 'Sessions')
    + listTable('Devices (7 days)', data.devices, 'Sessions')
    + listTable('Countries (7 days)', data.countries, 'Sessions')
    + listTable('Events (7 days)', data.events, 'Count')

    + '<h3 style="color:' + NAVY + ';font-size:15px;margin:22px 0 8px">Daily trend</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px">'
    + '<tr style="background:#eef4fb">'
    + '<th style="padding:6px 12px;text-align:left;font-size:12px;color:' + GREY + '">Date</th>'
    + '<th style="padding:6px 12px;text-align:right;font-size:12px;color:' + GREY + '">Users</th>'
    + '<th style="padding:6px 12px;text-align:right;font-size:12px;color:' + GREY + '">Sessions</th>'
    + '</tr>' + trendRows + '</table>'

    + '</div>'

    + '<div style="background:' + NAVY + ';padding:14px 28px;border-radius:0 0 6px 6px;text-align:center">'
    + '<a href="https://analytics.google.com/analytics/web/#/p' + escapeHtml(data.property_id) + '/reports/intelligenthome" '
    + 'style="color:' + CYAN + ';font-size:13px;text-decoration:none">Open in Google Analytics</a>'
    + '<p style="color:#6688AA;font-size:11px;margin:6px 0 0">© 2026 Resolve Medical, LLC &nbsp;·&nbsp; IntractMD™</p>'
    + '</div>'

    + '</div>';
}

function buildSubject(data) {
  const d = delta(data.yesterday.activeUsers, data.day_before.activeUsers);
  const arrow = d.text === '—' || d.text === 'flat' ? '→' : d.text.charAt(0);
  return arrow + ' IntractMD Analytics — ' + num(data.yesterday.activeUsers) + ' users, '
    + num(data.yesterday.sessions) + ' sessions — ' + data.report_date;
}

// ── Delivery ────────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('[Analytics] RESEND_API_KEY not set — skipping email');
    return { sent: false, reason: 'RESEND_API_KEY not set' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ from: REPORT_FROM, to: REPORT_TO, subject: subject, html: html }),
  });
  const body = await res.json();
  if (body.id) {
    console.log('[Analytics] Report emailed to ' + REPORT_TO.join(', ') + ' — id:', body.id);
    return { sent: true, id: body.id };
  }
  console.error('[Analytics] Email send failed:', JSON.stringify(body));
  return { sent: false, reason: (body.message || 'unknown Resend error') };
}

/**
 * Full nightly job: pull GA, write a narrative, email the digest, mirror the
 * raw numbers to logs/analytics-latest.json.
 *
 * Never throws — returns a summary describing what happened either way.
 */
async function runAnalyticsReport(options) {
  const opts = options || {};
  const startedAt = Date.now();
  try {
    console.log('[Analytics] Pulling GA4 property ' + PROPERTY_ID + ' for ' + SITE_LABEL);
    const data = await collectAnalytics();
    const narrative = await buildNarrative(data);
    const html = buildEmailHtml(data, narrative);
    const subject = buildSubject(data);

    const delivery = opts.dryRun ? { sent: false, reason: 'dry run' } : await sendEmail(subject, html);

    const summary = {
      ok: true,
      trigger: opts.trigger || 'scheduled',
      report_date: data.report_date,
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
      email: delivery,
      narrative: narrative,
      data: data,
    };

    try {
      if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOGS_DIR, 'analytics-latest.json'), JSON.stringify(summary, null, 2));
      // A dry run is for eyeballing the email, so also drop the rendered HTML
      // where it can be opened in a browser.
      if (opts.dryRun) {
        const previewPath = path.join(LOGS_DIR, 'analytics-preview.html');
        fs.writeFileSync(previewPath, html);
        console.log('[Analytics] Preview written to ' + previewPath);
      }
    } catch (e) {
      console.error('[Analytics] Could not write log file:', e.message);
    }

    if (opts.dryRun) console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (e) {
    console.error('[Analytics] Report failed:', e.message);
    return {
      ok: false,
      trigger: opts.trigger || 'scheduled',
      error: e.message,
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }
}

module.exports = {
  runAnalyticsReport,
  collectAnalytics,
  buildEmailHtml,
  buildSubject,
};

// Standalone entry point. (dotenv is loaded at the top of this file when run
// directly, so the config constants pick up .env values.)
if (require.main === module) {
  runAnalyticsReport({ trigger: 'cli', dryRun: process.argv.includes('--dry-run') })
    .then(function (s) { process.exit(s.ok ? 0 : 1); });
}
