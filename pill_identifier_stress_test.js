/**
 * IntractMD™ Pill Identifier Stress Test
 * Resolve Medical, LLC
 *
 * Tests accuracy across:
 *   - Imprint code lookup
 *   - Color + shape + imprint combinations
 *   - Common misspellings and partial imprints
 *   - Edge cases (ambiguous pills, OTC lookalikes)
 *   - High-risk pills (narrow therapeutic index)
 *   - Spanish language queries
 *
 * Usage:
 *   node pill_identifier_stress_test.js [base_url]
 *   node pill_identifier_stress_test.js https://www.intractmd.com
 *   node pill_identifier_stress_test.js http://localhost:3000
 */

const https = require('https');
const http  = require('http');

const BASE_URL = process.argv[2] || 'https://www.intractmd.com';
const ENDPOINT = '/api/pill-identify';
const DELAY_MS = 300; // be polite to server
const TIMEOUT_MS = 15000;

// ── Color codes ──────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
  white:  '\x1b[37m',
};

// ── Test definitions ─────────────────────────────────────
// Each test has:
//   query:   object sent to API (imprint, color, shape, description)
//   expect:  array of acceptable drug names (any match = pass)
//   tier:    'critical' | 'high' | 'standard' | 'edge'
//   note:    explains clinical significance

const TESTS = [

  // ══ TIER 1: CRITICAL — Narrow Therapeutic Index / High Risk ══════════════

  {
    id: 'C01',
    tier: 'critical',
    desc: 'Warfarin 5mg — standard imprint',
    query: { imprint: 'COUMADIN 5', color: 'peach', shape: 'oval' },
    expect: ['warfarin', 'coumadin'],
    note: 'Anticoagulant. Wrong dose identification = hemorrhage risk.'
  },
  {
    id: 'C02',
    tier: 'critical',
    desc: 'Digoxin 0.125mg — tiny yellow tablet',
    query: { imprint: 'Y3B', color: 'yellow', shape: 'round' },
    expect: ['digoxin', 'lanoxin'],
    note: 'Cardiac glycoside. NTI drug — confusion with other yellow tablets.'
  },
  {
    id: 'C03',
    tier: 'critical',
    desc: 'Levothyroxine 50mcg — white round',
    query: { imprint: 'M L 3', color: 'white', shape: 'round' },
    expect: ['levothyroxine', 'synthroid', 'levoxyl'],
    note: 'NTI thyroid hormone. Multiple manufacturers with similar appearance.'
  },
  {
    id: 'C04',
    tier: 'critical',
    desc: 'Lithium 300mg — gray capsule',
    query: { imprint: 'LITHIUM 300', color: 'gray', shape: 'capsule' },
    expect: ['lithium'],
    note: 'NTI psychiatric drug. Toxic range close to therapeutic range.'
  },
  {
    id: 'C05',
    tier: 'critical',
    desc: 'Methotrexate 2.5mg — yellow round',
    query: { imprint: 'M 10', color: 'yellow', shape: 'round' },
    expect: ['methotrexate'],
    note: 'NTI chemotherapy. Weekly dosing — daily dosing errors are fatal.'
  },
  {
    id: 'C06',
    tier: 'critical',
    desc: 'Phenytoin 100mg — Dilantin Kapseals',
    query: { imprint: 'P-D 362', color: 'white', shape: 'capsule' },
    expect: ['phenytoin', 'dilantin'],
    note: 'NTI anticonvulsant. Saturation kinetics — small dose changes matter.'
  },
  {
    id: 'C07',
    tier: 'critical',
    desc: 'Carbamazepine 200mg — round pink',
    query: { imprint: 'TEGRETOL 200', color: 'pink', shape: 'round' },
    expect: ['carbamazepine', 'tegretol'],
    note: 'NTI anticonvulsant. Multiple drug interactions.'
  },
  {
    id: 'C08',
    tier: 'critical',
    desc: 'Cyclosporine 100mg — gel capsule',
    query: { imprint: 'CsA 100', color: 'pink', shape: 'oval' },
    expect: ['cyclosporine', 'neoral', 'sandimmune'],
    note: 'NTI immunosuppressant. Brand/generic NOT interchangeable.'
  },

  // ══ TIER 2: HIGH RISK — Common Polypharmacy / Misidentification Risk ══════

  {
    id: 'H01',
    tier: 'high',
    desc: 'Naproxen 500mg — white oval (Teva 93 48)',
    query: { imprint: '93 48', color: 'white', shape: 'oval' },
    expect: ['naproxen', 'naprosyn', 'aleve'],
    note: 'NSAID. Teva imprint 93 48 = Naproxen 500mg. Commonly confused with Metformin white ovals.'
  },
  {
    id: 'H02',
    tier: 'high',
    desc: 'Lisinopril 10mg — pink round',
    query: { imprint: 'LUPIN 10', color: 'pink', shape: 'round' },
    expect: ['lisinopril', 'prinivil', 'zestril'],
    note: 'ACE inhibitor. Many look-alike white/pink tablets.'
  },
  {
    id: 'H03',
    tier: 'high',
    desc: 'Atorvastatin 20mg — white elliptical',
    query: { imprint: 'PD 156 20', color: 'white', shape: 'oval' },
    expect: ['atorvastatin', 'lipitor'],
    note: 'Most prescribed statin. Multiple manufacturer generics.'
  },
  {
    id: 'H04',
    tier: 'high',
    desc: 'Amlodipine 5mg — white round',
    query: { imprint: 'NORVASC 5', color: 'white', shape: 'round' },
    expect: ['amlodipine', 'norvasc'],
    note: 'Calcium channel blocker. Confused with other white round tablets.'
  },
  {
    id: 'H05',
    tier: 'high',
    desc: 'Metoprolol succinate 50mg — white oval',
    query: { imprint: 'BI 72', color: 'white', shape: 'oval' },
    expect: ['metoprolol', 'toprol'],
    note: 'Beta blocker. Succinate vs tartrate NOT interchangeable.'
  },
  {
    id: 'H06',
    tier: 'high',
    desc: 'Omeprazole 20mg — pink/tan capsule',
    query: { imprint: '20 mg KU 118', color: 'pink', shape: 'capsule' },
    expect: ['omeprazole', 'prilosec'],
    note: 'PPI. Commonly confused with esomeprazole capsules.'
  },
  {
    id: 'H07',
    tier: 'high',
    desc: 'Sertraline 50mg — blue capsule-shaped',
    query: { imprint: 'ZOLOFT 50MG', color: 'blue', shape: 'oval' },
    expect: ['sertraline', 'zoloft'],
    note: 'SSRI. Blue pill common across many drug classes.'
  },
  {
    id: 'H08',
    tier: 'high',
    desc: 'Gabapentin 300mg — yellow/white capsule',
    query: { imprint: 'NEURONTIN 300MG', color: 'yellow', shape: 'capsule' },
    expect: ['gabapentin', 'neurontin'],
    note: 'Controlled substance risk in some states. Pregabalin confusion.'
  },
  {
    id: 'H09',
    tier: 'high',
    desc: 'Losartan 50mg — white oval',
    query: { imprint: 'MSD 952', color: 'white', shape: 'oval' },
    expect: ['losartan', 'cozaar'],
    note: 'ARB. Confused with other white ovals in polypharmacy patients.'
  },
  {
    id: 'H10',
    tier: 'high',
    desc: 'Apixaban 5mg — gold oval (Eliquis)',
    query: { imprint: 'BMS 5', color: 'yellow', shape: 'oval' },
    expect: ['apixaban', 'eliquis'],
    note: 'Anticoagulant DOAC. Confusion with rivaroxaban or edoxaban.'
  },

  // ══ TIER 3: STANDARD — Common OTC and Maintenance Meds ══════════════════

  {
    id: 'S01',
    tier: 'standard',
    desc: 'Aspirin 81mg — round white (EC)',
    query: { imprint: 'L', color: 'white', shape: 'round' },
    expect: ['aspirin'],
    note: 'Low-dose aspirin. EC coating important for identification.'
  },
  {
    id: 'S02',
    tier: 'standard',
    desc: 'Ibuprofen 200mg — brown oval (Advil)',
    query: { imprint: 'ADVIL', color: 'brown', shape: 'oval' },
    expect: ['ibuprofen', 'advil'],
    note: 'OTC NSAID. Confused with other oval OTC tablets.'
  },
  {
    id: 'S03',
    tier: 'standard',
    desc: 'Acetaminophen 500mg — white oval (Tylenol)',
    query: { imprint: 'TYLENOL 500', color: 'white', shape: 'oval' },
    expect: ['acetaminophen', 'tylenol', 'paracetamol'],
    note: 'OTC analgesic. Hepatotoxicity risk with confusion/double-dosing.'
  },
  {
    id: 'S04',
    tier: 'standard',
    desc: 'Loratadine 10mg — white round (Claritin)',
    query: { imprint: 'CLARITIN 10', color: 'white', shape: 'round' },
    expect: ['loratadine', 'claritin'],
    note: 'Antihistamine. Multiple white round OTC tablets.'
  },
  {
    id: 'S05',
    tier: 'standard',
    desc: 'Cetirizine 10mg — white oval (Zyrtec)',
    query: { imprint: 'ZYRTEC', color: 'white', shape: 'oval' },
    expect: ['cetirizine', 'zyrtec'],
    note: 'Antihistamine. Confused with loratadine.'
  },
  {
    id: 'S06',
    tier: 'standard',
    desc: 'Omeprazole 20mg OTC — purple capsule (Prilosec OTC)',
    query: { imprint: 'OTC 20 mg', color: 'purple', shape: 'capsule' },
    expect: ['omeprazole', 'prilosec'],
    note: 'OTC PPI. Brand vs generic appearance varies.'
  },
  {
    id: 'S07',
    tier: 'standard',
    desc: 'Furosemide 40mg — white round',
    query: { imprint: 'LASIX 40', color: 'white', shape: 'round' },
    expect: ['furosemide', 'lasix'],
    note: 'Loop diuretic. Electrolyte monitoring required.'
  },
  {
    id: 'S08',
    tier: 'standard',
    desc: 'Hydrochlorothiazide 25mg — white round',
    query: { imprint: 'MYLAN 216', color: 'white', shape: 'round' },
    expect: ['hydrochlorothiazide', 'hctz'],
    note: 'Thiazide diuretic. Very common — many look-alikes.'
  },
  {
    id: 'S09',
    tier: 'standard',
    desc: 'Atorvastatin 40mg — orange elliptical',
    query: { imprint: 'PD 157 40', color: 'orange', shape: 'oval' },
    expect: ['atorvastatin', 'lipitor'],
    note: 'Higher dose statin. Different color from 10/20mg.'
  },
  {
    id: 'S10',
    tier: 'standard',
    desc: 'Simvastatin 20mg — tan oval',
    query: { imprint: 'MSD 740', color: 'tan', shape: 'oval' },
    expect: ['simvastatin', 'zocor'],
    note: 'Statin. CYP3A4 interactions more significant than atorvastatin.'
  },

  // ══ TIER 4: EDGE CASES — Partial/Worn Imprints, Ambiguous, Spanish ═══════

  {
    id: 'E01',
    tier: 'edge',
    desc: 'Partial imprint — worn tablet (Metoprolol)',
    query: { imprint: 'M 50', color: 'white', shape: 'round' },
    expect: ['metoprolol', 'metformin', 'meloxicam'],
    note: 'M imprint used by Mylan on many drugs. Test for graceful ambiguity.'
  },
  {
    id: 'E02',
    tier: 'edge',
    desc: 'No imprint — white round OTC (should not crash)',
    query: { imprint: '', color: 'white', shape: 'round' },
    expect: ['acetaminophen', 'aspirin', 'ibuprofen', 'calcium', 'vitamin'],
    note: 'Many OTC supplements have no imprint. Should return helpful response.'
  },
  {
    id: 'E03',
    tier: 'edge',
    desc: 'Misspelled imprint — Warfarin (user types "COUMIDIN")',
    query: { imprint: 'COUMIDIN', color: 'peach', shape: 'oval' },
    expect: ['warfarin', 'coumadin'],
    note: 'Tests fuzzy matching / AI correction of patient spelling errors.'
  },
  {
    id: 'E04',
    tier: 'edge',
    desc: 'Ambiguous blue oval — could be multiple drugs',
    query: { imprint: 'V', color: 'blue', shape: 'oval' },
    expect: ['diazepam', 'oxycodone', 'sertraline', 'sildenafil', 'viagra'],
    note: 'V imprint blue oval could be Valium, Viagra, or Oxycodone. Tests disambiguation.'
  },
  {
    id: 'E05',
    tier: 'edge',
    desc: 'Spanish query — pastilla blanca redonda (white round pill)',
    query: { description: 'pastilla blanca redonda con numero 10', language: 'es' },
    expect: ['lisinopril', 'amlodipine', 'metoprolol', 'atorvastatin'],
    note: 'Spanish-language input. Tests bilingual capability.'
  },
  {
    id: 'E06',
    tier: 'edge',
    desc: 'Capsule with no imprint — suspect supplement',
    query: { imprint: '', color: 'green', shape: 'capsule' },
    expect: ['supplement', 'vitamin', 'fish oil', 'herb', 'melatonin'],
    note: 'Supplement capsules rarely have imprints. Should suggest supplement category.'
  },
  {
    id: 'E07',
    tier: 'edge',
    desc: 'Oxycodone 5mg — round white (controlled substance)',
    query: { imprint: '5 CDN', color: 'white', shape: 'round' },
    expect: ['oxycodone', 'oxycontin'],
    note: 'Controlled substance. Identification critical for overdose assessment.'
  },
  {
    id: 'E08',
    tier: 'edge',
    desc: 'Hydrocodone/APAP — white oblong',
    query: { imprint: 'IP 110', color: 'white', shape: 'oval' },
    expect: ['hydrocodone', 'acetaminophen', 'vicodin', 'norco'],
    note: 'Controlled substance combo. Common in ER presentation.'
  },
  {
    id: 'E09',
    tier: 'edge',
    desc: 'Alprazolam 0.25mg — white oval (Xanax)',
    query: { imprint: 'XANAX 0.25', color: 'white', shape: 'oval' },
    expect: ['alprazolam', 'xanax'],
    note: 'Controlled benzodiazepine. Confusion between doses critical.'
  },
  {
    id: 'E10',
    tier: 'edge',
    desc: 'Counterfeit-looking pill — unrecognized imprint',
    query: { imprint: 'M30', color: 'blue', shape: 'round' },
    expect: ['oxycodone', 'fentanyl', 'counterfeit', 'unknown', 'caution'],
    note: 'M30 blue pills are commonly counterfeit (fentanyl). App should flag danger.'
  },

  // ══ TIER 5: LOOK-ALIKE / SOUND-ALIKE PAIRS ═══════════════════════════════

  {
    id: 'L01',
    tier: 'high',
    desc: 'LASA — Hydroxyzine vs Hydralazine (white round)',
    query: { imprint: 'HYDROXYZINE 25', color: 'white', shape: 'round' },
    expect: ['hydroxyzine', 'vistaril', 'atarax'],
    note: 'Classic LASA pair. Hydroxyzine (antihistamine) vs Hydralazine (HTN).'
  },
  {
    id: 'L02',
    tier: 'high',
    desc: 'LASA — Clonidine vs Klonopin',
    query: { imprint: 'KLONOPIN 0.5', color: 'white', shape: 'round' },
    expect: ['clonazepam', 'klonopin'],
    note: 'LASA: Clonidine (HTN) vs Klonopin (benzodiazepine). Dangerous swap.'
  },
  {
    id: 'L03',
    tier: 'high',
    desc: 'LASA — Tramadol vs Toradol',
    query: { imprint: 'AN 627', color: 'white', shape: 'round' },
    expect: ['tramadol', 'ultram'],
    note: 'LASA: Tramadol (opioid) vs Toradol (NSAID). Different mechanisms, same name sound.'
  },
  {
    id: 'L04',
    tier: 'high',
    desc: 'LASA — Metformin vs Metronidazole',
    query: { imprint: 'METFORMIN 500', color: 'white', shape: 'oval' },
    expect: ['metformin', 'glucophage'],
    note: 'Similar names. Metformin (diabetes) vs Metronidazole (antibiotic).'
  },

  // ══ TIER 6: PEDIATRIC / SPECIAL POPULATION ═══════════════════════════════

  {
    id: 'P01',
    tier: 'critical',
    desc: 'Amoxicillin 250mg chewable — pink tablet',
    query: { imprint: 'AMOX 250', color: 'pink', shape: 'round' },
    expect: ['amoxicillin'],
    note: 'Pediatric dose. Confused with adult 500mg tablets.'
  },
  {
    id: 'P02',
    tier: 'critical',
    desc: 'Methylphenidate 10mg — round blue (Ritalin)',
    query: { imprint: 'CIBA 7', color: 'blue', shape: 'round' },
    expect: ['methylphenidate', 'ritalin'],
    note: 'Controlled substance. Pediatric ADHD medication — accidental ingestion risk.'
  },
];

// ── HTTP helper ──────────────────────────────────────────
function post(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  TIMEOUT_MS,
    };
    const req = lib.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.on('error',   reject);
    req.write(data);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Accuracy check ───────────────────────────────────────
function checkMatch(result, expect) {
  if (!result) return false;
  const haystack = JSON.stringify(result).toLowerCase();
  return expect.some(e => haystack.includes(e.toLowerCase()));
}

// ── Run tests ────────────────────────────────────────────
async function run() {
  const url = BASE_URL.replace(/\/$/, '') + ENDPOINT;

  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   IntractMD™ Pill Identifier Stress Test                     ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   Resolve Medical, LLC  ·  ${new Date().toISOString().split('T')[0]}                      ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`${C.gray}Endpoint: ${url}${C.reset}`);
  console.log(`${C.gray}Tests:    ${TESTS.length} total${C.reset}\n`);

  const results = { pass: 0, fail: 0, error: 0, byTier: {} };
  const failures = [];

  for (const test of TESTS) {
    if (!results.byTier[test.tier]) results.byTier[test.tier] = { pass: 0, fail: 0, error: 0 };

    process.stdout.write(`${C.gray}[${test.id}]${C.reset} ${test.desc.padEnd(52)} `);

    let passed = false;
    let errorMsg = '';
    let responseTime = 0;
    let responseBody = null;

    try {
      const t0 = Date.now();
      const resp = await post(url, test.query);
      responseTime = Date.now() - t0;
      responseBody = resp.body;

      if (resp.status !== 200) {
        errorMsg = `HTTP ${resp.status}`;
        results.error++;
        results.byTier[test.tier].error++;
      } else {
        passed = checkMatch(resp.body, test.expect);
        if (passed) {
          results.pass++;
          results.byTier[test.tier].pass++;
        } else {
          results.fail++;
          results.byTier[test.tier].fail++;
          failures.push({ test, response: resp.body });
        }
      }
    } catch (e) {
      errorMsg = e.message;
      results.error++;
      results.byTier[test.tier].error++;
    }

    if (errorMsg) {
      console.log(`${C.yellow}ERROR${C.reset} ${C.gray}${errorMsg}${C.reset}`);
    } else if (passed) {
      console.log(`${C.green}PASS${C.reset} ${C.gray}${responseTime}ms${C.reset}`);
    } else {
      console.log(`${C.red}FAIL${C.reset} ${C.gray}${responseTime}ms${C.reset}`);
      console.log(`     ${C.gray}Expected one of: [${test.expect.join(', ')}]${C.reset}`);
      if (responseBody) {
        const preview = JSON.stringify(responseBody).substring(0, 120);
        console.log(`     ${C.gray}Got: ${preview}...${C.reset}`);
      }
      console.log(`     ${C.yellow}⚠  ${test.note}${C.reset}`);
    }

    await delay(DELAY_MS);
  }

  // ── Summary ──────────────────────────────────────────────
  const total = results.pass + results.fail + results.error;
  const pct = ((results.pass / total) * 100).toFixed(1);

  console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`);
  console.log(`${C.bold}RESULTS SUMMARY${C.reset}`);
  console.log(`${'─'.repeat(66)}`);
  console.log(`Overall: ${results.pass}/${total} passed (${C.bold}${pct}%${C.reset})`);
  console.log(`  ${C.green}✓ Pass:${C.reset}  ${results.pass}`);
  console.log(`  ${C.red}✗ Fail:${C.reset}  ${results.fail}`);
  console.log(`  ${C.yellow}! Error:${C.reset} ${results.error}`);

  console.log(`\n${C.bold}BY TIER:${C.reset}`);
  const tierOrder = ['critical','high','standard','edge'];
  const tierLabel = { critical: '🔴 CRITICAL (NTI drugs)', high: '🟠 HIGH (polypharmacy)', standard: '🟡 STANDARD (common)', edge: '⚪ EDGE (partial/ambiguous)' };
  for (const tier of tierOrder) {
    const t = results.byTier[tier];
    if (!t) continue;
    const tp = t.pass + t.fail + t.error;
    const tpct = tp > 0 ? ((t.pass/tp)*100).toFixed(0) : '0';
    const color = tpct >= 90 ? C.green : tpct >= 70 ? C.yellow : C.red;
    console.log(`  ${tierLabel[tier]}: ${color}${t.pass}/${tp} (${tpct}%)${C.reset}`);
  }

  if (failures.length > 0) {
    console.log(`\n${C.bold}${C.red}FAILURES REQUIRING ATTENTION:${C.reset}`);
    for (const f of failures) {
      console.log(`\n  ${C.bold}[${f.test.id}] ${f.test.desc}${C.reset}`);
      console.log(`  ${C.yellow}Clinical risk:${C.reset} ${f.test.note}`);
      console.log(`  ${C.gray}Query:    ${JSON.stringify(f.test.query)}${C.reset}`);
      console.log(`  ${C.gray}Expected: [${f.test.expect.join(', ')}]${C.reset}`);
    }
  }

  console.log(`\n${C.bold}ACCURACY THRESHOLDS:${C.reset}`);
  const critTier = results.byTier['critical'] || { pass: 0, fail: 0, error: 0 };
  const critTotal = critTier.pass + critTier.fail + critTier.error;
  const critPct = critTotal > 0 ? (critTier.pass / critTotal) * 100 : 0;

  const check = (label, value, threshold) => {
    const pass = value >= threshold;
    const icon = pass ? `${C.green}✓` : `${C.red}✗`;
    console.log(`  ${icon} ${label}: ${value.toFixed(1)}% ${pass ? '' : `(required: ${threshold}%)`}${C.reset}`);
    return pass;
  };

  const t1 = check('Overall accuracy',  parseFloat(pct),    80);
  const t2 = check('Critical tier (NTI)', critPct,          95);

  console.log(`\n${C.bold}VERDICT:${C.reset}`);
  if (t1 && t2) {
    console.log(`  ${C.green}${C.bold}✓ PASS — Pill identifier meets accuracy thresholds${C.reset}`);
  } else {
    console.log(`  ${C.red}${C.bold}✗ FAIL — Accuracy improvements required${C.reset}`);
    if (!t2) {
      console.log(`  ${C.red}  CRITICAL: NTI drug accuracy below 95% threshold.${C.reset}`);
      console.log(`  ${C.red}  These are narrow therapeutic index drugs — identification errors${C.reset}`);
      console.log(`  ${C.red}  can cause hospitalization or death. Must be fixed before pilot.${C.reset}`);
    }
  }

  console.log(`\n${C.gray}Run time: ${new Date().toISOString()}${C.reset}\n`);

  process.exit(t1 && t2 ? 0 : 1);
}

run().catch(e => {
  console.error(`\n${C.red}Fatal error: ${e.message}${C.reset}`);
  process.exit(1);
});
