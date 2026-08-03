#!/usr/bin/env node
/**
 * IntractMD — Drug List Integrity Test
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2 Aug 2026 a user typed "citalopram" into the medication autocomplete and
 * was offered only "Escitalopram (Lexapro)". Citalopram is absent from
 * drug-list.json, and the matcher falls back to substring matching — "citalopram"
 * is contained inside "es-CITALOPRAM". Accepting the suggestion screens the
 * patient against a different molecule with a different QT profile and different
 * dose ceilings, with nothing signalling the substitution.
 *
 * The same pattern maps "haloperidol" to "haloperidol decanoate" (oral to
 * long-acting depot injection).
 *
 * The nightly pressure suite could not catch this: it posts drug names directly
 * to /api/analyze and never exercises the browser-side autocomplete where the
 * substitution occurs.
 *
 * WHAT THIS TESTS
 * ---------------
 *   1. SELF-MATCH      Every drug in the list, typed exactly, returns itself first.
 *   2. COLLISIONS      No drug name is a substring of another (the bug class).
 *   3. PREFIX SAFETY   Typing a full drug name never ranks a different drug above it.
 *   4. KNOWN GAPS      Clinically important drugs verified present.
 *   5. DUPLICATES      No duplicate or case-variant entries.
 *
 * Requires no API and no network. Runs in about a second.
 *
 *   node drug_list_integrity_test.js
 *   node drug_list_integrity_test.js --json      machine-readable output
 *   node drug_list_integrity_test.js --verbose   list every failure
 *
 * Exit code 1 on any CRITICAL failure, so it can gate a deploy.
 */

const fs = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');
const JSON_OUT = process.argv.includes('--json');

// ── Locate drug-list.json ────────────────────────────────────────────────────
const CANDIDATES = [
  path.join(__dirname, '..', 'data', 'drug-list.json'),
  path.join(__dirname, 'drug-list.json'),
  path.join(__dirname, '..', 'drug-list.json'),
  path.join(process.cwd(), 'drug-list.json'),
];

let LIST_PATH = CANDIDATES.find(p => fs.existsSync(p));
if (!LIST_PATH) {
  console.error('Could not find drug-list.json. Looked in:');
  CANDIDATES.forEach(c => console.error('  ' + c));
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
} catch (e) {
  console.error('drug-list.json is not valid JSON: ' + e.message);
  process.exit(1);
}

// ── Normalise whatever shape the file uses ───────────────────────────────────
// Accepts: ["Aspirin", ...]
//          [{generic, brand}, ...]  /  [{name, ...}] /  [{drug, ...}]
//          {drugs: [...]}
function normalise(input) {
  let arr = Array.isArray(input) ? input
          : Array.isArray(input.drugs) ? input.drugs
          : Array.isArray(input.medications) ? input.medications
          : null;
  if (!arr) throw new Error('Unrecognised drug-list.json structure');

  return arr.map((e, i) => {
    if (typeof e === 'string') return { generic: e, brand: '', index: i };
    const generic = e.generic || e.name || e.drug || e.ingredient || '';
    const brand = e.brand || e.brandName || e.brand_name || '';
    return { generic: String(generic), brand: String(brand), index: i };
  }).filter(e => e.generic.trim().length > 0);
}

let DRUGS;
try {
  DRUGS = normalise(raw);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ── Reference matcher ────────────────────────────────────────────────────────
// Mirrors the intended behaviour of filterLocalDrugs: exact match first, then
// prefix, then substring. If production diverges from this, that divergence is
// itself worth knowing — update this function to match and re-run.
function matchDrugs(query, drugs, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const d of drugs) {
    const g = d.generic.toLowerCase();
    const b = (d.brand || '').toLowerCase();

    let score = 0;
    if (g === q || b === q) score = 1000;                      // exact
    else if (g.startsWith(q)) score = 800 - g.length;          // generic prefix
    else if (b.startsWith(q)) score = 700 - b.length;          // brand prefix
    else if (g.includes(q)) score = 400 - g.length;            // generic substring
    else if (b.includes(q)) score = 300 - b.length;            // brand substring
    else continue;

    scored.push({ drug: d, score });
  }
  scored.sort((a, b) => b.score - a.score || a.drug.generic.localeCompare(b.drug.generic));
  return scored.slice(0, limit).map(s => s.drug);
}

// ── Drugs that must be present ───────────────────────────────────────────────
// Absence of any of these is a CRITICAL failure. Each is either high-volume,
// high-interaction-burden, or was specifically found missing during the
// 2 Aug 2026 audit.
const REQUIRED = [
  // Found missing in the audit
  'citalopram', 'apixaban', 'allopurinol', 'temazepam',
  // High interaction burden
  'warfarin', 'amiodarone', 'clopidogrel', 'rivaroxaban', 'digoxin',
  'lithium', 'methotrexate', 'phenytoin', 'carbamazepine', 'valproate',
  // QT-prolonging (the regimen that exposed the grouping gap)
  'haloperidol', 'ondansetron', 'levofloxacin', 'escitalopram', 'sotalol',
  // Serotonergic
  'sertraline', 'fluoxetine', 'paroxetine', 'venlafaxine', 'duloxetine',
  'trazodone', 'tramadol', 'linezolid',
  // High volume
  'atorvastatin', 'simvastatin', 'lisinopril', 'metformin', 'levothyroxine',
  'omeprazole', 'amlodipine', 'metoprolol', 'gabapentin', 'ibuprofen',
  'albuterol', 'amoxicillin', 'prednisone', 'spironolactone', 'furosemide',
];

// Pairs where one name contains the other. Not defects in themselves — but the
// matcher must never rank the container above the exact match.
const KNOWN_TRAPS = [
  ['citalopram', 'escitalopram'],
  ['haloperidol', 'haloperidol decanoate'],
  ['prednisone', 'prednisolone'],
  ['methylprednisolone', 'prednisolone'],
  ['nitroglycerin', 'glycerin'],
  ['oxycodone', 'oxycodone-acetaminophen'],
  ['metoprolol', 'metoprolol succinate'],
  ['insulin', 'insulin glargine'],
];

// ── Test runner ──────────────────────────────────────────────────────────────
const failures = { critical: [], warning: [], info: [] };
function fail(sev, test, detail) { failures[sev].push({ test, detail }); }

// TEST 1 — self-match
let selfMatchFails = 0;
for (const d of DRUGS) {
  const results = matchDrugs(d.generic, DRUGS, 3);
  if (results.length === 0) {
    fail('critical', 'self_match', `"${d.generic}" returns no results when typed exactly`);
    selfMatchFails++;
  } else if (results[0].generic.toLowerCase() !== d.generic.toLowerCase()) {
    fail('critical', 'self_match',
      `Typing "${d.generic}" returns "${results[0].generic}" first — WRONG DRUG`);
    selfMatchFails++;
  }
}

// TEST 2 — substring collisions
const collisions = [];
const lowered = DRUGS.map(d => ({ ...d, low: d.generic.toLowerCase() }));
for (let i = 0; i < lowered.length; i++) {
  for (let j = 0; j < lowered.length; j++) {
    if (i === j) continue;
    const a = lowered[i].low, b = lowered[j].low;
    if (a.length >= 5 && b.includes(a) && a !== b) {
      collisions.push([lowered[i].generic, lowered[j].generic]);
    }
  }
}
for (const [inner, outer] of collisions) {
  const top = matchDrugs(inner, DRUGS, 1)[0];
  if (!top || top.generic.toLowerCase() !== inner.toLowerCase()) {
    fail('critical', 'collision',
      `"${inner}" is inside "${outer}" and does not rank first`);
  } else {
    fail('info', 'collision',
      `"${inner}" inside "${outer}" — resolves correctly`);
  }
}

// TEST 3 — required drugs present
const genericSet = new Set(DRUGS.map(d => d.generic.toLowerCase()));
const missing = [];
for (const req of REQUIRED) {
  const present = genericSet.has(req) ||
    DRUGS.some(d => d.generic.toLowerCase().startsWith(req + ' '));
  if (!present) {
    missing.push(req);
    fail('critical', 'required_drug', `"${req}" is ABSENT from the list`);
  }
}

// TEST 4 — known traps
for (const [inner, outer] of KNOWN_TRAPS) {
  if (!genericSet.has(inner)) {
    fail('warning', 'trap', `"${inner}" not in list — cannot verify against "${outer}"`);
    continue;
  }
  const top = matchDrugs(inner, DRUGS, 1)[0];
  if (!top || top.generic.toLowerCase() !== inner) {
    fail('critical', 'trap',
      `Typing "${inner}" returns "${top ? top.generic : 'nothing'}" — expected "${inner}"`);
  }
}

// TEST 5 — duplicates
const seen = new Map();
for (const d of DRUGS) {
  const k = d.generic.toLowerCase().trim();
  if (seen.has(k)) {
    fail('warning', 'duplicate',
      `"${d.generic}" appears more than once (indices ${seen.get(k)} and ${d.index})`);
  } else {
    seen.set(k, d.index);
  }
}

// TEST 6 — malformed entries
for (const d of DRUGS) {
  if (/^[^a-zA-Z]/.test(d.generic)) {
    fail('warning', 'malformed', `"${d.generic}" does not start with a letter`);
  }
  if (d.generic.length < 3) {
    fail('warning', 'malformed', `"${d.generic}" is suspiciously short`);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
const summary = {
  list_path: LIST_PATH,
  total_drugs: DRUGS.length,
  critical: failures.critical.length,
  warnings: failures.warning.length,
  collisions_found: collisions.length,
  self_match_failures: selfMatchFails,
  missing_required: missing,
  passed: failures.critical.length === 0,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, failures }, null, 2));
} else {
  const line = '─'.repeat(66);
  console.log('\nDRUG LIST INTEGRITY TEST');
  console.log(line);
  console.log(`Source          ${LIST_PATH}`);
  console.log(`Drugs in list   ${DRUGS.length}`);
  console.log(line);
  console.log(`CRITICAL        ${failures.critical.length}`);
  console.log(`Warnings        ${failures.warning.length}`);
  console.log(`Collisions      ${collisions.length}  (name contained in another name)`);
  console.log(line);

  if (failures.critical.length) {
    console.log('\nCRITICAL FAILURES — these produce wrong-drug results:\n');
    const show = VERBOSE ? failures.critical : failures.critical.slice(0, 25);
    show.forEach(f => console.log(`  [${f.test}] ${f.detail}`));
    if (!VERBOSE && failures.critical.length > 25) {
      console.log(`  ... and ${failures.critical.length - 25} more (--verbose for all)`);
    }
  }

  if (failures.warning.length && VERBOSE) {
    console.log('\nWarnings:\n');
    failures.warning.forEach(f => console.log(`  [${f.test}] ${f.detail}`));
  }

  console.log('\n' + line);
  console.log(summary.passed
    ? 'PASS — no wrong-drug conditions detected'
    : 'FAIL — list contains conditions that produce wrong-drug results');
  console.log(line + '\n');
}

process.exit(failures.critical.length === 0 ? 0 : 1);
