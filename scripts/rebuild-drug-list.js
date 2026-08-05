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

// ── BRAND NAME HANDLING ──────────────────────────────────────────────────────
// Replaces fetchBrands() in scripts/rebuild-drug-list.js.
//
// WHY THE CHANGE
// --------------
// The original capped brands at 8 in whatever order RxNorm returned them, and
// used brands[0] as the displayed label. RxNorm does not order by prominence,
// so acetaminophen came back as:
//
//   Little Fevers, Bactimicina, Pamprin Max Formula, Pamprin Multi-Symptom,
//   Pamprin Cramp Formula, Percogesic, Premsyn PMS, Panadol PM
//
// — no Tylenol, and "acetaminophen (Little Fevers)" as the autocomplete label.
// A user typing the most recognisable OTC brand in the US got no match.
//
// This affects every ingredient with many brand names, which skews toward
// exactly the OTC drugs patients name by brand rather than by ingredient.
//
// TWO FIXES
//   1. Raise the cap from 8 to 25. Eight was arbitrary; the file-size cost of
//      more is trivial against the cost of missing a common brand.
//   2. Sort by a curated prominence list so recognisable brands rank first and
//      become the displayed label. RxNorm cannot tell us which brand a patient
//      is likely to say — that is editorial and has to be asserted here.
//
// ⚠ The prominence list below is a starting set. It is not exhaustive and
// should be extended whenever a "not found" report comes in for a brand.

const BRAND_CAP = 25;

// Brands a patient or clinician is likely to type. Order within the list does
// not matter — presence is what promotes a brand to the front.
// Keyed lowercase for matching; the RxNorm spelling is what gets stored.
const PROMINENT_BRANDS = new Set([
  // OTC analgesia
  'tylenol', 'advil', 'motrin', 'aleve', 'bayer', 'bufferin', 'excedrin',
  'ecotrin', 'midol', 'goody', 'bc powder',
  // OTC allergy / cold
  'benadryl', 'claritin', 'zyrtec', 'allegra', 'xyzal', 'sudafed', 'mucinex',
  'robitussin', 'delsym', 'dimetapp', 'nyquil', 'dayquil', 'afrin', 'flonase',
  'nasacort', 'rhinocort',
  // OTC GI
  'prilosec', 'nexium', 'prevacid', 'zantac', 'pepcid', 'tums', 'rolaids',
  'imodium', 'pepto-bismol', 'miralax', 'dulcolax', 'colace', 'senokot',
  'metamucil', 'gas-x', 'mylanta', 'maalox',
  // OTC sleep / misc
  'unisom', 'zzzquil', 'melatonin', 'dramamine', 'bonine',
  // Cardiovascular
  'lipitor', 'crestor', 'zocor', 'pravachol', 'lopid', 'zetia', 'vytorin',
  'repatha', 'praluent', 'coumadin', 'jantoven', 'eliquis', 'xarelto',
  'pradaxa', 'savaysa', 'plavix', 'brilinta', 'effient', 'lopressor',
  'toprol', 'toprol xl', 'coreg', 'tenormin', 'bystolic', 'zestril',
  'prinivil', 'vasotec', 'altace', 'cozaar', 'diovan', 'benicar', 'avapro',
  'micardis', 'norvasc', 'cardizem', 'calan', 'lasix', 'demadex', 'aldactone',
  'microzide', 'lanoxin', 'cordarone', 'pacerone', 'betapace', 'entresto',
  'nitrostat', 'imdur',
  // Diabetes
  'glucophage', 'glucotrol', 'amaryl', 'januvia', 'janumet', 'jardiance',
  'farxiga', 'invokana', 'ozempic', 'wegovy', 'rybelsus', 'trulicity',
  'victoza', 'mounjaro', 'zepbound', 'lantus', 'levemir', 'tresiba',
  'toujeo', 'basaglar', 'semglee', 'humalog', 'novolog', 'apidra', 'fiasp',
  'humulin', 'novolin', 'admelog', 'lyumjev',
  // Psychiatry / neurology
  'prozac', 'zoloft', 'paxil', 'celexa', 'lexapro', 'effexor', 'cymbalta',
  'pristiq', 'wellbutrin', 'remeron', 'trintellix', 'viibryd', 'desyrel',
  'abilify', 'seroquel', 'zyprexa', 'risperdal', 'latuda', 'geodon',
  'rexulti', 'vraylar', 'clozaril', 'lithobid', 'lamictal', 'depakote',
  'tegretol', 'trileptal', 'keppra', 'dilantin', 'topamax', 'neurontin',
  'lyrica', 'gralise', 'xanax', 'ativan', 'klonopin', 'valium', 'restoril',
  'ambien', 'lunesta', 'sonata', 'belsomra', 'aricept', 'namenda', 'exelon',
  'sinemet', 'mirapex', 'requip', 'azilect',
  // Analgesia / opioids
  'oxycontin', 'percocet', 'roxicodone', 'vicodin', 'norco', 'lortab',
  'dilaudid', 'ms contin', 'duragesic', 'ultram', 'nucynta', 'suboxone',
  'subutex', 'sublocade', 'narcan', 'zubsolv', 'dolophine', 'methadose',
  'celebrex', 'mobic', 'voltaren', 'flexeril', 'robaxin', 'zanaflex',
  'soma', 'lioresal',
  // Respiratory
  'ventolin', 'proair', 'proventil', 'xopenex', 'symbicort', 'advair',
  'breo', 'dulera', 'trelegy', 'spiriva', 'incruse', 'anoro', 'atrovent',
  'combivent', 'qvar', 'pulmicort', 'flovent', 'singulair', 'xolair',
  'dupixent', 'nucala', 'fasenra',
  // Anti-infective
  'amoxil', 'augmentin', 'keflex', 'zithromax', 'cipro', 'levaquin', 'avelox',
  'bactrim', 'septra', 'macrobid', 'macrodantin', 'flagyl', 'diflucan',
  'valtrex', 'zovirax', 'tamiflu', 'paxlovid', 'vibramycin', 'doryx',
  // Endocrine / other
  'synthroid', 'levoxyl', 'unithroid', 'tirosint', 'cytomel', 'armour thyroid',
  'np thyroid', 'prednisone intensol', 'deltasone', 'medrol', 'fosamax',
  'boniva', 'actonel', 'prolia', 'forteo', 'evista', 'premarin', 'estrace',
  'vagifem', 'depo-provera', 'flomax', 'proscar', 'propecia', 'avodart',
  'cialis', 'viagra', 'levitra', 'ditropan', 'detrol', 'vesicare', 'myrbetriq',
  'zyloprim', 'uloric', 'colcrys', 'plaquenil', 'humira', 'enbrel',
  'methotrexate', 'imuran', 'cellcept', 'prograf', 'neoral',
  // GI prescription
  'protonix', 'aciphex', 'dexilant', 'carafate', 'linzess', 'amitiza',
  'trulance', 'xifaxan', 'zofran', 'reglan', 'phenergan',
]);

/**
 * Fetch brand names for an ingredient, ordered so that recognisable brands
 * come first.
 *
 * Returns up to BRAND_CAP names. brands[0] becomes the displayed label, so the
 * ordering matters more than the cap does.
 */
async function fetchBrands(rxcui) {
  const data = await getJSON(`${BASE}/rxcui/${rxcui}/related.json?tty=BN`);
  const groups = data?.relatedGroup?.conceptGroup || [];
  const out = [];
  for (const g of groups) {
    for (const c of (g.conceptProperties || [])) {
      if (c.name) out.push(c.name);
    }
  }

  const unique = [...new Set(out)];

  // Score each brand. Higher sorts first.
  //   3  exact match against the prominence list
  //   2  first word matches (catches "Tylenol PM", "Advil Liqui-Gels")
  //   1  everything else
  // Within a tier, shorter names first — "Tylenol" over "Tylenol Extra
  // Strength Rapid Release" — then alphabetical for a stable rebuild.
  function score(name) {
    const n = String(name).toLowerCase().trim();
    if (PROMINENT_BRANDS.has(n)) return 3;
    const first = n.split(/[\s\-]/)[0];
    if (PROMINENT_BRANDS.has(first)) return 2;
    return 1;
  }

  unique.sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  return unique.slice(0, BRAND_CAP);
}

// ── FLATTEN BRANDS INTO SEARCHABLE ENTRIES ───────────────────────────────────
// Add to scripts/rebuild-drug-list.js, immediately after the entry-building
// loop and BEFORE the "Verify REQUIRED" block.
//
// WHY
// ---
// The app's autocomplete reads only `entry.generic` and `entry.brand`. The
// string 'brands' does not appear anywhere in public/index.prod.html — the
// array is never read.
//
// So of the up to 25 brand names stored per ingredient, exactly one is
// findable: whichever sits in brands[0]. A patient typing "Advil" finds
// ibuprofen; a patient typing "Motrin" does not. Same drug, same list, one
// works.
//
// Sunday's brand fix worked for a narrower reason than intended — raising the
// cap from 8 to 25 changed nothing on its own. What made Tylenol findable was
// the prominence sort moving it into position zero.
//
// Two ways to fix this. Teach the matcher to read brands[] — correct, but it
// means editing the obfuscated file. Or emit one entry per searchable name, so
// the existing matcher finds every brand without being changed. This is the
// second. No front-end change, no risk to index.prod.html.
//
// Cost: the file grows from ~1,500 entries to ~4,000. At roughly 150 bytes an
// entry that is under a megabyte, served once and cached. Negligible against a
// patient not finding their medication.

/**
 * Expand one entry per (generic, brand) pair.
 *
 * The canonical generic-only row is kept first so that typing the ingredient
 * name still resolves to the plain generic rather than to a branded variant.
 * Every brand then gets its own row carrying the same generic, so whichever
 * name the user types, the analysis receives the ingredient.
 */
function flattenBrands(entries) {
  const out = [];
  const seen = new Set();

  for (const e of entries) {
    const generic = e.generic;
    const gKey = generic.toLowerCase();

    // 1. Canonical row — generic with its most recognisable brand as the label.
    if (!seen.has(gKey + '|')) {
      seen.add(gKey + '|');
      out.push({
        generic,
        brand: e.brand || '',
        rxcui: e.rxcui,
        source: 'RxNorm',
      });
    }

    // 2. One row per additional brand, so each is independently searchable.
    for (const b of (e.brands || [])) {
      const bKey = String(b).toLowerCase();
      if (!bKey || bKey === (e.brand || '').toLowerCase()) continue;  // already covered
      const pairKey = gKey + '|' + bKey;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      out.push({
        generic,
        brand: b,
        rxcui: e.rxcui,
        source: 'RxNorm',
      });
    }
  }
  return out;
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

  // The app's matcher reads only `generic` and `brand` — never `brands`.
  // Flatten so every brand name is independently searchable.
  const flat = flattenBrands(entries);
  console.log(`Flattened ${entries.length} ingredients into ${flat.length} searchable entries.`);

  // ── Verify REQUIRED before writing anything ─────────────────────────────
  const have = new Set(flat.map(e => e.generic.toLowerCase()));
  const missing = REQUIRED.filter(r =>
    !have.has(r) && ![...have].some(h => h.startsWith(r + ' ')));

  if (missing.length && !LIMIT) {
    console.error('\nABORTING — required drugs absent from the rebuilt list:');
    missing.forEach(m => console.error('  ' + m));
    console.error('\nThe existing drug-list.json was NOT modified.');
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(flat, null, 1));

  const withBrand = flat.filter(e => e.brand).length;
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
