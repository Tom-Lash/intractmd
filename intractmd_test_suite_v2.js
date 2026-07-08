#!/usr/bin/env node
/**
 * IntractMD Automated Pressure Test Suite v2
 * - 1,500 tests across 3 surfaces (500 each)
 * - Date-based random seed for different combinations nightly
 * - Cumulative report merging results across runs
 * - Trend tracking across consecutive nights
 * - Auto-scheduler for midnight runs
 *
 * Run once:      node intractmd_test_suite_v2.js
 * Schedule:      node intractmd_test_suite_v2.js --schedule
 * Trend report:  node intractmd_test_suite_v2.js --report
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.intractmd.com';
const DELAY_MS = 800;
const TESTS_PER_SURFACE = 500;
const RESULTS_DIR = path.join(__dirname, 'test_results');
const CUMULATIVE_FILE = path.join(RESULTS_DIR, 'cumulative.json');
const TREND_FILE = path.join(RESULTS_DIR, 'trend.json');

const args = process.argv.slice(2);
const SCHEDULE_MODE = args.includes('--schedule');
const REPORT_MODE = args.includes('--report');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── SEEDED RANDOM ─────────────────────────────────────────────────────────
// Date-based seed ensures different combinations each night but reproducible
// within the same day
function createRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

const today = new Date();
const SEED = today.getFullYear() * 10000 + (today.getMonth()+1) * 100 + today.getDate();
let rng = createRng(SEED);

function seededRandom() { return rng(); }
function seededInt(min, max) { return Math.floor(seededRandom() * (max - min + 1)) + min; }
function seededFrom(arr, n = 1) {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return n === 1 ? shuffled[0] : shuffled.slice(0, n);
}

// ── DRUG TEST DATA ────────────────────────────────────────────────────────

const KNOWN_CRITICAL = [
  { drugs: ['Warfarin', 'Aspirin'], expect: 'Critical', note: 'Major bleeding risk' },
  { drugs: ['Sertraline', 'Tramadol'], expect: 'Critical', note: 'Serotonin syndrome' },
  { drugs: ['Warfarin', 'Ibuprofen'], expect: 'Critical', note: 'Bleeding + anticoagulation' },
  { drugs: ['Fluoxetine', 'Tramadol'], expect: 'Critical', note: 'Serotonin syndrome' },
  { drugs: ['Methotrexate', 'Ibuprofen'], expect: 'Critical', note: 'Methotrexate toxicity' },
  { drugs: ['Warfarin', 'Naproxen'], expect: 'Critical', note: 'Bleeding risk' },
  { drugs: ['Sildenafil', 'Nitrostat'], expect: 'Critical', note: 'Severe hypotension' },
  { drugs: ['Fluoxetine', 'Phenelzine'], expect: 'Critical', note: 'Dangerous MAOI combo' },
  { drugs: ['Warfarin', 'Fluconazole'], expect: 'High', note: 'CYP2C9 inhibition' },
  { drugs: ['Simvastatin', 'Amiodarone'], expect: 'High', note: 'Myopathy risk' },
  { drugs: ['Lithium', 'Ibuprofen'], expect: 'High', note: 'Lithium toxicity' },
  { drugs: ['Digoxin', 'Amiodarone'], expect: 'High', note: 'Digoxin toxicity' },
  { drugs: ['Clopidogrel', 'Omeprazole'], expect: 'High', note: 'CYP2C19 inhibition' },
  { drugs: ['Metoprolol', 'Diltiazem'], expect: 'High', note: 'Bradycardia risk' },
  { drugs: ['Carbamazepine', 'Warfarin'], expect: 'High', note: 'Enzyme induction' },
];

const KNOWN_HIGH = [
  { drugs: ['Atorvastatin', 'Clarithromycin'], expect: 'High' },
  { drugs: ['Sertraline', 'Alprazolam'], expect: 'High' },
  { drugs: ['Ciprofloxacin', 'Warfarin'], expect: 'High' },
  { drugs: ['Amlodipine', 'Simvastatin'], expect: 'High' },
  { drugs: ['Levothyroxine', 'Calcium Carbonate'], expect: 'Moderate' },
  { drugs: ['Metformin', 'Alcohol'], expect: 'High' },
  { drugs: ['Gabapentin', 'Oxycodone'], expect: 'High' },
  { drugs: ['Quetiapine', 'Lorazepam'], expect: 'High' },
  { drugs: ['Valproic Acid', 'Aspirin'], expect: 'High' },
  { drugs: ['Lisinopril', 'Spironolactone'], expect: 'High' },
  { drugs: ['Prednisone', 'Ibuprofen'], expect: 'High' },
  { drugs: ['Azithromycin', 'Warfarin'], expect: 'High' },
  { drugs: ['Fluconazole', 'Simvastatin'], expect: 'High' },
  { drugs: ['Metoprolol', 'Verapamil'], expect: 'High' },
  { drugs: ['Tramadol', 'Alprazolam'], expect: 'High' },
];

// Large pool of 5-drug regimens — seeded random picks different ones each night
const FIVE_DRUG_POOL = [
  ['Warfarin', 'Lisinopril', 'Metoprolol', 'Atorvastatin', 'Aspirin'],
  ['Metformin', 'Lisinopril', 'Amlodipine', 'Atorvastatin', 'Aspirin'],
  ['Sertraline', 'Alprazolam', 'Omeprazole', 'Metoprolol', 'Hydrochlorothiazide'],
  ['Levothyroxine', 'Atorvastatin', 'Lisinopril', 'Metformin', 'Aspirin'],
  ['Warfarin', 'Amiodarone', 'Lisinopril', 'Furosemide', 'Digoxin'],
  ['Prednisone', 'Metformin', 'Lisinopril', 'Atorvastatin', 'Aspirin'],
  ['Gabapentin', 'Oxycodone', 'Sertraline', 'Alprazolam', 'Omeprazole'],
  ['Amlodipine', 'Losartan', 'Metoprolol', 'Furosemide', 'Aspirin'],
  ['Clopidogrel', 'Aspirin', 'Atorvastatin', 'Metoprolol', 'Lisinopril'],
  ['Levodopa', 'Sertraline', 'Memantine', 'Donepezil', 'Metoprolol'],
  ['Warfarin', 'Fluconazole', 'Omeprazole', 'Metoprolol', 'Furosemide'],
  ['Methotrexate', 'Ibuprofen', 'Folic Acid', 'Omeprazole', 'Prednisolone'],
  ['Lithium', 'Ibuprofen', 'Quetiapine', 'Valproic Acid', 'Lorazepam'],
  ['Simvastatin', 'Amiodarone', 'Warfarin', 'Digoxin', 'Furosemide'],
  ['Fluoxetine', 'Tramadol', 'Gabapentin', 'Ibuprofen', 'Omeprazole'],
  ['Duloxetine', 'Tramadol', 'Naproxen', 'Omeprazole', 'Metformin'],
  ['Bupropion', 'Tramadol', 'Metoprolol', 'Lisinopril', 'Aspirin'],
  ['Quetiapine', 'Lorazepam', 'Metoprolol', 'Furosemide', 'Lisinopril'],
  ['Carbamazepine', 'Warfarin', 'Omeprazole', 'Metoprolol', 'Atorvastatin'],
  ['Ciprofloxacin', 'Warfarin', 'Metformin', 'Lisinopril', 'Amlodipine'],
  ['Azithromycin', 'Warfarin', 'Digoxin', 'Furosemide', 'Metoprolol'],
  ['Clarithromycin', 'Simvastatin', 'Amlodipine', 'Lisinopril', 'Aspirin'],
  ['Venlafaxine', 'Tramadol', 'Ibuprofen', 'Omeprazole', 'Metoprolol'],
  ['Escitalopram', 'Alprazolam', 'Gabapentin', 'Metoprolol', 'Lisinopril'],
  ['Trazodone', 'Sertraline', 'Alprazolam', 'Metoprolol', 'Lisinopril'],
];

const TEN_DRUG_POOL = [
  ['Warfarin', 'Aspirin', 'Clopidogrel', 'Atorvastatin', 'Metoprolol', 'Lisinopril', 'Furosemide', 'Digoxin', 'Amiodarone', 'Omeprazole'],
  ['Sertraline', 'Alprazolam', 'Gabapentin', 'Tramadol', 'Oxycodone', 'Omeprazole', 'Metoprolol', 'Lisinopril', 'Atorvastatin', 'Metformin'],
  ['Metformin', 'Glipizide', 'Lisinopril', 'Amlodipine', 'Atorvastatin', 'Aspirin', 'Omeprazole', 'Levothyroxine', 'Sertraline', 'Alprazolam'],
  ['Warfarin', 'Fluconazole', 'Amiodarone', 'Digoxin', 'Furosemide', 'Lisinopril', 'Metoprolol', 'Aspirin', 'Omeprazole', 'Potassium Chloride'],
  ['Lithium', 'Valproic Acid', 'Quetiapine', 'Lorazepam', 'Ibuprofen', 'Metoprolol', 'Lisinopril', 'Atorvastatin', 'Omeprazole', 'Sertraline'],
  ['Prednisone', 'Metformin', 'Warfarin', 'Aspirin', 'Omeprazole', 'Lisinopril', 'Furosemide', 'Potassium Chloride', 'Atorvastatin', 'Metoprolol'],
  ['Carbamazepine', 'Warfarin', 'Sertraline', 'Alprazolam', 'Omeprazole', 'Lisinopril', 'Metoprolol', 'Atorvastatin', 'Aspirin', 'Levothyroxine'],
  ['Gabapentin', 'Tramadol', 'Oxycodone', 'Sertraline', 'Alprazolam', 'Omeprazole', 'Metoprolol', 'Lisinopril', 'Atorvastatin', 'Metformin'],
];

const SUPPLEMENT_POOL = [
  { drugs: ['Warfarin', 'Aspirin', 'Lisinopril'], supplements: ['Fish Oil', 'Vitamin E', 'Ginkgo Biloba'] },
  { drugs: ['Sertraline', 'Alprazolam'], supplements: ['St. Johns Wort', 'Melatonin', 'Valerian'] },
  { drugs: ['Simvastatin', 'Amlodipine'], supplements: ['Grapefruit Juice', 'CoQ10', 'Niacin'] },
  { drugs: ['Metformin', 'Lisinopril', 'Atorvastatin'], supplements: ['Chromium', 'Alpha Lipoic Acid', 'Berberine'] },
  { drugs: ['Levothyroxine', 'Calcium Carbonate'], supplements: ['Biotin', 'Iron', 'Magnesium'] },
  { drugs: ['Warfarin', 'Metoprolol', 'Digoxin'], supplements: ['Vitamin K', 'Hawthorn', 'Fish Oil'] },
  { drugs: ['Methotrexate', 'Folic Acid'], supplements: ['Echinacea', 'Zinc', 'Cats Claw'] },
  { drugs: ['Clopidogrel', 'Aspirin', 'Atorvastatin'], supplements: ['Fish Oil', 'Turmeric', 'Garlic'] },
  { drugs: ['Warfarin', 'Amiodarone', 'Digoxin'], supplements: ['Vitamin K', 'Fish Oil', 'Ginkgo Biloba'] },
  { drugs: ['Sertraline', 'Tramadol', 'Gabapentin'], supplements: ['St. Johns Wort', 'SAMe', '5-HTP'] },
  { drugs: ['Prednisone', 'Lisinopril', 'Metformin'], supplements: ['Licorice Root', 'DHEA', 'Ginseng'] },
  { drugs: ['Metoprolol', 'Lisinopril', 'Furosemide'], supplements: ['Hawthorn', 'Magnesium', 'Potassium'] },
];

const EDGE_CASES = [
  { drugs: ['Acetaminophen'], desc: 'Single OTC drug' },
  { drugs: ['Amoxicillin', 'Penicillin VK'], desc: 'Same class interaction' },
  { drugs: ['Vitamin D3', 'Calcium Carbonate'], desc: 'Supplements only' },
  { drugs: ['Lisinopril', 'Spironolactone'], desc: 'Hyperkalemia risk pair' },
  { drugs: ['Warfarin', 'Warfarin'], desc: 'Duplicate drug entry' },
  { drugs: ['Aspirin', 'Ibuprofen', 'Naproxen', 'Celecoxib'], desc: 'All NSAIDs' },
  { drugs: ['Alprazolam', 'Lorazepam', 'Clonazepam', 'Diazepam'], desc: 'Multiple benzodiazepines' },
  { drugs: ['Metformin'], desc: 'Single Rx drug' },
];

// Large random drug pool — seeded selection gives different combos nightly
const RANDOM_POOL = [
  'Metformin','Lisinopril','Atorvastatin','Amlodipine','Omeprazole',
  'Metoprolol','Losartan','Albuterol','Gabapentin','Hydrochlorothiazide',
  'Sertraline','Levothyroxine','Furosemide','Alprazolam','Prednisone',
  'Montelukast','Fluticasone','Rosuvastatin','Pantoprazole','Escitalopram',
  'Clopidogrel','Warfarin','Carvedilol','Clonazepam','Trazodone',
  'Duloxetine','Bupropion','Venlafaxine','Quetiapine','Aripiprazole',
  'Amoxicillin','Azithromycin','Doxycycline','Ciprofloxacin','Cephalexin',
  'Tamsulosin','Finasteride','Sildenafil','Oxycodone','Tramadol',
  'Ibuprofen','Naproxen','Celecoxib','Meloxicam','Cyclobenzaprine',
  'Methotrexate','Hydroxychloroquine','Leflunomide','Adalimumab','Etanercept',
  'Insulin Glargine','Glipizide','Sitagliptin','Empagliflozin','Liraglutide',
  'Alendronate','Calcium Carbonate','Vitamin D3','Folic Acid','Iron Sulfate',
  'Digoxin','Amiodarone','Spironolactone','Hydralazine','Isosorbide Mononitrate',
  'Donepezil','Memantine','Rivastigmine','Levodopa','Pramipexole',
  'Topiramate','Lamotrigine','Valproic Acid','Carbamazepine','Phenytoin',
  'Sumatriptan','Propranolol','Amitriptyline','Nortriptyline','Lithium',
  'Fluconazole','Itraconazole','Acyclovir','Valacyclovir','Oseltamivir',
  'Colchicine','Allopurinol','Febuxostat','Probenecid','Indomethacin',
  'Ondansetron','Metoclopramide','Promethazine','Prochlorperazine','Loperamide',
  'Clindamycin','Metronidazole','Nitrofurantoin','Sulfamethoxazole','Trimethoprim',
];

const PATIENT_NAMES = ['Margaret','Robert','Dorothy','James','Patricia','William','Elizabeth','Charles','Barbara','Thomas','Susan','David','Jessica','Richard','Karen','Joseph','Linda','Daniel','Nancy','Mark','Betty','Paul','Helen','Donald','Sandra','Kenneth','Donna','George','Carol','Steven'];
const MANAGER_NAMES = ['Sarah Johnson','Michael Chen','Patricia Williams','Robert Davis','Jennifer Martinez','Christopher Wilson','Amanda Anderson','Matthew Taylor','Stephanie Thomas','Joshua Brown'];
const PLAN_NAMES = ['Blue Cross Blue Shield','UnitedHealthcare','Aetna','Cigna','Humana','Molina Healthcare','Centene','WellCare','Oscar Health','Bright Health'];

// ── UTILITY ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiCall(endpoint, body, timeoutMs = 35000) {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE_URL + endpoint, {
      signal: ctrl.signal, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    clearTimeout(t);
    return { data, ms: Date.now() - start, error: null, status: r.status };
  } catch(e) {
    clearTimeout(t);
    return { data: null, ms: Date.now() - start, error: e.message, status: 0 };
  }
}

// ── TEST BUILDERS (seeded random) ─────────────────────────────────────────

function buildAnalyzeTests() {
  const tests = [];
  // 50 known Critical
  for(let i = 0; i < 50; i++) tests.push({ category: 'known_critical', ...KNOWN_CRITICAL[i % KNOWN_CRITICAL.length] });
  // 75 known High
  for(let i = 0; i < 75; i++) tests.push({ category: 'known_high', ...KNOWN_HIGH[i % KNOWN_HIGH.length] });
  // 100 five-drug (seeded random selection from pool)
  for(let i = 0; i < 100; i++) {
    const base = seededFrom(FIVE_DRUG_POOL);
    const addExtra = seededRandom() > 0.6;
    const drugs = addExtra ? [...base, seededFrom(RANDOM_POOL)] : base;
    tests.push({ category: 'five_drug', drugs });
  }
  // 100 ten-drug complex (seeded random)
  for(let i = 0; i < 100; i++) tests.push({ category: 'ten_drug', drugs: seededFrom(TEN_DRUG_POOL) });
  // 75 supplement regimens
  for(let i = 0; i < 75; i++) {
    const reg = seededFrom(SUPPLEMENT_POOL);
    tests.push({ category: 'supplements', drugs: [...reg.drugs, ...reg.supplements] });
  }
  // 50 edge cases
  for(let i = 0; i < 50; i++) tests.push({ category: 'edge_case', ...EDGE_CASES[i % EDGE_CASES.length] });
  // 50 random (seeded)
  for(let i = 0; i < 50; i++) tests.push({ category: 'random', drugs: seededFrom(RANDOM_POOL, seededInt(2,7)) });
  return tests.slice(0, TESTS_PER_SURFACE);
}

function buildProactiveTests() {
  const tests = [];
  for(let i = 0; i < 75; i++) { const r = seededFrom(SUPPLEMENT_POOL); tests.push({ category: 'known_supplement', drugs: [...r.drugs, ...r.supplements], expectWarnings: true }); }
  for(let i = 0; i < 75; i++) tests.push({ category: 'known_critical', ...KNOWN_CRITICAL[i % KNOWN_CRITICAL.length] });
  for(let i = 0; i < 100; i++) tests.push({ category: 'five_drug', drugs: seededFrom(FIVE_DRUG_POOL) });
  for(let i = 0; i < 100; i++) tests.push({ category: 'ten_drug', drugs: seededFrom(TEN_DRUG_POOL) });
  for(let i = 0; i < 75; i++) tests.push({ category: 'random', drugs: seededFrom(RANDOM_POOL, seededInt(3,9)) });
  for(let i = 0; i < 50; i++) tests.push({ category: 'edge_case', ...EDGE_CASES[i % EDGE_CASES.length] });
  for(let i = 0; i < 25; i++) tests.push({ category: 'large_regimen', drugs: seededFrom(RANDOM_POOL, 12) });
  return tests.slice(0, TESTS_PER_SURFACE);
}

function buildOutreachTests() {
  const tests = [];
  const mkCtx = () => ({ patient: seededFrom(PATIENT_NAMES), manager: seededFrom(MANAGER_NAMES), plan: seededFrom(PLAN_NAMES) });
  for(let i = 0; i < 50; i++) tests.push({ category: 'known_critical', ...KNOWN_CRITICAL[i % KNOWN_CRITICAL.length], ...mkCtx(), expectConfirmed: true });
  for(let i = 0; i < 75; i++) tests.push({ category: 'five_drug', drugs: seededFrom(FIVE_DRUG_POOL), ...mkCtx() });
  for(let i = 0; i < 100; i++) { const r = seededFrom(SUPPLEMENT_POOL); tests.push({ category: 'with_confirmed', drugs: r.drugs, confirmedItems: r.supplements.slice(0,2), ...mkCtx(), expectDeclarative: true }); }
  for(let i = 0; i < 100; i++) tests.push({ category: 'ten_drug', drugs: seededFrom(TEN_DRUG_POOL), ...mkCtx() });
  for(let i = 0; i < 75; i++) tests.push({ category: 'spanish', drugs: seededFrom(FIVE_DRUG_POOL), patient: seededFrom(['Maria','Carlos','Ana','José','Rosa','Luis','Carmen','Miguel']), manager: seededFrom(MANAGER_NAMES), plan: seededFrom(PLAN_NAMES), language: 'es', expectSpanish: true });
  for(let i = 0; i < 50; i++) tests.push({ category: 'edge_case', ...EDGE_CASES[i % EDGE_CASES.length], ...mkCtx() });
  for(let i = 0; i < 50; i++) tests.push({ category: 'random', drugs: seededFrom(RANDOM_POOL, seededInt(2,6)), ...mkCtx() });
  return tests.slice(0, TESTS_PER_SURFACE);
}

// ── TEST RUNNERS ──────────────────────────────────────────────────────────

async function runAnalyzeTest(test, idx) {
  const result = await apiCall('/api/analyze', { drugs: test.drugs });
  const d = result.data;
  // API returns: overall_risk, risk_score, known_interactions, summary
  // severity values: 'major', 'moderate', 'minor' (not Critical/High/Moderate)
  const score = d && (d.risk_score ?? d.pcprs ?? d.score);
  const interactions = d && (d.known_interactions || d.interactions || []);
  const checks = {
    api_success: !result.error && d !== null,
    has_risk_score: typeof score === 'number',
    score_in_range: typeof score === 'number' && score >= 0 && score <= 100,
    has_interactions: Array.isArray(interactions),
    has_overall_risk: d && typeof d.overall_risk === 'string',
    has_summary: d && typeof d.summary === 'string' && d.summary.length > 10,
    severity_valid: true,
    accuracy_correct: null,
    response_fast: result.ms < 30000,
  };
  const validSev = ['major','moderate','minor','Critical','High','Moderate','Low','Minimal'];
  if(interactions && interactions.length > 0) checks.severity_valid = interactions.every(i => validSev.includes(i.severity));
  if(test.expect && interactions && interactions.length > 0) {
    const topSev = (interactions[0]?.severity || '').toLowerCase();
    const expectedLow = (test.expect || '').toLowerCase();
    // Map expected values: Critical/High -> major, Moderate -> moderate
    const isMajor = topSev === 'major' || topSev === 'critical';
    const expectMajor = expectedLow === 'critical' || expectedLow === 'high';
    checks.accuracy_correct = isMajor === expectMajor || topSev === expectedLow;
  }
  const passed = checks.api_success && checks.has_risk_score && checks.score_in_range && checks.has_overall_risk;
  return { idx, test, checks, passed, ms: result.ms, error: result.error };
}

async function runProactiveTest(test, idx) {
  const result = await apiCall('/api/proactive-analyze', { drugs: test.drugs });
  const d = result.data;
  const checks = {
    api_success: !result.error && d !== null,
    has_pcprs: d && typeof d.pcprs === 'number',
    score_in_range: d && d.pcprs >= 0 && d.pcprs <= 100,
    has_warnings_array: d && Array.isArray(d.warnings),
    severity_valid: true,
    has_avoid_list: d && (Array.isArray(d.avoid_supplements) || Array.isArray(d.caution_foods)),
    response_fast: result.ms < 25000,
  };
  const validSev = ['Critical','High','Moderate','Low','Minimal'];
  if(d && d.warnings) checks.severity_valid = d.warnings.every(w => validSev.includes(w.severity));
  const passed = checks.api_success && checks.has_pcprs && checks.score_in_range && checks.has_warnings_array;
  return { idx, test, checks, passed, ms: result.ms, error: result.error };
}

async function runOutreachTest(test, idx) {
  const riskFactors = (test.confirmedItems || []).map((item, i) => ({
    factorId: 'food_'+i, tier: 'CONFIRMED',
    label: 'Patient reports: '+item,
    plainLanguage: 'Patient confirms regular consumption of '+item,
    action: 'Include as CONFIRMED finding.', value: item, category: 'food_confirmed'
  }));
  const payload = {
    drugs: test.drugs, ddiResults: { risk_tier: 'High', warnings: [], drug_interactions: [] },
    riskFactors,
    patientContext: { firstName: test.patient || 'Member', planName: test.plan || 'your health plan', caseManagerName: test.manager || 'your care team' },
    language: test.language || 'en'
  };
  const result = await apiCall('/api/generate-outreach', payload, 35000);
  const d = result.data;
  const emailBody = (d && d.email && d.email.body) || '';
  const checks = {
    api_success: !result.error && d !== null,
    has_email: !!(d && d.email),
    has_sms: !!(d && d.sms),
    has_script: !!(d && d.case_manager_script),
    email_nonempty: emailBody.length > 50,
    sms_length_ok: !!(d && d.sms && d.sms.body && d.sms.body.length <= 320), // SMS can be 2 segments (320 chars)
    manager_name_in_closing: test.manager ? emailBody.includes(test.manager.split(' ')[0]) : true,
    no_placeholder_tokens: !emailBody.includes('[PHONE]') && !emailBody.includes('[PORTAL]') && !emailBody.includes('[CASEMANAGER_NAME]') && !emailBody.includes('[INSERT'),
    declarative_language: null,
    spanish_detected: null,
    response_fast: result.ms < 35000,
  };
  if(test.expectDeclarative && test.confirmedItems && test.confirmedItems.length > 0) {
    const words = ['because you regularly','your records confirm','you have confirmed','since you regularly','you regularly consume','you regularly use'];
    checks.declarative_language = words.some(w => emailBody.toLowerCase().includes(w));
  }
  if(test.expectSpanish) {
    const words = ['medicamentos','salud','porque','usted','favor','médico','farmacia',
      'estimado','querido','sus','sus medicamentos','riesgo','pastillas','por favor',
      'atentamente','saludos','equipo','revisión','interacción','suplemento'];
    const bodyLow = emailBody.toLowerCase();
    // Count matches — Spanish messages should have multiple Spanish words
    const matchCount = words.filter(w => bodyLow.includes(w)).length;
    checks.spanish_detected = matchCount >= 2;
  }
  const passed = checks.api_success && checks.has_email && checks.email_nonempty && checks.no_placeholder_tokens && checks.sms_length_ok;
  return { idx, test, checks, passed, ms: result.ms, error: result.error };
}

// ── REPORT GENERATOR ──────────────────────────────────────────────────────

function generateReport(surface, results) {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const times = results.map(r => r.ms).sort((a,b) => a-b);
  const p50 = times[Math.floor(total * 0.50)];
  const p95 = times[Math.floor(total * 0.95)];
  const p99 = times[Math.floor(total * 0.99)];
  const avgMs = Math.round(times.reduce((a,b) => a+b, 0) / total);
  const errors = results.filter(r => r.error);
  const byCategory = {};
  results.forEach(r => {
    const cat = r.test.category || 'unknown';
    if(!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0 };
    byCategory[cat].total++;
    if(r.passed) byCategory[cat].passed++;
  });
  const accTests = results.filter(r => r.checks.accuracy_correct !== null);
  const accPass = accTests.filter(r => r.checks.accuracy_correct).length;
  const checkStats = {};
  results.forEach(r => {
    Object.entries(r.checks).forEach(([k,v]) => {
      if(typeof v === 'boolean') {
        if(!checkStats[k]) checkStats[k] = { pass: 0, fail: 0 };
        if(v) checkStats[k].pass++; else checkStats[k].fail++;
      }
    });
  });

  let out = `
${'═'.repeat(65)}
  ${surface.toUpperCase()}
${'═'.repeat(65)}
  Total:      ${total}   Passed: ${passed} (${(passed/total*100).toFixed(1)}%)   Failed: ${total-passed}
  Errors:     ${errors.length}
  Seed:       ${SEED} (${today.toDateString()})

  RESPONSE TIMES:
  Avg: ${avgMs}ms  |  p50: ${p50}ms  |  p95: ${p95}ms  |  p99: ${p99}ms
  Min: ${times[0]}ms  |  Max: ${times[times.length-1]}ms
`;
  if(accTests.length > 0) out += `\n  ACCURACY (Known Interactions): ${accPass}/${accTests.length} (${(accPass/accTests.length*100).toFixed(1)}%)\n`;
  out += `\n  BY CATEGORY:\n`;
  Object.entries(byCategory).forEach(([cat, s]) => {
    out += `  ${cat.padEnd(22)} ${s.passed}/${s.total} (${(s.passed/s.total*100).toFixed(1)}%)\n`;
  });
  out += `\n  CHECK-LEVEL PASS RATES:\n`;
  Object.entries(checkStats).forEach(([k,v]) => {
    const t = v.pass + v.fail;
    const pct = (v.pass/t*100).toFixed(1);
    const flag = parseFloat(pct) < 90 ? ' ⚠' : '';
    out += `  ${k.padEnd(32)} ${v.pass}/${t} (${pct}%)${flag}\n`;
  });
  if(errors.length > 0) {
    out += `\n  ERRORS (first 5):\n`;
    errors.slice(0,5).forEach(r => out += `  #${r.idx}: ${r.error}\n`);
  }
  const fails = results.filter(r => !r.passed).slice(0,3);
  if(fails.length > 0) {
    out += `\n  SAMPLE FAILURES:\n`;
    fails.forEach(r => {
      const failedChecks = Object.entries(r.checks).filter(([,v]) => v === false).map(([k]) => k);
      out += `  #${r.idx} [${r.test.category}] Failed: ${failedChecks.join(', ')}\n`;
    });
  }
  return out;
}

// ── TREND TRACKING ────────────────────────────────────────────────────────

function updateTrend(runSummary) {
  let trend = [];
  if(fs.existsSync(TREND_FILE)) {
    try { trend = JSON.parse(fs.readFileSync(TREND_FILE, 'utf8')); } catch(e) {}
  }
  trend.push(runSummary);
  // Keep last 30 days
  if(trend.length > 30) trend = trend.slice(-30);
  fs.writeFileSync(TREND_FILE, JSON.stringify(trend, null, 2));
  return trend;
}

function generateTrendReport(trend) {
  let out = `\nTREND ANALYSIS (${trend.length} nights)\n${'─'.repeat(65)}\n`;
  out += `${'Date'.padEnd(12)} ${'Overall%'.padEnd(10)} ${'Analyze%'.padEnd(10)} ${'Proactive%'.padEnd(12)} ${'Outreach%'.padEnd(10)} ${'AvgMs'.padEnd(8)}\n`;
  trend.forEach(r => {
    out += `${r.date.padEnd(12)} ${r.overall.toFixed(1).padEnd(10)} ${r.analyze.toFixed(1).padEnd(10)} ${r.proactive.toFixed(1).padEnd(12)} ${r.outreach.toFixed(1).padEnd(10)} ${r.avgMs}\n`;
  });
  if(trend.length > 1) {
    const first = trend[0], last = trend[trend.length-1];
    const diff = last.overall - first.overall;
    out += `\nTrend: ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% overall since first run\n`;
    if(diff < -2) out += '⚠ WARNING: Pass rate declining — review recent changes\n';
    else if(diff > 2) out += '✓ IMPROVING: Pass rate trending upward\n';
    else out += '→ STABLE: Pass rate consistent\n';
  }
  return out;
}

function printTrendOnly() {
  if(!fs.existsSync(TREND_FILE)) { console.log('No trend data yet. Run the test suite first.'); return; }
  const trend = JSON.parse(fs.readFileSync(TREND_FILE, 'utf8'));
  console.log(generateTrendReport(trend));
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────

function scheduleNightly() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 5, 0, 0); // 12:05 AM
  const msUntilMidnight = midnight - now;
  const hoursUntil = (msUntilMidnight / 3600000).toFixed(1);
  console.log(`Scheduler active. Next run at ${midnight.toLocaleString()} (in ${hoursUntil} hours)`);
  console.log('Leave this terminal open overnight. Press Ctrl+C to stop.');
  setTimeout(async () => {
    console.log('\n⏰ Starting scheduled nightly run...');
    await runAllTests();
    scheduleNightly(); // schedule next night
  }, msUntilMidnight);
}

// ── MAIN TEST RUNNER ──────────────────────────────────────────────────────

async function runAllTests() {
  const dateStr = new Date().toISOString().slice(0,10);
  const jsonFile = path.join(RESULTS_DIR, `results_${dateStr}.json`);
  const reportFile = path.join(RESULTS_DIR, `report_${dateStr}.txt`);
  const allResults = { analyze: [], proactive: [], outreach: [] };
  const startTime = Date.now();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     IntractMD Automated Pressure Test Suite v2               ║');
  console.log(`║     Date: ${dateStr}   Seed: ${SEED}`.padEnd(64) + '║');
  console.log('║     1,500 tests — 500 per surface                            ║');
  console.log(`║     Target: ${BASE_URL}`.padEnd(64) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // SURFACE 1
  console.log('━━━ SURFACE 1: Main App (/api/analyze) ━━━━━━━━━━━━━━━━━━━━━━━');
  const analyzeTests = buildAnalyzeTests();
  for(let i = 0; i < analyzeTests.length; i++) {
    const r = await runAnalyzeTest(analyzeTests[i], i+1);
    allResults.analyze.push(r);
    process.stdout.write(r.passed ? '.' : 'x');
    if((i+1) % 50 === 0) {
      const p = allResults.analyze.filter(x=>x.passed).length;
      console.log(` [${i+1}/500] ${(p/(i+1)*100).toFixed(1)}%`);
    }
    await sleep(DELAY_MS);
  }
  console.log('\n');

  // SURFACE 2
  console.log('━━━ SURFACE 2: Proactive (/api/proactive-analyze) ━━━━━━━━━━━━');
  const proactiveTests = buildProactiveTests();
  for(let i = 0; i < proactiveTests.length; i++) {
    const r = await runProactiveTest(proactiveTests[i], i+1);
    allResults.proactive.push(r);
    process.stdout.write(r.passed ? '.' : 'x');
    if((i+1) % 50 === 0) {
      const p = allResults.proactive.filter(x=>x.passed).length;
      console.log(` [${i+1}/500] ${(p/(i+1)*100).toFixed(1)}%`);
    }
    await sleep(DELAY_MS);
  }
  console.log('\n');

  // SURFACE 3
  console.log('━━━ SURFACE 3: Clinical Outreach (/api/generate-outreach) ━━━━');
  const outreachTests = buildOutreachTests();
  for(let i = 0; i < outreachTests.length; i++) {
    const r = await runOutreachTest(outreachTests[i], i+1);
    allResults.outreach.push(r);
    process.stdout.write(r.passed ? '.' : 'x');
    if((i+1) % 50 === 0) {
      const p = allResults.outreach.filter(x=>x.passed).length;
      console.log(` [${i+1}/500] ${(p/(i+1)*100).toFixed(1)}%`);
    }
    await sleep(DELAY_MS);
  }
  console.log('\n');

  // SUMMARY
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const aPass = allResults.analyze.filter(r=>r.passed).length;
  const pPass = allResults.proactive.filter(r=>r.passed).length;
  const oPass = allResults.outreach.filter(r=>r.passed).length;
  const totalPass = aPass + pPass + oPass;
  const allTimes = [...allResults.analyze, ...allResults.proactive, ...allResults.outreach].map(r=>r.ms);
  const avgMs = Math.round(allTimes.reduce((a,b)=>a+b,0)/allTimes.length);

  // Update trend
  const runSummary = {
    date: dateStr, seed: SEED,
    overall: totalPass/1500*100,
    analyze: aPass/500*100,
    proactive: pPass/500*100,
    outreach: oPass/500*100,
    avgMs, elapsedSec: totalElapsed,
    totalTests: 1500, totalPassed: totalPass
  };
  const trend = updateTrend(runSummary);

  // Build full report
  let fullReport = `IntractMD Automated Pressure Test Report v2
Date: ${dateStr}  |  Seed: ${SEED}  |  Runtime: ${Math.floor(totalElapsed/60)}m ${totalElapsed%60}s
${'═'.repeat(65)}

OVERALL SUMMARY
  Total Tests:    1,500
  Passed:         ${totalPass} (${(totalPass/1500*100).toFixed(1)}%)
  Failed:         ${1500-totalPass} (${((1500-totalPass)/1500*100).toFixed(1)}%)
  Avg Response:   ${avgMs}ms

  Analyze:        ${aPass}/500 (${(aPass/5).toFixed(1)}%)
  Proactive:      ${pPass}/500 (${(pPass/5).toFixed(1)}%)
  Outreach:       ${oPass}/500 (${(oPass/5).toFixed(1)}%)
`;

  fullReport += generateReport('IntractMD Main App (/api/analyze)', allResults.analyze);
  fullReport += generateReport('IntractMD Proactive (/api/proactive-analyze)', allResults.proactive);
  fullReport += generateReport('Clinical Outreach (/api/generate-outreach)', allResults.outreach);
  fullReport += generateTrendReport(trend);
  fullReport += `\n${'═'.repeat(65)}\nEnd of Report — IntractMD Test Suite v2\n`;

  // Save files
  fs.writeFileSync(reportFile, fullReport);
  fs.writeFileSync(jsonFile, JSON.stringify({ summary: runSummary, results: allResults }, null, 2));

  console.log(fullReport);
  console.log(`\nReport: ${reportFile}`);
  console.log(`Data:   ${jsonFile}`);
  console.log(`Trend:  ${TREND_FILE}`);

  return runSummary;
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────

if(REPORT_MODE) {
  printTrendOnly();
} else if(SCHEDULE_MODE) {
  scheduleNightly();
} else {
  runAllTests().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
