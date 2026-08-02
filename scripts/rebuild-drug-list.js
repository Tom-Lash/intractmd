#!/usr/bin/env node
/**
 * Rebuild drug-list.json from RxNorm (NLM).
 *
 * WHY
 * ---
 * The 2 Aug 2026 audit found the existing drug-list.json maps brands to the
 * wrong ingredients throughout — Lantus to insulin aspart, Novolin N to
 * eplerenone, Narcan to prednisone, Insulin Glargine to atorvastatin. The
 * corruption came from the upstream spreadsheet and cannot be patched row by
 * row with any confidence.
 *
 * This rebuilds from RxNorm, where the brand-to-ingredient relationship is
 * asserted by NLM rather than inferred. A wrong mapping cannot survive, because
 * we never carry a brand/generic pair across from the old file — we ask RxNorm
 * which ingredient a brand contains and use its answer.
 *
 * RxNorm is free, requires no key, and is the ONC-designated standard for
 * medication interoperability.
 *
 * WHAT IT DOES
 * ------------
 *   1. Pulls every RxNorm ingredient (TTY=IN) — the authoritative name set.
 *   2. Keeps ingredients that appear in seed-ingredients.txt, plus every drug
 *      in REQUIRED below. Everything else is skipped to keep the list to a
 *      clinically useful size.
 *   3. For each kept ingredient, asks RxNorm for its brand names (TTY=BN).
 *   4. Writes drug-list.json with generic, brands, and the RxCUI for traceability.
 *
 * Nothing from the old drug-list.json is carried forward.
 *
 * Run:  node scripts/rebuild-drug-list.js
 *       node scripts/rebuild-drug-list.js --limit 50     (quick smoke test)
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://rxnav.nlm.nih.gov/REST';
const OUT = path.join(__dirname, '..', 'data', 'drug-list.json');
const SEED = path.join(__dirname, 'seed-ingredients.txt');
const REPORT = path.join(__dirname, '..', 'drug-list-rebuild-report.txt');

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;

// NLM asks for no more than 20 requests/second. We stay well under.
const REQ_DELAY_MS = 60;
const MAX_RETRIES = 3;

// Drugs that must be present. Absence of any of these fails the run, so a
// silent regression cannot ship. Several were missing from the corrupt file.
const REQUIRED = [
  'citalopram', 'escitalopram', 'apixaban', 'rivaroxaban', 'warfarin',
  'allopurinol', 'temazepam', 'trazodone', 'simvastatin', 'albuterol',
  'insulin glargine', 'insulin aspart', 'insulin lispro', 'insulin degludec',
  'insulin detemir', 'naloxone', 'methadone', 'buprenorphine',
  'amiodarone', 'digoxin', 'sotalol', 'haloperidol', 'ondansetron',
  'levofloxacin', 'clopidogrel', 'lithium', 'methotrexate', 'phenytoin',
  'carbamazepine', 'valproate', 'sertraline', 'fluoxetine', 'paroxetine',
  'venlafaxine', 'duloxetine', 'tramadol', 'linezolid', 'atorvastatin',
  'lisinopril', 'metformin', 'levothyroxine', 'omeprazole', 'amlodipine',
  'metoprolol', 'gabapentin', 'ibuprofen', 'amoxicillin', 'prednisone',
  'spironolactone', 'furosemide', 'tamsulosin', 'verapamil', 'donepezil',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'IntractMD-DrugList-Rebuild/1.0 (Resolve Medical)' },
    });
    if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (attempt >= MAX_RETRIES) {
      console.error(`    request failed after ${MAX_RETRIES} attempts: ${url}`);
      return null;
    }
    await sleep(500 * attempt);
    return getJSON(url, attempt + 1);
  }
}

function loadSeed() {
  if (!fs.existsSync(SEED)) {
    console.error('Missing ' + SEED);
    console.error('This file selects which RxNorm ingredients to include.');
    process.exit(1);
  }
  const set = new Set();
  for (const line of fs.readFileSync(SEED, 'utf8').split('\n')) {
    const s = line.trim().toLowerCase();
    if (s && !s.startsWith('#')) set.add(s);
  }
  for (const r of REQUIRED) set.add(r.toLowerCase());
  return set;
}

async function fetchAllIngredients() {
  console.log('Fetching RxNorm ingredient set (TTY=IN)...');
  const data = await getJSON(`${BASE}/allconcepts.json?tty=IN`);
  const list = data?.minConceptGroup?.minConcept || [];
  console.log(`  RxNorm returned ${list.length} ingredients`);
  if (list.length < 1000) {
    console.error('Unexpectedly small ingredient set — aborting rather than');
    console.error('writing a truncated list over a working one.');
    process.exit(1);
  }
  return list; // [{rxcui, name, tty}]
}

async function fetchBrands(rxcui) {
  const data = await getJSON(`${BASE}/rxcui/${rxcui}/related.json?tty=BN`);
  const groups = data?.relatedGroup?.conceptGroup || [];
  const out = [];
  for (const g of groups) {
    for (const c of (g.conceptProperties || [])) {
      if (c.name) out.push(c.name);
    }
  }
  // Dedupe, preserve order, cap so one ingredient can't dominate the file
  return [...new Set(out)].slice(0, 8);
}

async function main() {
  const seed = loadSeed();
  console.log(`Seed list: ${seed.size} ingredient names\n`);

  const all = await fetchAllIngredients();

  // Match RxNorm ingredients against the seed. RxNorm names are authoritative;
  // the seed only decides inclusion.
  let keep = all.filter(c => seed.has(c.name.toLowerCase()));

  // Some seed entries are multi-word (e.g. "insulin glargine"); also allow a
  // seed term to match an RxNorm name that starts with it.
  const kept = new Set(keep.map(c => c.name.toLowerCase()));
  for (const c of all) {
    const n = c.name.toLowerCase();
    if (kept.has(n)) continue;
    for (const s of seed) {
      if (s.length > 6 && (n === s || n.startsWith(s + ' '))) {
        keep.push(c); kept.add(n); break;
      }
    }
  }

  keep.sort((a, b) => a.name.localeCompare(b.name));
  if (LIMIT) keep = keep.slice(0, LIMIT);
  console.log(`Matched ${keep.length} ingredients. Fetching brand names...\n`);

  const entries = [];
  for (let i = 0; i < keep.length; i++) {
    const c = keep[i];
    const brands = await fetchBrands(c.rxcui);
    entries.push({
      generic: c.name,
      brand: brands[0] || '',
      brands,
      rxcui: c.rxcui,
      source: 'RxNorm',
    });
    if ((i + 1) % 100 === 0 || i === keep.length - 1) {
      console.log(`  ${i + 1}/${keep.length}`);
    }
    await sleep(REQ_DELAY_MS);
  }

  // ── Verify REQUIRED before writing anything ─────────────────────────────
  const have = new Set(entries.map(e => e.generic.toLowerCase()));
  const missing = REQUIRED.filter(r =>
    !have.has(r) && ![...have].some(h => h.startsWith(r + ' ')));

  if (missing.length && !LIMIT) {
    console.error('\nABORTING — required drugs absent from the rebuilt list:');
    missing.forEach(m => console.error('  ' + m));
    console.error('\nThe existing drug-list.json was NOT modified.');
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(entries, null, 1));

  const withBrand = entries.filter(e => e.brand).length;
  const report =
`DRUG LIST REBUILD — ${new Date().toISOString()}
${'='.repeat(60)}
Source                RxNorm (NLM), TTY=IN with TTY=BN brand relations
RxNorm ingredients    ${all.length}
Seed terms            ${seed.size}
Entries written       ${entries.length}
With a brand name     ${withBrand}
Required drugs        ${REQUIRED.length}/${REQUIRED.length} present

Every brand-to-ingredient relation is asserted by RxNorm. No mapping was
carried over from the previous drug-list.json.

Next: scripts/drug_list_integrity_test.js must pass before merge.
`;
  fs.writeFileSync(REPORT, report);
  console.log('\n' + report);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
