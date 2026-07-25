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

async function fetchAnalytics(token) {
  const yd = yesterday();
  const db = daysAgo(2);
  const w1start = daysAgo(7);
  const w2start = daysAgo(14);

  const coreMetrics = ['activeUsers','newUsers','sessions','engagedSessions','screenPageViews','averageSessionDuration','engagementRate','eventCount'];

  const [ydReport, dbReport, w1Report, w2Report, pagesReport, channelsReport, devicesReport, countriesReport] = await Promise.all([
    runReport(token, {startDate:yd, endDate:yd}, [], coreMetrics),
    runReport(token, {startDate:db, endDate:db}, [], coreMetrics),
    runReport(token, {startDate:w1start, endDate:yd}, [], coreMetrics),
    runReport(token, {startDate:w2start, endDate:db}, [], coreMetrics),
    runReport(token, {startDate:yd, endDate:yd}, ['pagePath'], ['screenPageViews']),
    runReport(token, {startDate:yd, endDate:yd}, ['sessionDefaultChannelGroup'], ['sessions']),
    runReport(token, {startDate:yd, endDate:yd}, ['deviceCategory'], ['sessions']),
    runReport(token, {startDate:yd, endDate:yd}, ['country'], ['activeUsers']),
  ]);

  function extract(report) {
    const obj = {};
    coreMetrics.forEach(function(m) { obj[m] = getMetricVal(report, m); });
    return obj;
  }

  return {
    date: yd,
    yesterday: extract(ydReport),
    day_before: extract(dbReport),
    week: extract(w1Report),
    prior_week: extract(w2Report),
    top_pages: getTopDimension(pagesReport, 5),
    channels: getTopDimension(channelsReport, 5),
    devices: getTopDimension(devicesReport, 5),
    countries: getTopDimension(countriesReport, 5),
  };
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
  if (!prev || prev === 0) return curr > 0 ? ' <span style="color:#2E7D4F">▲ new</span>' : '';
  const pct = Math.round((curr - prev) / prev * 100);
  if (pct === 0) return ' <span style="color:#888">—</span>';
  const color = pct > 0 ? '#2E7D4F' : '#A32D2D';
  const arrow = pct > 0 ? '▲' : '▼';
  return ' <span style="color:'+color+'">'+arrow+' '+Math.abs(pct)+'%</span>';
}

function buildEmail(data, reportDate) {
  const d = data.yesterday;
  const db = data.day_before;
  const w = data.week;
  const pw = data.prior_week;

  const noData = d.sessions === 0 && d.activeUsers === 0;

  const rowStyle = 'padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:14px;';
  const labelStyle = rowStyle + 'color:#555;';
  const valStyle = rowStyle + 'color:#1a1a2e;font-weight:600;text-align:right;';

  function metricRow(label, curr, prev, isTime) {
    return '<tr><td style="'+labelStyle+'">'+label+'</td><td style="'+valStyle+'">'+fmt(curr,isTime)+delta(curr,prev)+'</td></tr>';
  }

  function topList(items) {
    if (!items || !items.length) return '<p style="color:#888;font-size:13px;margin:4px 0">No data</p>';
    return items.map(function(item) {
      return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #f0f0f0">'
        + '<span style="color:#555">'+item.label+'</span>'
        + '<span style="color:#1B6EC2;font-weight:600">'+item.value+'</span>'
        + '</div>';
    }).join('');
  }

  const html = '<div style="font-family:Calibri,Arial,sans-serif;max-width:640px;margin:0 auto">'
    + '<div style="background:#0D3B6E;padding:24px 28px;border-radius:6px 6px 0 0">'
    + '<h1 style="color:#00B4D8;margin:0;font-size:20px">IntractMD™ Analytics Report</h1>'
    + '<p style="color:#A8C8E8;margin:6px 0 0;font-size:13px">'+reportDate+' &nbsp;·&nbsp; intractmd.com &nbsp;·&nbsp; GA4 Property 542871195</p>'
    + '</div>'

    + (noData
      ? '<div style="background:#FDF3E3;padding:20px 28px;border-left:4px solid #D97706"><p style="color:#854F0B;margin:0;font-size:14px"><strong>No traffic recorded yesterday.</strong> This is normal during early outreach phase. Data will appear once pilot recipients visit the site.</p></div>'
      : '')

    + '<div style="background:#f4f8fd;padding:20px 28px">'
    + '<h2 style="color:#0D3B6E;font-size:16px;margin:0 0 12px">Yesterday vs Day Before</h2>'
    + '<table style="width:100%;border-collapse:collapse">'
    + metricRow('Active Users', d.activeUsers, db.activeUsers)
    + metricRow('New Users', d.newUsers, db.newUsers)
    + metricRow('Sessions', d.sessions, db.sessions)
    + metricRow('Page Views', d.screenPageViews, db.screenPageViews)
    + metricRow('Avg Session Duration', d.averageSessionDuration||0, db.averageSessionDuration||0, true)
    + metricRow('Engagement Rate', Math.round((d.engagementRate||0)*100)+'%', Math.round((db.engagementRate||0)*100)+'%')
    + '</table></div>'

    + '<div style="background:#fff;padding:20px 28px">'
    + '<h2 style="color:#0D3B6E;font-size:16px;margin:0 0 12px">Last 7 Days vs Prior 7 Days</h2>'
    + '<table style="width:100%;border-collapse:collapse">'
    + metricRow('Active Users', w.activeUsers, pw.activeUsers)
    + metricRow('New Users', w.newUsers, pw.newUsers)
    + metricRow('Sessions', w.sessions, pw.sessions)
    + metricRow('Page Views', w.screenPageViews, pw.screenPageViews)
    + metricRow('Avg Session Duration', w.averageSessionDuration||0, pw.averageSessionDuration||0, true)
    + '</table></div>'

    + '<div style="background:#f4f8fd;padding:20px 28px;display:grid;grid-template-columns:1fr 1fr;gap:20px">'
    + '<div><h3 style="color:#0D3B6E;font-size:14px;margin:0 0 8px">Top Pages</h3>'+topList(data.top_pages)+'</div>'
    + '<div><h3 style="color:#0D3B6E;font-size:14px;margin:0 0 8px">Channels</h3>'+topList(data.channels)+'</div>'
    + '<div><h3 style="color:#0D3B6E;font-size:14px;margin:0 0 8px">Devices</h3>'+topList(data.devices)+'</div>'
    + '<div><h3 style="color:#0D3B6E;font-size:14px;margin:0 0 8px">Countries</h3>'+topList(data.countries)+'</div>'
    + '</div>'

    + '<div style="background:#0D3B6E;padding:14px 28px;border-radius:0 0 6px 6px;text-align:center">'
    + '<a href="https://analytics.google.com" style="color:#00B4D8;font-size:13px;text-decoration:none">Open Google Analytics</a>'
    + '<p style="color:#6688AA;font-size:11px;margin:6px 0 0">© 2026 Resolve Medical, LLC · IntractMD™ Analytics</p>'
    + '</div></div>';

  return html;
}

async function sendEmail(html, reportDate, data) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const d = data.yesterday;
  const hasTraffic = d.sessions > 0 || d.activeUsers > 0;
  const subject = hasTraffic
    ? '📊 IntractMD Analytics — ' + d.activeUsers + ' users, ' + d.sessions + ' sessions — ' + reportDate
    : '📊 IntractMD Analytics — No traffic yesterday — ' + reportDate;

  const res = await httpsPost('api.resend.com', '/emails', {
    from: 'IntractMD Analytics <info@mail.resolve.med>',
    to: [REPORT_TO],
    subject: subject,
    html: html
  }, { Authorization: 'Bearer ' + RESEND_API_KEY });

  if (res.id) {
    console.log('[Analytics] Email sent — id:', res.id);
  } else {
    console.error('[Analytics] Email failed:', JSON.stringify(res));
  }
  return res;
}

async function main() {
  console.log('[Analytics] Starting report for', yesterday(), DRY_RUN ? '(dry run)' : '');
  try {
    const token = await getAccessToken();
    console.log('[Analytics] Access token obtained');
    const data = await fetchAnalytics(token);
    console.log('[Analytics] Data fetched — yesterday sessions:', data.yesterday.sessions, 'users:', data.yesterday.activeUsers);
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
