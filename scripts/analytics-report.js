#!/usr/bin/env node
/**
 * IntractMD GA4 Analytics Report
 * Pulls yesterday's Google Analytics data and emails a summary to tom@resolve.med
 * 
 * Run manually: node scripts/analytics-report.js
 * Run dry:      node scripts/analytics-report.js --dry-run
 */

'use strict';

const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_TO = process.env.ANALYTICS_REPORT_TO || 'tom@resolve.med';

if (!PROPERTY_ID) { console.error('GA4_PROPERTY_ID not set'); process.exit(1); }
if (!process.env.GA_SERVICE_ACCOUNT_JSON) { console.error('GA_SERVICE_ACCOUNT_JSON not set'); process.exit(1); }

// Decode service account JSON
let serviceAccount;
try {
  const raw = Buffer.from(process.env.GA_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
  serviceAccount = JSON.parse(raw);
} catch(e) {
  try {
    serviceAccount = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON);
  } catch(e2) {
    console.error('Failed to parse GA_SERVICE_ACCOUNT_JSON:', e2.message);
    process.exit(1);
  }
}

// Date helpers
function dateStr(d) {
  return d.toISOString().slice(0, 10);
}
function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return dateStr(d);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return dateStr(d);
}

// Simple JWT creation for Google OAuth
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })));

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const sig = base64url(sign.sign(sa.private_key));
  return header + '.' + payload + '.' + sig;
}

function httpsPost(hostname, path, data, headers) {
  return new Promise(function(resolve, reject) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const opts = {
      hostname, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers)
    };
    const req = https.request(opts, function(res) {
      let raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const jwt = createJWT(serviceAccount);
  const res = await httpsPost('oauth2.googleapis.com', '/token', 
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  if (!res.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(res));
  return res.access_token;
}

async function runReport(token, dateRange, dimensions, metrics) {
  const res = await httpsPost(
    'analyticsdata.googleapis.com',
    '/v1beta/properties/' + PROPERTY_ID + ':runReport',
    { dateRanges: [dateRange], dimensions: dimensions.map(function(n){ return {name:n}; }), metrics: metrics.map(function(n){ return {name:n}; }) },
    { Authorization: 'Bearer ' + token }
  );
  return res;
}

function getMetricVal(report, metricName) {
  if (!report || !report.rows || !report.rows.length) return 0;
  const idx = (report.metricHeaders || []).findIndex(function(h){ return h.name === metricName; });
  if (idx < 0) return 0;
  return parseFloat(report.rows[0].metricValues[idx].value) || 0;
}

function getTopDimension(report, n) {
  if (!report || !report.rows) return [];
  return report.rows.slice(0, n).map(function(row) {
    return { label: row.dimensionValues[0].value, value: parseInt(row.metricValues[0].value) || 0 };
  });
}

// Sites are separated on the hostName dimension. Both streams feed one GA4
// property, so without this the consumer traffic on intractmd.com swamps the
// handful of visits that matter on resolve.med.
const SITES = [
  { host: 'intractmd.com',  label: 'IntractMD',       note: 'Patient app and pilot surfaces' },
  { host: 'resolve.med',    label: 'Resolve Medical', note: 'Corporate site' },
];

// GA4 reports www.intractmd.com and intractmd.com as distinct hostnames, so
// match on suffix rather than equality.
function hostMatches(rowHost, site) {
  const h = String(rowHost || '').toLowerCase().replace(/^www\./, '');
  return h === site || h.endsWith('.' + site);
}

const CORE_METRICS = ['activeUsers','newUsers','sessions','engagedSessions',
                      'screenPageViews','averageSessionDuration','engagementRate','eventCount'];

// Turn a hostName-dimensioned report into { host: {metric: value} }.
function byHost(report) {
  const out = {};
  if (!report || !report.rows) return out;
  const mIdx = {};
  (report.metricHeaders || []).forEach(function(h, i) { mIdx[h.name] = i; });
  report.rows.forEach(function(row) {
    const host = row.dimensionValues[0].value;
    const rec = {};
    CORE_METRICS.forEach(function(m) {
      rec[m] = mIdx[m] != null ? (parseFloat(row.metricValues[mIdx[m]].value) || 0) : 0;
    });
    out[host] = rec;
  });
  return out;
}

// Sum every hostname belonging to one site. Rates and durations are averaged
// weighted by sessions rather than summed, which would be meaningless.
function forSite(hostMap, site) {
  const rec = {};
  CORE_METRICS.forEach(function(m) { rec[m] = 0; });
  let weighted = { averageSessionDuration: 0, engagementRate: 0 }, sess = 0;
  Object.keys(hostMap).forEach(function(h) {
    if (!hostMatches(h, site)) return;
    const r = hostMap[h];
    ['activeUsers','newUsers','sessions','engagedSessions','screenPageViews','eventCount']
      .forEach(function(m) { rec[m] += r[m] || 0; });
    const sPart = r.sessions || 0;
    sess += sPart;
    weighted.averageSessionDuration += (r.averageSessionDuration || 0) * sPart;
    weighted.engagementRate       += (r.engagementRate || 0) * sPart;
  });
  rec.averageSessionDuration = sess ? weighted.averageSessionDuration / sess : 0;
  rec.engagementRate        = sess ? weighted.engagementRate / sess : 0;
  return rec;
}

// Rows of a two-dimension report [hostName, X] filtered to one site.
function dimForSite(report, site, n) {
  if (!report || !report.rows) return [];
  const agg = {};
  report.rows.forEach(function(row) {
    if (!hostMatches(row.dimensionValues[0].value, site)) return;
    const label = row.dimensionValues[1].value;
    agg[label] = (agg[label] || 0) + (parseInt(row.metricValues[0].value) || 0);
  });
  return Object.keys(agg).map(function(k) { return { label: k, value: agg[k] }; })
    .sort(function(a, b) { return b.value - a.value; }).slice(0, n);
}

async function fetchAnalytics(token) {
  const yd = yesterday();
  const db = daysAgo(2);
  const w1start = daysAgo(7);
  const w2start = daysAgo(14);

  const [ydR, dbR, w1R, w2R, pagesR, chanR, devR, ctryR] = await Promise.all([
    runReport(token, {startDate:yd,      endDate:yd}, ['hostName'], CORE_METRICS),
    runReport(token, {startDate:db,      endDate:db}, ['hostName'], CORE_METRICS),
    runReport(token, {startDate:w1start, endDate:yd}, ['hostName'], CORE_METRICS),
    runReport(token, {startDate:w2start, endDate:db}, ['hostName'], CORE_METRICS),
    runReport(token, {startDate:yd, endDate:yd}, ['hostName','pagePath'], ['screenPageViews']),
    runReport(token, {startDate:yd, endDate:yd}, ['hostName','sessionDefaultChannelGroup'], ['sessions']),
    runReport(token, {startDate:yd, endDate:yd}, ['hostName','deviceCategory'], ['sessions']),
    runReport(token, {startDate:yd, endDate:yd}, ['hostName','country'], ['activeUsers']),
  ]);

  const ydH = byHost(ydR), dbH = byHost(dbR), w1H = byHost(w1R), w2H = byHost(w2R);

  const sites = SITES.map(function(s) {
    return {
      host: s.host, label: s.label, note: s.note,
      yesterday:  forSite(ydH, s.host),
      day_before: forSite(dbH, s.host),
      week:       forSite(w1H, s.host),
      prior_week: forSite(w2H, s.host),
      top_pages:  dimForSite(pagesR, s.host, 5),
      channels:   dimForSite(chanR,  s.host, 5),
      devices:    dimForSite(devR,   s.host, 5),
      countries:  dimForSite(ctryR,  s.host, 5),
    };
  });

  // Any hostname not matching a configured site — a preview deploy, or a new
  // domain someone tagged. Surfaced rather than silently dropped.
  const known = Object.keys(ydH).filter(function(h) {
    return !SITES.some(function(s) { return hostMatches(h, s.host); });
  });

  return { date: yd, sites: sites, unmatched_hosts: known };
}

function fmt(n, isTime) {
  n = parseFloat(n) || 0;
  if (isTime) {
    const m = Math.floor(n / 60);
    const s = Math.round(n % 60);
    return m + 'm ' + s + 's';
  }
  if (n === 0) return '0';
  return n % 1 === 0 ? n.toString() : n.toFixed(1);
}

function delta(curr, prev) {
  // Coerce first — engagement rate used to arrive here as '45%' strings,
  // which made the subtraction NaN and rendered '▼ NaN%' in every email.
  curr = parseFloat(curr) || 0; prev = parseFloat(prev) || 0;
  if (!prev || prev === 0) return curr > 0 ? ' <span style="color:#2E7D4F">▲ new</span>' : '';
  const pct = Math.round((curr - prev) / prev * 100);
  if (pct === 0) return ' <span style="color:#888">—</span>';
  const color = pct > 0 ? '#2E7D4F' : '#A32D2D';
  const arrow = pct > 0 ? '▲' : '▼';
  return ' <span style="color:'+color+'">'+arrow+' '+Math.abs(pct)+'%</span>';
}

function buildEmail(data, reportDate) {
  const rowStyle  = 'padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:14px;';
  const labelStyle = rowStyle + 'color:#555;';
  const valStyle   = rowStyle + 'color:#1a1a2e;font-weight:600;text-align:right;';

  function metricRow(label, curr, prev, kind) {
    var shown;
    if (kind === 'time') shown = fmt(curr, true);
    else if (kind === 'pct') shown = Math.round((curr || 0) * 100) + '%';
    else shown = fmt(curr);
    return '<tr><td style="'+labelStyle+'">'+label+'</td><td style="'+valStyle+'">'
      + shown + delta(curr, prev) + '</td></tr>';
  }

  function topList(items) {
    if (!items || !items.length) return '<p style="color:#888;font-size:13px;margin:4px 0">No data</p>';
    return items.map(function(item) {
      return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #f0f0f0">'
        + '<span style="color:#555">'+item.label+'</span>'
        + '<span style="color:#1B6EC2;font-weight:600">'+item.value+'</span></div>';
    }).join('');
  }

  // One block per site. Each is self-contained so a site with no traffic reads
  // as "nothing yesterday" rather than as a broken report.
  function siteBlock(site, tint) {
    const d = site.yesterday, db = site.day_before, w = site.week, pw = site.prior_week;
    const quiet = d.sessions === 0 && d.activeUsers === 0;
    return '<div style="background:'+tint+';padding:20px 28px;border-top:3px solid #0D3B6E">'
      + '<h2 style="color:#0D3B6E;font-size:17px;margin:0 0 2px">'+site.label+'</h2>'
      + '<p style="color:#8195a8;font-size:12px;margin:0 0 14px">'+site.host+' &nbsp;·&nbsp; '+site.note+'</p>'
      + (quiet
          ? '<p style="background:#FDF3E3;border-left:3px solid #D97706;padding:10px 14px;margin:0 0 14px;'
            + 'color:#854F0B;font-size:13px">No traffic recorded yesterday.</p>'
          : '')
      + '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">'
      + '<tr><td colspan="2" style="padding:0 0 6px;font-size:12px;color:#8195a8;'
      + 'text-transform:uppercase;letter-spacing:.04em">Yesterday vs day before</td></tr>'
      + metricRow('Active Users', d.activeUsers, db.activeUsers)
      + metricRow('New Users', d.newUsers, db.newUsers)
      + metricRow('Sessions', d.sessions, db.sessions)
      + metricRow('Page Views', d.screenPageViews, db.screenPageViews)
      + metricRow('Avg Session Duration', d.averageSessionDuration, db.averageSessionDuration, 'time')
      + metricRow('Engagement Rate', d.engagementRate, db.engagementRate, 'pct')
      + '</table>'
      + '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">'
      + '<tr><td colspan="2" style="padding:0 0 6px;font-size:12px;color:#8195a8;'
      + 'text-transform:uppercase;letter-spacing:.04em">Last 7 days vs prior 7</td></tr>'
      + metricRow('Active Users', w.activeUsers, pw.activeUsers)
      + metricRow('Sessions', w.sessions, pw.sessions)
      + metricRow('Page Views', w.screenPageViews, pw.screenPageViews)
      + '</table>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">'
      + '<div><h3 style="color:#0D3B6E;font-size:13px;margin:0 0 6px">Top Pages</h3>'+topList(site.top_pages)+'</div>'
      + '<div><h3 style="color:#0D3B6E;font-size:13px;margin:0 0 6px">Channels</h3>'+topList(site.channels)+'</div>'
      + '<div><h3 style="color:#0D3B6E;font-size:13px;margin:0 0 6px">Devices</h3>'+topList(site.devices)+'</div>'
      + '<div><h3 style="color:#0D3B6E;font-size:13px;margin:0 0 6px">Countries</h3>'+topList(site.countries)+'</div>'
      + '</div></div>';
  }

  const totalUsers = data.sites.reduce(function(a, s) { return a + s.yesterday.activeUsers; }, 0);
  const summary = data.sites.map(function(s) {
    return s.label + ' ' + s.yesterday.activeUsers;
  }).join(' &nbsp;·&nbsp; ');

  const unmatched = (data.unmatched_hosts && data.unmatched_hosts.length)
    ? '<div style="background:#FDF3E3;padding:12px 28px;border-left:4px solid #D97706">'
      + '<p style="color:#854F0B;margin:0;font-size:13px"><strong>Traffic from unrecognised hostnames:</strong> '
      + data.unmatched_hosts.join(', ')
      + '. Add these to SITES in scripts/analytics-report.js to report them separately.</p></div>'
    : '';

  const tints = ['#f4f8fd', '#ffffff'];

  return '<div style="font-family:Calibri,Arial,sans-serif;max-width:640px;margin:0 auto">'
    + '<div style="background:#0D3B6E;padding:24px 28px;border-radius:6px 6px 0 0">'
    + '<h1 style="color:#00B4D8;margin:0;font-size:20px">Resolve Medical — Site Analytics</h1>'
    + '<p style="color:#A8C8E8;margin:6px 0 0;font-size:13px">'+reportDate
    + ' &nbsp;·&nbsp; GA4 property '+PROPERTY_ID+'</p>'
    + '<p style="color:#7FB3DC;margin:8px 0 0;font-size:13px">Active users yesterday — '+summary+'</p>'
    + '</div>'
    + unmatched
    + data.sites.map(function(s, i) { return siteBlock(s, tints[i % tints.length]); }).join('')
    + '<div style="background:#0D3B6E;padding:14px 28px;border-radius:0 0 6px 6px;text-align:center">'
    + '<a href="https://analytics.google.com" style="color:#00B4D8;font-size:13px;text-decoration:none">Open Google Analytics</a>'
    + '<p style="color:#6688AA;font-size:11px;margin:6px 0 0">© 2026 Resolve Medical, LLC</p>'
    + '</div></div>';
}

async function sendEmail(html, reportDate, data) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const parts = data.sites.map(function(s) {
    return s.label + ' ' + s.yesterday.activeUsers + 'u/' + s.yesterday.sessions + 's';
  });
  const anyTraffic = data.sites.some(function(s) {
    return s.yesterday.sessions > 0 || s.yesterday.activeUsers > 0;
  });
  const subject = anyTraffic
    ? '📊 Site Analytics — ' + parts.join(' · ') + ' — ' + reportDate
    : '📊 Site Analytics — No traffic yesterday — ' + reportDate;

  const res = await httpsPost('api.resend.com', '/emails', {
    from: 'IntractMD Analytics <info@mail.resolve.med>',
    to: [REPORT_TO],
    subject: subject,
    html: html
  }, { Authorization: 'Bearer ' + RESEND_API_KEY });

  if (res.id) console.log('[Analytics] Email sent — id:', res.id);
  else console.error('[Analytics] Email failed:', JSON.stringify(res));
  return res;
}

async function main() {
  console.log('[Analytics] Starting report for', yesterday(), DRY_RUN ? '(dry run)' : '');
  try {
    const token = await getAccessToken();
    console.log('[Analytics] Access token obtained');
    const data = await fetchAnalytics(token);
    data.sites.forEach(function(st) {
      console.log('[Analytics] ' + st.label + ' (' + st.host + ') — sessions:', st.yesterday.sessions, 'users:', st.yesterday.activeUsers);
    });
    if (data.unmatched_hosts.length) console.warn('[Analytics] Unrecognised hostnames:', data.unmatched_hosts.join(', '));
    const html = buildEmail(data, data.date);
    if (DRY_RUN) {
      console.log('[Analytics] Dry run — email not sent');
      const fs = require('fs');
      fs.writeFileSync('logs/analytics-preview.html', html);
      fs.writeFileSync('logs/analytics-latest.json', JSON.stringify({ ok:true, trigger:'cli', report_date:data.date, data:data, email:{sent:false,reason:'dry run'} }, null, 2));
      console.log('[Analytics] Preview saved to logs/analytics-preview.html');
    } else {
      await sendEmail(html, data.date, data);
      const fs = require('fs');
      fs.writeFileSync('logs/analytics-latest.json', JSON.stringify({ ok:true, trigger:'scheduled', report_date:data.date, data:data, email:{sent:true} }, null, 2));
    }
    console.log('[Analytics] Done');
  } catch(e) {
    console.error('[Analytics] Error:', e.message);
    process.exit(1);
  }
}

main();
