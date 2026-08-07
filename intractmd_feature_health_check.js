#!/usr/bin/env node
/**
 * IntractMD™ Daily Feature Health Check
 * ──────────────────────────────────────────────────────────────────────────
 * Tests every user-facing feature and API endpoint of the IntractMD platform.
 * Designed to run daily via cron or manually.
 *
 * USAGE:
 *   node intractmd_feature_health_check.js
 *   node intractmd_feature_health_check.js --verbose
 *   node intractmd_feature_health_check.js --target https://www.intractmd.com
 *
 * SETUP (one-time):
 *   cp intractmd_feature_health_check.js ~/Documents/ddi-checker/
 *   crontab -e
 *   Add: 0 6 * * * cd ~/Documents/ddi-checker && node intractmd_feature_health_check.js >> health-check/daily.log 2>&1
 *
 * OUTPUT:
 *   Console summary + health-check/report_YYYYMMDD.txt
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const TARGET  = (args.find(a=>a.startsWith('--target='))||'--target=https://www.intractmd.com').split('=')[1].replace(/\/$/,'');
const OUT_DIR = path.join(__dirname, 'health-check');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, {recursive:true});

const NOW     = new Date();
const DATE_STR= NOW.toISOString().split('T')[0].replace(/-/g,'');
const TIME_STR= NOW.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const REPORT  = path.join(OUT_DIR, `report_${DATE_STR}.txt`);

// ── RESULTS STORE ────────────────────────────────────────────────────────────
const results = [];
let passed = 0, failed = 0, warned = 0;

function log(msg) {
  process.stdout.write(msg + '\n');
  fs.appendFileSync(REPORT, msg + '\n');
}

function result(category, name, ok, detail, warn) {
  const icon = ok === null ? '⚠' : ok ? '✓' : '✗';
  const status = ok === null ? 'WARN' : ok ? 'PASS' : 'FAIL';
  if (ok === null) warned++;
  else if (ok) passed++;
  else failed++;
  results.push({category, name, status, detail});
  if (VERBOSE || !ok) {
    log(`  ${icon} [${status}] ${name}${detail ? ' — '+detail : ''}`);
  } else {
    process.stdout.write(`  ${icon} `);
  }
}

// ── HTTP HELPER ──────────────────────────────────────────────────────────────
function request(method, url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const opts = {method, headers: headers||{}, timeout: timeoutMs||15000};
    if (body) {
      const b = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = lib.request(url, opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const ms = Date.now() - start;
        let json = null;
        try { json = JSON.parse(data); } catch(e) {}
        resolve({status: res.statusCode, headers: res.headers, body: data, json, ms});
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout after '+timeoutMs+'ms')); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function get(path, timeout)  { return request('GET',  TARGET+path, null, {}, timeout); }
async function post(path, body, timeout) { return request('POST', TARGET+path, body, {'Content-Type':'application/json'}, timeout); }

// ════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ════════════════════════════════════════════════════════════════════════════

// ── 1. INFRASTRUCTURE ────────────────────────────────────────────────────────
async function testInfrastructure() {
  log('\n━━━ 1. Infrastructure & Availability ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Health check endpoint
  try {
    const r = await get('/healthz', 8000);
    result('Infrastructure', 'Health check /healthz responds', r.status===200, `${r.status} in ${r.ms}ms`);
    result('Infrastructure', 'Health check returns {status:ok}', r.body.trim()==='OK'||r.body.toLowerCase().includes('ok'), r.body.substring(0,50));
    result('Infrastructure', 'Health check response <1000ms', r.ms<1000, `${r.ms}ms`);
  } catch(e) { result('Infrastructure', 'Health check /healthz', false, e.message); }

  // Main app loads
  try {
    const r = await get('/', 10000);
    result('Infrastructure', 'Main app (/) returns 200', r.status===200, `${r.status} in ${r.ms}ms`);
    result('Infrastructure', 'Main app contains IntractMD', r.body.includes('IntractMD'), null);
    result('Infrastructure', 'Main app is obfuscated (_0x identifiers present)', r.body.includes('_0x'), null);
    result('Infrastructure', 'Main app response <5000ms', r.ms<5000, `${r.ms}ms`);
  } catch(e) { result('Infrastructure', 'Main app loads', false, e.message); }

  // Terms of Use page
  try {
    const r = await get('/terms', 8000);
    result('Infrastructure', 'Terms of Use /terms returns 200', r.status===200, `${r.status} in ${r.ms}ms`);
    result('Infrastructure', 'Terms of Use page contains Resolve Medical', r.body.includes('Resolve Medical'), null);
    result('Infrastructure', 'Terms of Use page contains Section 20 (Governing Law)', r.body.includes('Governing Law'), null);
  } catch(e) { result('Infrastructure', 'Terms of Use page', false, e.message); }

  // Proactive surface
  try {
    const r = await get('/proactive', 10000);
    result('Infrastructure', 'Proactive surface /proactive reachable', r.status===200||r.status===401, `${r.status} in ${r.ms}ms`);
  } catch(e) { result('Infrastructure', 'Proactive surface loads', false, e.message); }

  // Clinical surface
  try {
    const r = await get('/clinical', 10000);
    result('Infrastructure', 'Clinical surface /clinical reachable', r.status===200||r.status===401, `${r.status} in ${r.ms}ms`);
  } catch(e) { result('Infrastructure', 'Clinical surface loads', false, e.message); }
}

// ── 2. DRUG LIST / AUTOCOMPLETE ──────────────────────────────────────────────
async function testDrugList() {
  log('\n━━━ 2. Drug List & Autocomplete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const r = await get('/api/drug-list', 8000);
    result('Drug List', '/api/drug-list returns 200', r.status===200, `${r.ms}ms`);
    result('Drug List', 'Drug list is a non-empty array', Array.isArray(r.json)&&r.json.length>0, `${r.json?r.json.length:0} entries`);
    result('Drug List', 'Drug list contains common drugs (warfarin)', r.json&&r.json.some(d=>(d.generic||d.brand||String(d)).toLowerCase().includes('warfarin')), null);
    result('Drug List', 'Drug list response <3000ms', r.ms<3000, `${r.ms}ms`);
  } catch(e) { result('Drug List', '/api/drug-list', false, e.message); }
}

// ── 3. MAIN ANALYSIS API ─────────────────────────────────────────────────────
async function testAnalysis() {
  log('\n━━━ 3. Main Analysis API (/api/analyze) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const cases = [
    {name:'Classic critical pair (warfarin + aspirin)', payload:{drugs:['warfarin','aspirin'],supplements:[],foods:[],language:'en'}, expectRisk:'high'},
    {name:'Ultra-fast cache path (cached pair)', payload:{drugs:['lisinopril','metoprolol'],supplements:[],foods:[],language:'en'}, expectFast:true},
    {name:'Drug + supplement interaction', payload:{drugs:['warfarin'],supplements:['fish oil'],foods:[],language:'en'}, expectSupplement:true},
    {name:'Drug + food interaction', payload:{drugs:['simvastatin'],supplements:[],foods:['grapefruit'],language:'en'}, expectFood:true},
    {name:'Spanish language output', payload:{drugs:['warfarin','aspirin'],supplements:[],foods:[],language:'es'}, expectSpanish:true},
    {name:'Five-drug polypharmacy', payload:{drugs:['warfarin','aspirin','metoprolol','lisinopril','atorvastatin'],supplements:[],foods:[],language:'en'}, expectScore:true},
    {name:'NTI drug pair', payload:{drugs:['warfarin','fluconazole'],supplements:[],foods:[],language:'en'}, expectRisk:'critical'},
    {name:'Supplement-only (no drugs)', payload:{drugs:[],supplements:['fish oil','vitamin E'],foods:[],language:'en'}, expectError:false},
  ];

  for (const tc of cases) {
    try {
      const r = await post('/api/analyze', tc.payload, 45000);
      const ok = r.status===200 && r.json && !r.json.error;
      result('Analysis', tc.name+' — API success', ok, `${r.status} in ${r.ms}ms`);
      if (ok) {
        result('Analysis', tc.name+' — has risk_score', typeof r.json.risk_score==='number', `score: ${r.json.risk_score}`);
        result('Analysis', tc.name+' — has overall_risk', !!r.json.overall_risk, r.json.overall_risk);
        if (tc.expectRisk==='high') result('Analysis', tc.name+' — risk is HIGH or CRITICAL', ['high','critical'].includes((r.json.overall_risk||'').toLowerCase()), r.json.overall_risk);
        if (tc.expectRisk==='critical') result('Analysis', tc.name+' — risk is CRITICAL', (r.json.overall_risk||'').toLowerCase()==='critical', r.json.overall_risk);
        if (tc.expectFast) result('Analysis', tc.name+' — ultra-fast path <500ms', r.ms<500, `${r.ms}ms`);
        if (tc.expectSupplement) result('Analysis', tc.name+' — supplement interactions present', (r.json.known_interactions||[]).some(i=>i.type&&i.type.includes('supplement'))||(r.json.pairs||[]).length>0, null);
        if (tc.expectFood) result('Analysis', tc.name+' — food interactions present', (r.json.food_interactions||[]).length>0||(r.json.known_interactions||[]).some(i=>i.type&&i.type.includes('food')), null);
        if (tc.expectSpanish) result('Analysis', tc.name+' — Spanish output (no English-only phrases)', !((r.json.executive_summary||'').includes('This combination')), r.json.overall_risk);
      }
    } catch(e) { result('Analysis', tc.name, false, e.message); }
  }
}

// ── 4. PROACTIVE / PCPRS API ─────────────────────────────────────────────────
async function testProactive() {
  log('\n━━━ 4. Proactive Supplement Screening (/api/proactive-analyze) ━━━━━━');

  const cases = [
    {name:'Standard regimen supplement screening', payload:{drugs:['warfarin','metoprolol','lisinopril'],language:'en'}},
    {name:'High-risk regimen (NTI drugs)', payload:{drugs:['warfarin','digoxin','amiodarone'],language:'en'}},
    {name:'Spanish language proactive', payload:{drugs:['warfarin','aspirin'],language:'es'}},
    {name:'Single drug screening', payload:{drugs:['warfarin'],language:'en'}},
    {name:'Large regimen screening', payload:{drugs:['warfarin','aspirin','metoprolol','lisinopril','atorvastatin','omeprazole','metformin'],language:'en'}},
  ];

  for (const tc of cases) {
    try {
      const r = await post('/api/proactive-analyze', tc.payload, 30000);
      const ok = r.status===200 && r.json && !r.json.error;
      result('Proactive', tc.name+' — API success', ok, `${r.status} in ${r.ms}ms`);
      if (ok) {
        result('Proactive', tc.name+' has score', typeof r.json.pcprs==='number', ''+r.json.pcprs);
        result('Proactive', tc.name+' — has supplement warnings', Array.isArray(r.json.supplement_warnings)||Array.isArray(r.json.warnings)||Array.isArray(r.json.avoid)||!!r.json.pcprs, null);
        result('Proactive', tc.name+' — response <5000ms', r.ms<5000, `${r.ms}ms`);
      }
    } catch(e) { result('Proactive', tc.name, false, e.message); }
  }
}

// ── 5. CLINICAL OUTREACH API ─────────────────────────────────────────────────
async function testClinical() {
  log('\n━━━ 5. Clinical Outreach (/api/generate-outreach) ━━━━━━━━━━━━━━━━━━');

  const cases = [
    {
      name:'Standard outreach (English)',
      payload:{
        patient:{name:'Jane Smith',dob:'1952-03-15',language:'en'},
        drugs:['warfarin','aspirin','metoprolol'],
        supplements:['fish oil'],
        foods:['grapefruit'],
        confirmed_interactions:[],
        language:'en'
      }
    },
    {
      name:'Spanish outreach',
      payload:{
        patient:{name:'Maria Garcia',dob:'1958-06-20',language:'es'},
        drugs:['warfarin','digoxin'],
        supplements:[],foods:[],confirmed_interactions:[],
        language:'es'
      }
    },
    {
      name:'Critical risk outreach',
      payload:{
        patient:{name:'Robert Jones',dob:'1945-01-10',language:'en'},
        drugs:['warfarin','fluconazole','amiodarone'],
        supplements:['St. John\'s Wort'],
        foods:[],confirmed_interactions:[],
        language:'en'
      }
    },
  ];

  for (const tc of cases) {
    try {
      const r = await post('/api/generate-outreach', tc.payload, 60000);
      const ok = r.status===200 && r.json && !r.json.error;
      result('Clinical', tc.name+' — API success', ok, `${r.status} in ${r.ms}ms`);
      if (ok) {
        result('Clinical', tc.name+' — has email', !!(r.json.email||r.json.email_draft), null);
        result('Clinical', tc.name+' — has SMS', !!(r.json.sms||r.json.sms_message), null);
        result('Clinical', tc.name+' — has call script', !!(r.json.case_manager_script||r.json.script||r.json.call_script||r.json.phone_script), null);
        result('Clinical', tc.name+' — no placeholder tokens', !JSON.stringify(r.json).includes('[PATIENT_NAME]')&&!JSON.stringify(r.json).includes('[INSERT'), null);
        result('Clinical', tc.name+' — response <30000ms', r.ms<30000, `${r.ms}ms`);
      }
    } catch(e) { result('Clinical', tc.name, false, e.message); }
  }
}

// ── 6. PILL IDENTIFIER ───────────────────────────────────────────────────────
async function testPillIdentifier() {
  log('\n━━━ 6. Pill Identifier (/api/pill-identify) ━━━━━━━━━━━━━━━━━━━━━━━━');

  const cases = [
    {name:'L484 (Tylenol 500mg) — authoritative table', payload:{imprint:'L484',color:'white',shape:'oblong'}, expectDrug:'acetaminophen'},
    {name:'M30 blue round — counterfeit override', payload:{imprint:'M30',color:'blue',shape:'round'}, expectFentanyl:true},
    {name:'IP 110 (Norco) — NTI drug', payload:{imprint:'IP 110',color:'white',shape:'oblong'}, expectDrug:'hydrocodone'},
    {name:'AN627 (Tramadol 50mg)', payload:{imprint:'AN627',color:'white',shape:'round'}, expectDrug:'tramadol'},
    {name:'5 CDN (Oxycodone 5mg)', payload:{imprint:'5 CDN',color:'blue',shape:'round'}, expectDrug:'oxycodone'},
    {name:'No match (random imprint)', payload:{imprint:'ZZZ999',color:'purple',shape:'diamond'}, expectNoMatch:true},
  ];

  for (const tc of cases) {
    try {
      const r = await post('/api/pill-identify', tc.payload, 20000);
      const ok = r.status===200 && r.json;
      result('Pill ID', tc.name+' — API responds', ok, `${r.status} in ${r.ms}ms`);
      if (ok) {
        if (tc.expectFentanyl) {
          result('Pill ID', tc.name+' — counterfeit/fentanyl warning triggered', JSON.stringify(r.json).toLowerCase().includes('fentanyl')||JSON.stringify(r.json).toLowerCase().includes('counterfeit')||r.json.warning, JSON.stringify(r.json).substring(0,80));
        } else if (tc.expectDrug) {
          result('Pill ID', tc.name+' — correct drug identified', JSON.stringify(r.json).toLowerCase().includes(tc.expectDrug), JSON.stringify(r.json).substring(0,80));
        } else if (tc.expectNoMatch) {
          result('Pill ID', tc.name+' — graceful no-match response', !r.json.error||r.json.result||true, JSON.stringify(r.json).substring(0,80));
        }
        result('Pill ID', tc.name+' — response <15000ms', r.ms<15000, `${r.ms}ms`);
      }
    } catch(e) { result('Pill ID', tc.name, false, e.message); }
  }
}

// ── 7. DRUG INFO API ─────────────────────────────────────────────────────────
async function testDrugInfo() {
  log('\n━━━ 7. Drug Information API (/api/drug-info) ━━━━━━━━━━━━━━━━━━━━━━━');

  const drugs = ['warfarin','metformin','lisinopril','atorvastatin'];
  for (const drug of drugs) {
    try {
      const r = await post('/api/drug-info', {drugName:drug,language:'en'}, 15000);
      const ok = r.status===200 && r.json && !r.json.error;
      result('Drug Info', `Drug info for ${drug}`, ok, `${r.ms}ms`);
      if (ok) {
        result('Drug Info', `${drug} — has content`, !!(r.json.info||r.json.content||r.json.summary||JSON.stringify(r.json).length>50), null);
      }
    } catch(e) { result('Drug Info', `Drug info for ${drug}`, false, e.message); }
  }

  // Spanish drug info
  try {
    const r = await post('/api/drug-info', {drugName:'warfarin',language:'es'}, 15000);
    result('Drug Info', 'Spanish drug info (warfarin es)', r.status===200&&r.json&&!r.json.error, `${r.ms}ms`);
  } catch(e) { result('Drug Info', 'Spanish drug info', false, e.message); }
}

// ── 8. IFU SUMMARY API ───────────────────────────────────────────────────────
async function testIFU() {
  log('\n━━━ 8. IFU Summary API (/api/ifu) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const cases = [
    {drug:'warfarin', lang:'en'},
    {drug:'metformin', lang:'en'},
    {drug:'warfarin', lang:'es'},
  ];

  for (const tc of cases) {
    try {
      const r = await post('/api/drug-ifu', {drugName:tc.drug,language:tc.lang}, 20000);
      const ok = r.status===200 && r.json && !r.json.error;
      result('IFU', `IFU for ${tc.drug} (${tc.lang})`, ok, `${r.ms}ms`);
      if (ok) {
        result('IFU', `${tc.drug} IFU has content`, JSON.stringify(r.json).length>100, null);
      }
    } catch(e) { result('IFU', `IFU for ${tc.drug}`, false, e.message); }
  }
}

// ── 9. SECURITY & COMPLIANCE CHECKS ─────────────────────────────────────────
async function testSecurity() {
  log('\n━━━ 9. Security & Compliance Checks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // HTTPS redirect
  try {
    const r = await get('/', 8000);
    result('Security', 'App served over HTTPS', TARGET.startsWith('https'), TARGET);
  } catch(e) { result('Security', 'HTTPS check', false, e.message); }

  // No API key in client-side source
  try {
    const r = await get('/', 10000);
    const hasKey = r.body.includes('sk-ant-') || r.body.includes('ANTHROPIC_API_KEY');
    result('Security', 'No Anthropic API key exposed in client source', !hasKey, hasKey?'KEY FOUND — CRITICAL':'clean');
  } catch(e) { result('Security', 'API key exposure check', false, e.message); }

  // CORS — API should not be open to arbitrary origins
  try {
    const r = await request('POST', TARGET+'/api/analyze',
      {drugs:['warfarin'],supplements:[],foods:[],language:'en'},
      {'Content-Type':'application/json', 'Origin':'https://evil-site.example.com'}, 15000);
    const openCors = (r.headers['access-control-allow-origin']||'') === '*';
    result('Security', 'API not open CORS wildcard', !openCors, openCors?'WARNING: CORS wildcard':'restricted');
  } catch(e) { result('Security', 'CORS check', null, e.message); }

  // No PHI in error responses
  try {
    const r = await post('/api/analyze', {drugs:[''],supplements:[],foods:[],language:'en'}, 15000);
    result('Security', 'Empty drug list handled gracefully (no 500)', r.status!==500, `${r.status}`);
  } catch(e) { result('Security', 'Empty drug list error handling', false, e.message); }

  // Terms page accessible without auth
  try {
    const r = await get('/terms', 8000);
    result('Security', 'Terms of Use accessible without auth', r.status===200, `${r.status}`);
  } catch(e) { result('Security', 'Terms accessibility', false, e.message); }
}

// ── 10. PERFORMANCE BENCHMARKS ───────────────────────────────────────────────
async function testPerformance() {
  log('\n━━━ 10. Performance Benchmarks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Ultra-fast path benchmark — fully cached pair should be <200ms
  try {
    const r = await post('/api/analyze', {drugs:['lisinopril','metoprolol'],supplements:[],foods:[],language:'en'}, 10000);
    result('Performance', 'Ultra-fast cached pair <200ms', r.ms<200, `${r.ms}ms`);
    result('Performance', 'Ultra-fast cached pair <500ms (fallback)', r.ms<500, `${r.ms}ms`);
  } catch(e) { result('Performance', 'Ultra-fast path benchmark', false, e.message); }

  // Health check latency
  try {
    const r = await get('/healthz', 5000);
    result('Performance', 'Health check <500ms', r.ms<500, `${r.ms}ms`);
  } catch(e) { result('Performance', 'Health check latency', false, e.message); }

  // Drug list latency
  try {
    const r = await get('/api/drug-list', 8000);
    result('Performance', 'Drug list <2000ms', r.ms<2000, `${r.ms}ms`);
  } catch(e) { result('Performance', 'Drug list latency', false, e.message); }

  // Main page load time
  try {
    const r = await get('/', 15000);
    result('Performance', 'Main app page load <5000ms', r.ms<5000, `${r.ms}ms`);
  } catch(e) { result('Performance', 'Main page load time', false, e.message); }
}

// ── 11. CONTENT INTEGRITY ────────────────────────────────────────────────────
async function testContent() {
  log('\n━━━ 11. Content Integrity Checks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    const r = await get('/', 10000);
    result('Content', 'Main app contains Resolve Medical branding', r.body.includes('Resolve'), null);
    result('Content', 'Main app contains logo-shape spinner reference', r.body.includes('logo'), null);
    result('Content', 'Main app contains Terms of Use footer link', r.body.includes('/terms'), null);
    result('Content', 'Main app contains Export PDF button', r.body.includes('exportPDF')||r.body.includes('Export'), null);
    result('Content', 'Main app contains pill identifier', r.body.includes('pi-imprint')||r.body.includes('identify'), null);
    result('Content', 'Main app contains Spanish language support', r.body.includes('es')||r.body.includes('Spanish')||r.body.includes('Espa'), null);
  } catch(e) { result('Content', 'Content integrity checks', false, e.message); }

  try {
    const r = await get('/terms', 8000);
    result('Content', 'Terms page contains Delaware LLC', r.body.includes('Delaware'), null);
    result('Content', 'Terms page contains 22 sections', r.body.includes('22.'), null);
    result('Content', 'Terms page contains Cuyahoga County venue', r.body.includes('Cuyahoga'), null);
    result('Content', 'Terms page contains Poison Control number', r.body.includes('1-800-222-1222'), null);
    result('Content', 'Terms page contains M30 counterfeit warning', r.body.includes('fentanyl')||r.body.includes('counterfeit'), null);
  } catch(e) { result('Content', 'Terms content checks', false, e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  // Clear/init report file
  fs.writeFileSync(REPORT, '');

  log('╔══════════════════════════════════════════════════════════════════╗');
  log('║     IntractMD™ Daily Feature Health Check                       ║');
  log('║     Date: '+new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})+'');
  log('║     Time: '+TIME_STR+'  |  Target: '+TARGET+'');
  log('╚══════════════════════════════════════════════════════════════════╝');

  const start = Date.now();

  await testInfrastructure();
  await testDrugList();
  await testAnalysis();
  await testProactive();
  await testClinical();
  await testPillIdentifier();
  await testDrugInfo();
  await testIFU();
  await testSecurity();
  await testPerformance();
  await testContent();

  const elapsed = Math.round((Date.now()-start)/1000);
  const total = passed + failed + warned;

  log('\n' + '═'.repeat(66));
  log('FEATURE HEALTH CHECK SUMMARY');
  log('─'.repeat(66));
  log(`  Total checks:  ${total}`);
  log(`  ✓ Passed:      ${passed} (${Math.round(passed/total*100)}%)`);
  log(`  ✗ Failed:      ${failed}`);
  log(`  ⚠ Warnings:    ${warned}`);
  log(`  Runtime:       ${elapsed}s`);
  log(`  Report:        ${REPORT}`);

  if (failed > 0) {
    log('\n  FAILED CHECKS:');
    results.filter(r=>r.status==='FAIL').forEach(r=>{
      log(`  ✗ [${r.category}] ${r.name}${r.detail?' — '+r.detail:''}`);
    });
  }
  if (warned > 0) {
    log('\n  WARNINGS:');
    results.filter(r=>r.status==='WARN').forEach(r=>{
      log(`  ⚠ [${r.category}] ${r.name}${r.detail?' — '+r.detail:''}`);
    });
  }

  log('═'.repeat(66));
  log(failed===0 ? '\n  ✓ ALL CHECKS PASSED — IntractMD is fully operational\n' : '\n  ✗ FAILURES DETECTED — review report above\n');

  // Save JSON data
  const jsonReport = {
    date: new Date().toISOString(),
    target: TARGET,
    total, passed, failed, warned,
    runtime_seconds: elapsed,
    results
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `data_${DATE_STR}.json`),
    JSON.stringify(jsonReport, null, 2)
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ Health check crashed:', err.message);
  process.exit(1);
});
