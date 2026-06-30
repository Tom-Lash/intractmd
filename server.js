#!/usr/bin/env node

console.log('[STARTUP] Process started');

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();

// ── File-based response cache ──────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD — PAIRWISE INTERACTION CACHE ARCHITECTURE
// ════════════════════════════════════════════════════════════════════════════
// Add this block to server.js, near your existing cache directory setup
// (alongside DRUG_INFO_CACHE_DIR, IFU_CACHE_DIR, etc.)
// ════════════════════════════════════════════════════════════════════════════

const PAIR_CACHE_DIR = path.join(__dirname, 'cache', 'drug-pairs');
if (!fs.existsSync(PAIR_CACHE_DIR)) fs.mkdirSync(PAIR_CACHE_DIR, { recursive: true });

// ── PAIR KEY GENERATION ──────────────────────────────────────────────────────
// Always alphabetize the pair so "Warfarin+Aspirin" and "Aspirin+Warfarin"
// resolve to the same cache file.

function pairKey(drugA, drugB) {
  const a = slugify(drugA);
  const b = slugify(drugB);
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function readPairCache(drugA, drugB) {
  try {
    const key = pairKey(drugA, drugB);
    const f = path.join(PAIR_CACHE_DIR, key + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {}
  return null;
}

function writePairCache(drugA, drugB, data) {
  try {
    const key = pairKey(drugA, drugB);
    fs.writeFileSync(path.join(PAIR_CACHE_DIR, key + '.json'), JSON.stringify(data), 'utf8');
  } catch (e) {}
}

// ── PAIR DATA STRUCTURE ──────────────────────────────────────────────────────
// Each cached pair stores structured data — NOT raw prose — so it composes
// cleanly into a multi-drug regimen analysis without re-calling the AI.
//
// {
//   drugA: "Warfarin",
//   drugB: "Aspirin",
//   hasInteraction: true,
//   severity: "Critical",              // Minimal | Low | Moderate | High | Critical
//   mechanism: "Additive anticoagulant and antiplatelet effects...",
//   action: "Avoid combination unless specifically directed by physician...",
//   dimensions: {                      // contribution to each of the 8 CPRS dimensions
//     "Bleeding Risk": 88,
//     "Cardiac Risk": 5,
//     "Serotonin Risk": 0,
//     "NTI Conflict": 40,
//     "CNS Risk": 0,
//     "CYP450 Risk": 10,
//     "Renal/Hepatic": 5,
//     "Pharmacodynamic": 15
//   },
//   computedAt: "2026-06-30T12:00:00Z",
//   source: "precomputed-batch-v1"      // vs "live-fallback" for cache misses filled at runtime
// }


// ── REGIMEN DECOMPOSITION: TURN AN N-DRUG LIST INTO PAIRS ───────────────────

function decomposeToPairs(drugList) {
  const pairs = [];
  for (let i = 0; i < drugList.length; i++) {
    for (let j = i + 1; j < drugList.length; j++) {
      pairs.push([drugList[i], drugList[j]]);
    }
  }
  return pairs;
}


// ── MAIN LOOKUP: CHECK CACHE FOR ALL PAIRS, RETURN GAPS ─────────────────────

function lookupPairsFromCache(drugList) {
  const pairs = decomposeToPairs(drugList);
  const found = [];
  const missing = [];

  for (const [a, b] of pairs) {
    const cached = readPairCache(a, b);
    if (cached) {
      found.push(cached);
    } else {
      missing.push([a, b]);
    }
  }

  return { found, missing, totalPairs: pairs.length };
}


// ── COMPOSITE SCORING FROM CACHED PAIRS (NO AI CALL) ────────────────────────
// This implements the same weighting logic as your CPRS algorithm spec,
// but operating on cached structured data instead of asking Claude to
// re-derive it from scratch every time.

const CPRS_WEIGHTS = {
  'Bleeding Risk': 0.22, 'Cardiac Risk': 0.18, 'Serotonin Risk': 0.15,
  'NTI Conflict': 0.14, 'CNS Risk': 0.12, 'CYP450 Risk': 0.10,
  'Renal/Hepatic': 0.05, 'Pharmacodynamic': 0.04
};

function computeCompositeFromPairs(foundPairs, totalSubstanceCount) {
  // Aggregate max severity per dimension across all pairs (conservative: take the max, not sum,
  // to avoid double-counting when multiple pairs touch the same dimension)
  const dimMax = {};
  for (const dim of Object.keys(CPRS_WEIGHTS)) dimMax[dim] = 0;

  let maxSeverity = 'Minimal';
  const severityRank = { Minimal: 0, Low: 1, Moderate: 2, High: 3, Critical: 4 };

  for (const pair of foundPairs) {
    if (!pair.hasInteraction) continue;
    for (const [dim, score] of Object.entries(pair.dimensions || {})) {
      if (score > dimMax[dim]) dimMax[dim] = score;
    }
    if (severityRank[pair.severity] > severityRank[maxSeverity]) {
      maxSeverity = pair.severity;
    }
  }

  // Weighted sum (Mi cross-category multiplier would be applied here if pair
  // metadata includes substance category — extend pair schema with
  // categoryA/categoryB fields to enable this in a future iteration)
  let weightedSum = 0;
  for (const [dim, weight] of Object.entries(CPRS_WEIGHTS)) {
    weightedSum += weight * dimMax[dim];
  }

  // Phi: polypharmacy burden factor
  const phi = 1 + 0.05 * Math.max(0, totalSubstanceCount - 4);

  // Kappa: severity floor
  const kappa = maxSeverity === 'Critical' ? 1.25 : 1.0;

  const cprs = Math.min(100, weightedSum * phi * kappa);

  return {
    cprs: Math.round(cprs),
    maxSeverity,
    dimensions: dimMax,
    phi: Math.round(phi * 100) / 100,
    kappa
  };
}


// ── HYBRID ANALYSIS: CACHE-FIRST, AI-FALLBACK-FOR-GAPS-ONLY ─────────────────
// This replaces a full fresh Claude call with: cache lookup for all pairs,
// then a SINGLE targeted Claude call only for the missing pairs (if any),
// then composes the final result algorithmically.

async function analyzeRegimenHybrid(drugList, anthropicApiKey) {
  const { found, missing, totalPairs } = lookupPairsFromCache(drugList);

  console.log(`[HYBRID] ${drugList.length} drugs → ${totalPairs} pairs. ` +
    `Cache hits: ${found.length}, misses: ${missing.length}`);

  let newlyComputed = [];

  if (missing.length > 0) {
    // Only call Claude for the gap — not the whole regimen
    newlyComputed = await fetchMissingPairsFromClaude(missing, anthropicApiKey);
    // Cache each newly computed pair for next time
    for (const pair of newlyComputed) {
      writePairCache(pair.drugA, pair.drugB, { ...pair, source: 'live-fallback', computedAt: new Date().toISOString() });
    }
  }

  const allPairs = [...found, ...newlyComputed];
  const composite = computeCompositeFromPairs(allPairs, drugList.length);

  return {
    cprs: composite.cprs,
    riskTier: composite.cprs >= 81 ? 'Critical' : composite.cprs >= 61 ? 'High' :
              composite.cprs >= 41 ? 'Moderate' : composite.cprs >= 21 ? 'Low' : 'Minimal',
    dimensions: composite.dimensions,
    interactions: allPairs.filter(p => p.hasInteraction),
    cacheStats: {
      totalPairs,
      cacheHits: found.length,
      cacheMisses: missing.length,
      hitRate: totalPairs > 0 ? Math.round((found.length / totalPairs) * 100) : 100
    }
  };
}


// ── TARGETED CLAUDE CALL FOR MISSING PAIRS ONLY ─────────────────────────────
// Batches all missing pairs into ONE Claude call (not one call per pair)
// to keep cost and latency down even on partial cache misses.

async function fetchMissingPairsFromClaude(missingPairs, apiKey) {
  const pairList = missingPairs.map(([a, b]) => `${a} + ${b}`).join('\n');

  const prompt = `You are a clinical pharmacologist. For EACH of the following drug pairs, determine if a clinically significant interaction exists.

Drug pairs to analyze:
${pairList}

Return ONLY valid JSON — an array with one object per pair, in the same order:
[
  {
    "drugA": "<first drug>",
    "drugB": "<second drug>",
    "hasInteraction": <true|false>,
    "severity": "<Minimal|Low|Moderate|High|Critical>",
    "mechanism": "<brief clinical mechanism, empty string if no interaction>",
    "action": "<patient guidance, empty string if no interaction>",
    "dimensions": {
      "Bleeding Risk": <0-100>, "Cardiac Risk": <0-100>, "Serotonin Risk": <0-100>,
      "NTI Conflict": <0-100>, "CNS Risk": <0-100>, "CYP450 Risk": <0-100>,
      "Renal/Hepatic": <0-100>, "Pharmacodynamic": <0-100>
    }
  }
]`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array in Claude response');
  return JSON.parse(match[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// USAGE — replace your existing full-regimen Claude call with:
//
//   const result = await analyzeRegimenHybrid(drugNamesArray, process.env.ANTHROPIC_API_KEY);
//
// result.cacheStats.hitRate tells you what % of the regimen was served from
// cache vs. live AI — useful to log/monitor during the pilot.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD — PAIRWISE INTERACTION CACHE ARCHITECTURE
// ════════════════════════════════════════════════════════════════════════════
//
//   const result = await analyzeRegimenHybrid(drugNamesArray, process.env.ANTHROPIC_API_KEY);
//
// result.cacheStats.hitRate tells you what % of the regimen was served from
// cache vs. live AI — useful to log/monitor during the pilot.
// ════════════════════════════════════════════════════════════════════════════
const DRUG_INFO_CACHE_DIR = path.join(__dirname, 'cache', 'drug-info');
const IFU_CACHE_DIR = path.join(__dirname, 'cache', 'ifu');
const DRUG_INFO_ES_CACHE_DIR = path.join(__dirname, 'cache', 'drug-info-es');
const IFU_ES_CACHE_DIR = path.join(__dirname, 'cache', 'ifu-es');
[DRUG_INFO_CACHE_DIR, IFU_CACHE_DIR, DRUG_INFO_ES_CACHE_DIR, IFU_ES_CACHE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function slugify(name) {
  return name.toLowerCase()
    .replace(/\s+(calcium|sodium|hydrochloride|hcl|sulfate|bisulfate|maleate|tartrate|oxalate|mesylate|besylate|succinate|fumarate|phosphate|acetate|chloride|bromide|potassium|magnesium|zinc|citrate|gluconate|tannate|pamoate|stearate|valerate|benzoate|propionate)\b.*/i, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readFileCache(dir, slug) {
  try {
    const f = path.join(dir, slug + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {}
  return null;
}

function writeFileCache(dir, slug, data) {
  try { fs.writeFileSync(path.join(dir, slug + '.json'), JSON.stringify(data), 'utf8'); } catch (e) {}
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('[STARTUP] Middleware configured');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve local drug list for instant frontend autocomplete
app.get('/api/drug-list', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'drug-list.json'), 'utf8')));
  } catch (e) { res.json([]); }
});

// Drug data cache
const drugDataCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

app.get('/api/nlm/:p(*)', async (req, res) => {
  try {
    const url = 'https://rxnav.nlm.nih.gov/REST/' + req.params.p + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const t = await r.text();
    try { res.json(JSON.parse(t)); } catch { res.json({}); }
  } catch { res.json({}); }
});

function tryParseJSON(raw) {
  const strip = s => s.replace(/^```json\s*/gm, '').replace(/^```\s*/gm, '').replace(/```\s*$/gm, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  const candidates = [raw, strip(raw)];
  for (const s of candidates) {
    try { return JSON.parse(s); } catch (e) { }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { } }
  }
  return null;
}

async function safeFetch(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } }); }
  finally { clearTimeout(t); }
}

async function fetchDrugData(drugName) {
  const cacheKey = drugName.toLowerCase().trim();
  const cached = drugDataCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }

  const enc = encodeURIComponent(drugName);
  const fdaEnc = encodeURIComponent('"' + drugName + '"');
  const d = { name: drugName, rxcui: null, drugClass: null, warnings: null, interactions: null, contraindications: null, rxnormInteractions: [], sources: [] };

  await Promise.all([
    (async () => {
      try {
        const r = await safeFetch(`https://connect.nlm.nih.gov/query?mainSearchCriteria.v.dn=${enc}&knowledgeResponseType=application/json`);
        if (r.ok) d.sources.push('MedlinePlus');
      } catch (e) { }
    })(),
    (async () => {
      try {
        const r = await safeFetch(`https://api.fda.gov/drug/label.json?search=openfda.generic_name:${fdaEnc}&limit=1${process.env.OPENFDA_API_KEY ? "&api_key=" + process.env.OPENFDA_API_KEY : ""}`);
        if (r.ok) {
          const data = await r.json();
          const label = data.results && data.results[0];
          if (label) {
            const clip = s => s ? String(s).slice(0, 400) : null;
            d.warnings = clip(label.warnings?.[0]);
            d.interactions = clip(label.drug_interactions?.[0]);
            d.contraindications = clip(label.contraindications?.[0]);
            d.sources.push('OpenFDA');
          }
        }
      } catch (e) { }
    })(),
    (async () => {
      try {
        const r1 = await safeFetch(`https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${enc}&search=2`);
        if (r1.ok) {
          const d1 = await r1.json();
          const rxcui = d1.idGroup?.rxnormId?.[0];
          if (rxcui) {
            d.rxcui = rxcui;
            await Promise.all([
              (async () => {
                try {
                  const r2 = await safeFetch(`https://rxnav.nlm.nih.gov/REST/rxclass/class/byRxcui.json?rxcui=${rxcui}`);
                  if (r2.ok) {
                    const d2 = await r2.json();
                    const classes = d2.rxclassDrugInfoList?.rxclassDrugInfo;
                    if (classes && classes.length) {
                      const epc = classes.find(c => c.rxclassMinConceptItem?.classType === 'EPC') || classes[0];
                      d.drugClass = epc?.rxclassMinConceptItem?.className || null;
                      d.sources.push('RxNorm');
                    }
                  }
                } catch (e) { }
              })(),
              (async () => {
                try {
                  const r3 = await safeFetch(`https://rxnav.nlm.nih.gov/REST/interaction/interaction.json?rxcui=${rxcui}`, 7000);
                  if (r3.ok) {
                    const d3 = await r3.json();
                    const pairs = [];
                    for (const g of (d3.interactionTypeGroup || [])) {
                      for (const t of (g.interactionType || [])) {
                        for (const p of (t.interactionPair || [])) {
                          if (p.description) pairs.push(p.description.slice(0, 200));
                          if (pairs.length >= 6) break;
                        }
                        if (pairs.length >= 6) break;
                      }
                      if (pairs.length >= 6) break;
                    }
                    if (pairs.length) {
                      d.rxnormInteractions = pairs;
                      if (!d.sources.includes('RxNorm')) d.sources.push('RxNorm');
                    }
                  }
                } catch (e) { }
              })()
            ]);
          }
        }
      } catch (e) { }
    })()
  ]);

  drugDataCache.set(cacheKey, { data: d, expires: Date.now() + CACHE_TTL });
  return d;
}

function buildGroundingContext(drugDataArr) {
  const lines = [];
  for (const d of drugDataArr) {
    const parts = [];
    if (d.drugClass) parts.push(`Class: ${d.drugClass}`);
    if (d.warnings) parts.push(`FDA Warnings: ${d.warnings}`);
    if (d.interactions) parts.push(`FDA Drug Interactions: ${d.interactions}`);
    if (d.contraindications) parts.push(`FDA Contraindications: ${d.contraindications}`);
    if (d.rxnormInteractions.length) parts.push(`RxNorm documented interactions: ${d.rxnormInteractions.slice(0, 3).join(' | ')}`);
    if (parts.length) lines.push(`${d.name}: ${parts.join('. ')}`);
  }
  if (!lines.length) return '';
  return `REAL-TIME FDA AND RXNORM DATA (use as primary grounding source):\n${lines.join('\n')}\n\n`;
}

async function callClaude(k, prompt, maxTok = 4096, lang = 'en') {
  const langInstr = lang === 'es'
    ? ' Respond entirely in Spanish (español), using clear, patient-friendly language appropriate for Spanish-speaking patients in the United States. Keep drug names in their standard form (generic or brand as provided) but explain all mechanisms, effects, instructions, and recommendations in Spanish.'
    : '';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTok,
      system: 'You are a senior clinical pharmacist and pharmacologist with deep expertise in drug interactions, pharmacokinetics, and patient safety. Respond with raw valid JSON ONLY. Do NOT use markdown code blocks, backticks, or any prose. Your entire response must begin with { and end with }.' + langInstr,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || '{}';
}

app.post('/api/analyze', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!k) return res.status(401).json({ error: 'No API key' });

  const { drugs = [], patient, supplements = [], foods = [], language = 'en' } = req.body;
  const meds = drugs.length + supplements.length;
  if (meds + foods.length < 2 || meds < 1) return res.status(400).json({ error: 'At least 2 medications/supplements required' });

  const ptL = [];
  if (patient) {
    if (patient.age) ptL.push('Age:' + patient.age);
    if (patient.weight) ptL.push('Weight:' + patient.weight + 'kg');
    if (patient.sex) ptL.push('Sex:' + patient.sex);
    if (patient.renal) ptL.push('Renal:' + patient.renal);
    if (patient.hepatic) ptL.push('Hepatic:' + patient.hepatic);
    if (patient.conditions) ptL.push('Conditions:' + patient.conditions);
    if (patient.elderly) ptL.push('Elderly/Beers');
    if (patient.pregnant) ptL.push('Pregnant');
    if (patient.pediatric) ptL.push('Pediatric');
  }
  const ddP = [], dsP = [], ssP = [], dfP = [], sfP = [];
  for (let i = 0; i < drugs.length; i++) for (let j = i + 1; j < drugs.length; j++) ddP.push(drugs[i] + '+' + drugs[j]);
  // PAIR CACHE LOOKUP — checks pre-computed cache before calling Claude
  const pairCacheLookup = lookupPairsFromCache(drugs);
  const cachedDDPairs = pairCacheLookup.found;
  const missingDDPairs = pairCacheLookup.missing;
  const cachedDDInteractions = cachedDDPairs.filter(function(p){ return p.hasInteraction; });
  console.log("[CACHE] hits:" + cachedDDPairs.length + " misses:" + missingDDPairs.length);
  for (let i = 0; i < drugs.length; i++) for (let j = 0; j < supplements.length; j++) dsP.push(drugs[i] + '+' + supplements[j]);
  for (let i = 0; i < supplements.length; i++) for (let j = i + 1; j < supplements.length; j++) ssP.push(supplements[i] + '+' + supplements[j]);
  for (let i = 0; i < drugs.length; i++) for (let j = 0; j < foods.length; j++) dfP.push(drugs[i] + '+' + foods[j]);
  for (let i = 0; i < supplements.length; i++) for (let j = 0; j < foods.length; j++) sfP.push(supplements[i] + '+' + foods[j]);

  const drugDataArr = await Promise.all(drugs.map(fetchDrugData));
  const realtimeSourcesSet = new Set();
  drugDataArr.forEach(d => d.sources.forEach(s => realtimeSourcesSet.add(s)));
  const realtimeSources = [...realtimeSourcesSet];
  const groundingContext = buildGroundingContext(drugDataArr);

  const splitCalls = drugs.length + supplements.length + foods.length > 6 && foods.length > 0;
  const pt = ptL.length ? ptL.join(',') : 'none';

  const SUPP_REF = 'SUPPLEMENT REF: SJW=CYP3A4/2C9/Pgp inducer(reduces warfarin/SSRIs/OCP). Ginkgo=antiplatelet(bleeding+warfarin/NSAIDs/aspirin). Garlic=antiplatelet+anticoagulant. CoQ10=vit-K analog(reduces warfarin). Valerian=CNS depressant(+benzos/opioids). Melatonin=CNS depressant. Turmeric=antiplatelet+CYP2C9-inhib. Echinacea=immunostimulant(avoid cyclosporine/tacrolimus). Mg=chelation(separate fluoroquinolones/tetracyclines 2-4h). Ginseng=unpredictable warfarin INR.';
  const FOOD_REF = 'FOOD REF: Grapefruit/Pomelo/Seville=CYP3A4-inhib(increases statins/CCBs/cyclosporine/tacrolimus/midazolam/amiodarone/sildenafil,24-72h avoid). Alcohol=CNS depressant+hepatotoxic(additive sedation+CNS drugs; disulfiram rxn+metronidazole; potentiates warfarin; GI bleed+NSAIDs; hypoglycemia+insulin). Green Leafy Veg=vitamin K(reduces warfarin INR). Tyramine+MAOIs=hypertensive crisis MAJOR. Dairy=calcium chelation(reduce fluoroquinolone/tetracycline/bisphosphonate/levothyroxine absorption; separate 2-4h). Caffeine=adenosine antagonist(blocks adenosine/dipyridamole; increases lithium excretion; +theophylline). Cranberry=CYP2C9 inhib(may increase warfarin). Chargrilled meat=CYP1A2 inducer(reduces clozapine/olanzapine/theophylline). High-fat=increases lipophilic drug absorption(isotretinoin/atazanavir).';

  const includeFoodInMain = !splitCalls && foods.length > 0;
  const foodSchema = `"food_interactions":[{"drugs":"<drug or supp name>","food":"<food>","severity":"major|moderate|minor","mechanism":"1 sentence","clinical_effect":"1 sentence","timing":"1 sentence","monitoring":"1 sentence","action":"1 sentence"}]`;

  const mainPrompt = `${groundingContext}Drug interaction analysis. Keep ALL text fields to 2 sentences max.\n\nDRUGS:${drugs.length ? drugs.join(',') : 'None'} SUPPLEMENTS:${supplements.length ? supplements.join(',') : 'None'}${includeFoodInMain ? ' FOODS:' + foods.join(',') : ''}\nPATIENT:${pt}\nPAIRS DD(${ddP.length}):${ddP.join('|') || 'none'} DS(${dsP.length}):${dsP.join('|') || 'none'} SS(${ssP.length}):${ssP.join('|') || 'none'}${includeFoodInMain ? ' DF(' + dfP.length + '):' + dfP.join('|') : ''}${includeFoodInMain && sfP.length ? ' SF(' + sfP.length + '):' + sfP.join('|') : ''}\n${SUPP_REF}${includeFoodInMain ? '\n' + FOOD_REF : ''}\n\nReturn ONLY this raw JSON (no markdown, begin with {, end with }):\n{"overall_risk":"HIGH|MODERATE|LOW|MINIMAL","risk_score":0,"summary":"2 sentences","known_interactions":[{"drugs":"A+B","type":"drug-drug|drug-supplement|supplement-supplement","severity":"major|moderate|minor","mechanism":"","clinical_effect":"","evidence":"","monitoring":"","action":"","patient_specific":""}],${includeFoodInMain ? foodSchema + ',' : ''},"predictive_interactions":[{"drugs":"A+B","type":"drug-drug|drug-supplement|supplement-supplement","severity":"major|moderate|minor","basis":"","clinical_effect":"","probability":"high|moderate|low","monitoring":"","action":"","validation_sources":["RxNorm","FDA label","pharmacological mechanism"],"confidence_basis":"1 sentence mechanistic basis"}],"polypharmacy_assessment":{"overall_burden":"1 sentence","cumulative_risks":"1 sentence","shared_pathways":"1 sentence","cascade_risks":"1 sentence","recommendations":"1 sentence"},"key_concern":"1 sentence","contraindicated":false,"executive_summary":"3 sentences","data_sources":["RxNorm","OpenFDA","MedlinePlus"]}`;

  const foodOnlyPrompt = `Food interaction analysis ONLY. Keep ALL fields to 1 sentence.\n\nDRUGS:${drugs.join(',')} SUPPLEMENTS:${supplements.length ? supplements.join(',') : 'None'} FOODS:${foods.join(',')}\nPATIENT:${pt}\nDF(${dfP.length}):${dfP.join('|')} SF(${sfP.length}):${sfP.length ? sfP.join('|') : 'none'}\n${FOOD_REF}\nHIGH-PRIORITY: grapefruit+statins/CCBs/immunosuppressants, alcohol+CNS-depressants/warfarin/metronidazole, VitK+warfarin, tyramine+MAOIs, dairy+fluoroquinolones/tetracyclines.\n\nReturn ONLY this raw JSON (no markdown, begin with {, end with }):\n{${foodSchema}}`;

  try {
    let raw, rawF = null;
    if (splitCalls && foods.length > 0) {
      [raw, rawF] = await Promise.all([callClaude(k, mainPrompt, 4096, language), callClaude(k, foodOnlyPrompt, 2048, language)]);
    } else {
      raw = await callClaude(k, mainPrompt, 4096, language);
    }

    let result = tryParseJSON(raw);
    if (!result) {
      const retryPrompt = 'IMPORTANT: Return raw JSON only, starting with { ending with }. No markdown, no backticks.\n\nDrug interactions for: ' + drugs.join(',') + (supplements.length ? ', supps:' + supplements.join(',') : '') + (includeFoodInMain && foods.length ? ', foods:' + foods.join(',') : '') + '.\n\n' + mainPrompt;
      raw = await callClaude(k, retryPrompt, 4096, language);
      result = tryParseJSON(raw);
      if (!result) {
        return res.status(500).json({ error: 'AI response could not be parsed after two attempts. Please try again.' });
      }
    }

    if (splitCalls && foods.length > 0) {
      let foodResult = tryParseJSON(rawF);
      if (!foodResult) {
        const retryF = 'IMPORTANT: Return raw JSON only, starting with { ending with }. No markdown.\n\n' + foodOnlyPrompt;
        rawF = await callClaude(k, retryF, 2048);
        foodResult = tryParseJSON(rawF);
      }
      result.food_interactions = (foodResult && foodResult.food_interactions) || [];
    }

    if (!result.food_interactions) result.food_interactions = [];
    result.realtime_sources = realtimeSources;
    res.json(result);

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/ocr', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!k) return res.status(401).json({ error: 'No API key' });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image' });
  const base64 = image.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 128,
        messages: [{
          role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'This is a photo of a medication label or pill bottle. Extract ONLY the primary drug/medication name (generic or brand). Reply with just the drug name, nothing else. If you cannot identify one, reply: unknown' }
          ]
        }]
      })
    });
    const d = await r.json();
    const drug = ((d.content && d.content[0] && d.content[0].text) || '').trim();
    res.json({ drug });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/risk', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'No API key' });
  const { drugs = [], supplements = [], foods = [], patient = {}, language = 'en' } = req.body;
  const drugsList = Array.isArray(drugs) ? drugs.map(d => typeof d === 'string' ? d : (d.display || d)) : [];
  const allItems = [...drugsList, ...(Array.isArray(supplements) ? supplements : []), ...(Array.isArray(foods) ? foods : [])].filter(Boolean);
  if (allItems.length < 2) return res.status(400).json({ error: 'At least 2 items required' });

  let groundingContext = '';
  if (drugsList.length) {
    const drugDataArr = await Promise.all(drugsList.map(fetchDrugData));
    groundingContext = buildGroundingContext(drugDataArr);
  }

  const patientParts = Object.entries(patient).filter(e => e[1] && e[1] !== '' && e[1] !== 'none');
  const patientStr = patientParts.length ? patientParts.map(e => e[0] + ': ' + e[1]).join(', ') : 'No specific patient factors provided';
  const prompt = groundingContext
    + 'You are performing predictive risk scoring for a multi-drug regimen. Use the real-time FDA and RxNorm data above as your primary grounding source.\n\n'
    + 'MEDICATIONS/SUPPLEMENTS/FOODS: ' + allItems.join(', ') + '\n'
    + 'PATIENT FACTORS: ' + patientStr + '\n\n'
    + 'Return ONLY raw valid JSON — no markdown, no backticks, no prose. Start with { end with }.\n'
    + 'Use this exact structure:\n'
    + '{"overall_score":<integer 0-100>,"risk_level":"<CRITICAL|HIGH|MODERATE|LOW|MINIMAL>",'
    + '"risk_breakdown":{'
    + '"pharmacokinetic":{"score":<0-100>,"explanation":"<1 sentence: why this score for this specific regimen>"},'
    + '"pharmacodynamic":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"narrow_therapeutic_index":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"renal_hepatic_burden":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"cns_depression":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"bleeding_risk":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"cardiac_risk":{"score":<0-100>,"explanation":"<1 sentence>"},'
    + '"serotonin_syndrome":{"score":<0-100>,"explanation":"<1 sentence>"}},'
    + '"top_risks":[{"risk":"<concise name>","score":<0-100>,"drugs_involved":["drug1"],"explanation":"<1-2 sentence clinical explanation>","urgency":"<immediate|monitor|watch>"}],'
    + '"patient_factors":"<how patient factors modify risk>","trend":"<improving|stable|worsening>",'
    + '"recommendations":["<specific action 1>","<specific action 2>","<specific action 3>"]}\n\n'
    + 'Scoring guide: MINIMAL=0-20, LOW=21-40, MODERATE=41-60, HIGH=61-80, CRITICAL=81-100. '
    + 'Each risk_breakdown explanation must be a single sentence specific to this patient\'s regimen — state the key reason for the score (e.g. which drugs interact, what pathway is affected). '
    + 'Include 2-5 top_risks ordered by severity. urgency: immediate=same-day clinical action required, monitor=set monitoring parameters, watch=observe for symptoms. '
    + 'recommendations must be specific and actionable for this exact regimen.';
  try {
    const raw = await callClaude(apiKey, prompt, 2000, language);
    const parsed = tryParseJSON(raw);
    if (!parsed) return res.status(502).json({ error: 'Failed to parse AI response' });
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/drug-info', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'No API key' });
  const { drugName, language = 'en' } = req.body;
  if (!drugName) return res.status(400).json({ error: 'drugName required' });

  const drugInfoCacheDir = language === 'es' ? DRUG_INFO_ES_CACHE_DIR : DRUG_INFO_CACHE_DIR;
  const slug = slugify(drugName);
  const cached = readFileCache(drugInfoCacheDir, slug);
  if (cached) return res.json({ ...cached, cached: true });

  const drugData = await fetchDrugData(drugName);
  const groundingParts = [];
  if (drugData.drugClass) groundingParts.push(`Drug class: ${drugData.drugClass}`);
  if (drugData.warnings) groundingParts.push(`FDA warnings: ${drugData.warnings}`);
  if (drugData.interactions) groundingParts.push(`FDA drug interactions section: ${drugData.interactions}`);
  if (drugData.contraindications) groundingParts.push(`FDA contraindications: ${drugData.contraindications}`);
  const groundingContext = groundingParts.length
    ? `REAL-TIME FDA DATA FOR ${drugName}:\n${groundingParts.join('\n')}\n\nUse the above official FDA label data as your primary source. Do not contradict it.\n\n`
    : '';

  const prompt = groundingContext
    + 'You are a pharmacist explaining a medication to a patient in clear, simple, friendly language. Describe ' + drugName + '.\n\n'
    + 'Return ONLY raw valid JSON (no markdown, no backticks, start with { end with }).\n'
    + 'Structure:\n'
    + '{"generic_name":"<generic name>","brand_names":["<brand1>","<brand2>"],"drug_class":"<drug class>",'
    + '"purpose":"<what it is used for — 2-3 sentences, plain language>","how_it_works":"<mechanism explained simply — 2-3 sentences a patient can understand>",'
    + '"common_side_effects":"<common side effects in plain language — formatted as a readable paragraph or short list>",'
    + '"warnings":"<important warnings and precautions in simple language>",'
    + '"typical_dosing":"<typical dosing information in simple language>"}\n\n'
    + 'Use language a patient can understand. Avoid clinical jargon. Be warm and helpful.';
  try {
    const raw = await callClaude(apiKey, prompt, 1500, language);
    const parsed = tryParseJSON(raw);
    if (!parsed) return res.status(502).json({ error: 'Failed to parse AI response' });
    writeFileCache(drugInfoCacheDir, slug, parsed);
    res.json({ ...parsed, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/pill-ocr', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!k) return res.status(401).json({ error: 'No API key' });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image' });
  const base64 = image.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{
          role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'This is a photo of a pill or tablet. Identify: 1) Any text, numbers, or letters imprinted on it, 2) Its color(s), 3) Its approximate shape. Reply ONLY with raw JSON, no markdown: {"imprint":"<imprint text or empty string>","color":"<primary color>","shape":"<shape>"}' }
          ]
        }]
      })
    });
    const d = await r.json();
    const raw = ((d.content && d.content[0] && d.content[0].text) || '{}').trim();
    const parsed = tryParseJSON(raw);
    res.json(parsed || { imprint: '', color: '', shape: '' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/drug-ifu', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'No API key' });
    const { drugName, dosage, form, condition, language = 'en' } = req.body;
    if (!drugName) return res.status(400).json({ error: 'drugName required' });

    const ifuCacheDir = language === 'es' ? IFU_ES_CACHE_DIR : IFU_CACHE_DIR;
    const slug = slugify(drugName) + (form ? '-' + slugify(form) : '') + (condition ? '-for-' + slugify(condition) : '');
    const cached = readFileCache(ifuCacheDir, slug);
    if (cached) return res.json({ ...cached, cached: true });

    const langInstr = language === 'es'
      ? ' Respond entirely in Spanish (español), using clear, patient-friendly language appropriate for Spanish-speaking patients in the United States. Keep drug names in their standard form but write all explanations, instructions, and recommendations in Spanish.'
      : '';
    const userPrompt = `Create patient-friendly Instructions for Use for ${drugName}${dosage ? ' (' + dosage + ')' : ''}${form ? ', ' + form + ' form' : ''}${condition ? ' for ' + condition : ''}. Return a JSON object with exactly these fields: drug_name (string), brand_names (array of strings), what_its_for (string), how_to_take (string), dosing (string), missed_dose (string), storage (string), what_to_avoid (string), when_to_call_doctor (string), when_it_works (string), special_populations (string or null). Use simple patient-friendly language.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: 'You are a clinical pharmacist. Respond with ONLY valid JSON. Do not include any markdown code fences, explanatory text, or commentary before or after the JSON object. Return a single JSON object with patient-friendly instructions for use fields.' + langInstr,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const data = await r.json();
    let raw = ((data.content && data.content[0] && data.content[0].text) || '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = tryParseJSON(raw);
    if (!parsed) {
      console.error('[IFU] Failed to parse AI response:', raw.slice(0, 500));
      return res.status(502).json({ error: 'Could not parse AI response', raw: raw.slice(0, 200) });
    }
    writeFileCache(ifuCacheDir, slug, parsed);
    res.json({ ...parsed, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

console.log('[STARTUP] All routes configured');

app.get('/proactive', (req, res) => { res.sendFile(require('path').join(__dirname, 'proactive', 'index.html')); });
app.post('/api/proactive-analyze', async (req, res) => {
  try {
    const { drugs, prompt } = req.body;
    if (!drugs || drugs.length < 2) return res.status(400).json({ error: 'Need 2+ drugs' });
    const drugDataArr = await Promise.all(drugs.map(fetchDrugData));
    const grounding = buildGroundingContext(drugDataArr);
    const groundedPrompt = grounding + prompt;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: groundedPrompt }] })
    });
    const d = await r.json();
    const raw = d.content?.[0]?.text || '';
    const m = raw.match(/{[\s\S]*}/);
    if (!m) throw new Error('No JSON');
    res.json(JSON.parse(m[0]));
  } catch(e) {
    console.error('[PROACTIVE]', e.message);
    res.status(500).json({ error: e.message });
  }
});
const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[STARTUP] Server listening on port ${port}`);
});

server.on('error', (err) => {
  console.error('[SERVER_ERROR]', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[SIGTERM] Graceful shutdown');
  server.close(() => process.exit(0));
});

// Keep process alive
setInterval(() => {}, 30000);

