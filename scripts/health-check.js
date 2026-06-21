#!/usr/bin/env node
// IntractMD API Health Check
// Run: npm run health-check
// Requires ANTHROPIC_API_KEY env var for the Claude test.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Console colour helpers (no deps) ──────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;   // green
const R = s => `\x1b[31m${s}\x1b[0m`;   // red
const Y = s => `\x1b[33m${s}\x1b[0m`;   // yellow
const B = s => `\x1b[1m${s}\x1b[0m`;    // bold

async function timed(fn) {
  const t = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - t, ...result };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: e.message };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testOpenFDA() {
  const url = 'https://api.fda.gov/drug/label.json?search=openfda.generic_name:"atorvastatin"&limit=1';
  const r = await fetch(url, { timeout: 10000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const result = data.results && data.results[0];
  if (!result) throw new Error('No results returned');
  const hasWarnings = !!(result.warnings || result.boxed_warning || result.warnings_and_cautions);
  const hasDrugInter = !!(result.drug_interactions || result.drug_interactions_table);
  return {
    detail: `Results: ${data.results.length}, warnings: ${hasWarnings}, drug_interactions: ${hasDrugInter}`,
    warnings_present: hasWarnings,
    drug_interactions_present: hasDrugInter,
  };
}

async function testNLMRxNorm() {
  const url = 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=warfarin&search=2';
  const r = await fetch(url, { timeout: 10000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const rxcui = data.idGroup && data.idGroup.rxnormId && data.idGroup.rxnormId[0];
  if (!rxcui) throw new Error('No RxCUI returned');
  const expected = '11289';
  if (rxcui !== expected) throw new Error(`Expected RxCUI ${expected}, got ${rxcui}`);
  return { detail: `warfarin → RxCUI ${rxcui} ✓` };
}

async function testNLMDrugSuggest() {
  // Tests the NLM drugs.json endpoint used by the app's autocomplete
  const url = 'https://rxnav.nlm.nih.gov/REST/drugs.json?name=aspirin';
  const r = await fetch(url, { timeout: 10000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const groups = data.drugGroup && data.drugGroup.conceptGroup;
  if (!groups || !groups.length) throw new Error('No concept groups returned');
  const totalConcepts = groups.reduce((n, g) => n + ((g.conceptProperties && g.conceptProperties.length) || 0), 0);
  if (totalConcepts === 0) throw new Error('No drug concepts returned for aspirin');
  return { detail: `aspirin → ${totalConcepts} concepts across ${groups.length} groups` };
}

async function testClaude() {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set — skipping Claude test');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: 'Respond with ONLY valid JSON, no prose.',
      messages: [{ role: 'user', content: 'Return {"status":"ok","service":"claude"}' }]
    }),
    timeout: 15000
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  // Try to parse — strip fences if any
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(clean); } catch {
    const i = clean.indexOf('{'), j = clean.lastIndexOf('}');
    if (i !== -1 && j > i) parsed = JSON.parse(clean.slice(i, j + 1));
    else throw new Error('Response was not valid JSON: ' + clean.slice(0, 100));
  }
  if (!parsed.status) throw new Error('Parsed JSON missing expected fields');
  return { detail: `Parsed OK: ${JSON.stringify(parsed)}`, model: data.model };
}

// ── Runner ─────────────────────────────────────────────────────────────────

const TESTS = [
  { name: 'OpenFDA API',         key: 'openfda',     fn: testOpenFDA },
  { name: 'NLM RxNorm API',      key: 'nlm_rxnorm',  fn: testNLMRxNorm },
  { name: 'NLM Drug Suggest',    key: 'nlm_suggest',  fn: testNLMDrugSuggest },
  { name: 'Anthropic Claude API',key: 'claude',       fn: testClaude },
];

async function main() {
  const startTime = Date.now();
  const dateStr = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();

  console.log(B('\n╔══════════════════════════════════════════════╗'));
  console.log(B('║      IntractMD API Health Check              ║'));
  console.log(B(`║      ${timestamp.slice(0, 19).replace('T', ' ')} UTC              ║`));
  console.log(B('╚══════════════════════════════════════════════╝\n'));

  const results = {};
  for (const t of TESTS) {
    process.stdout.write(`  Testing ${t.name}... `);
    const r = await timed(t.fn);
    results[t.key] = { name: t.name, ...r, timestamp };
    if (r.ok) {
      console.log(G('✓ PASS') + ` (${r.ms}ms)` + (r.detail ? ` — ${r.detail}` : ''));
    } else {
      console.log(R('✗ FAIL') + ` (${r.ms}ms) — ${r.error}`);
    }
  }

  const failures = Object.values(results).filter(r => !r.ok);
  const elapsed = Date.now() - startTime;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + B('─'.repeat(50)));
  console.log(B(`Results: ${TESTS.length - failures.length}/${TESTS.length} passed in ${elapsed}ms`));

  if (failures.length > 0) {
    console.log('\n' + R(B('╔══════════════════════════════════════════════╗')));
    console.log(R(B('║  ⚠  ACTION REQUIRED — SERVICE FAILURE DETECTED  ║')));
    console.log(R(B('╚══════════════════════════════════════════════╝')));
    failures.forEach(f => {
      console.log(R(`\n  ✗ ${f.name}`));
      console.log(R(`    Error: ${f.error}`));
      console.log(Y(`    → Check service availability and API credentials`));
    });
    console.log('\n' + Y(B('  Investigate immediately — IntractMD may be degraded.\n')));
  } else {
    console.log(G(B('\n  ✓ All services operational.\n')));
  }

  // ── Save JSON report ─────────────────────────────────────────────────────
  const report = {
    timestamp,
    elapsed_ms: elapsed,
    passed: TESTS.length - failures.length,
    failed: failures.length,
    all_passed: failures.length === 0,
    results
  };
  const logFile = path.join(LOGS_DIR, `health-check-${dateStr}.json`);
  fs.writeFileSync(logFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  Report saved: logs/health-check-${dateStr}.json\n`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(R(B('\nFatal error running health check:')), e.message);
  process.exit(1);
});
