/* =============================================================================
   IntractMD™ — AI-Powered Drug Interaction & Polypharmacy Risk Platform
   Copyright © 2026 Resolve Medical, LLC. All rights reserved.
   700 W Saint Clair Ave., Suite 100, Cleveland, OH 44113
   tom@resolve.med | 216-509-0672 | intractmd.com

   PATENT PENDING — USPTO Provisional Patent Application Filed June 2026
   Covering: CPRS Algorithm, Multi-Source FDA Fusion Pipeline, Unified
   Drug-Supplement-Food Analysis, PHI-Minimized Batch API, Proactive
   Warning Engine, and Bilingual Language-Invariant Risk Scoring.

   PROPRIETARY AND CONFIDENTIAL
   This software and its source code constitute valuable trade secrets and
   proprietary intellectual property of Resolve Medical, LLC. Unauthorized
   copying, modification, distribution, reverse engineering, or use of this
   software, in whole or in part, is strictly prohibited without prior
   written authorization from Resolve Medical, LLC.

   The pre-computed drug interaction database (Pair Cache) contained herein
   is protected as a proprietary compilation under U.S. copyright law and
   as a trade secret under applicable state and federal law.
   =============================================================================
*/

console.log('[STARTUP] Process started');

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();

app.get('/healthz', (req, res) => res.status(200).send('OK'));

const basicAuth = require('express-basic-auth');

if (process.env.SITE_LOCKED === 'true') {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/healthz') return next();
    basicAuth({
      users: { [process.env.SITE_USER]: process.env.SITE_PASSWORD },
      challenge: true,
    })(req, res, next);
  });
}

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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
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
const PROACTIVE_CACHE_DIR = path.join(__dirname, 'cache', 'proactive-profiles');
const proactiveProfileCache = new Map();
console.log('[PROACTIVE CACHE] Dir:', PROACTIVE_CACHE_DIR, 'exists:', require('fs').existsSync(PROACTIVE_CACHE_DIR)); // in-memory cache

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

// ── DRUG PROFILE CACHE ────────────────────────────────────────────────────
const DRUG_PROFILE_DIR = require('path').join(__dirname, 'cache', 'drug-profiles');
function loadDrugProfile(drugName) {
  try {
    const fname = drugName.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') + '.json';
    const file = require('path').join(DRUG_PROFILE_DIR, fname);
    if (require('fs').existsSync(file)) {
      const p = JSON.parse(require('fs').readFileSync(file, 'utf8'));
      p.sources = p.sources || ['ProfileCache'];
      return p;
    }
  } catch(e) {}
  return null;
}

async function safeFetch(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } }); }
  finally { clearTimeout(t); }
}

async function fetchDrugData(drugName) {
  // Check profile cache first — skips all FDA API calls
  const profileHit = loadDrugProfile(drugName);
  if (profileHit) return profileHit;

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
  const isLarge = drugDataArr.length >= 5;
  const lines = [];
  for (const d of drugDataArr) {
    const parts = [];
    if (d.drugClass) parts.push(`Class: ${d.drugClass}`);
    if (d.warnings) parts.push(`FDA Warnings: ${d.warnings.slice(0, isLarge ? 200 : 9999)}`);
    if (d.interactions) parts.push(`FDA Drug Interactions: ${d.interactions.slice(0, isLarge ? 200 : 9999)}`);
    if (d.contraindications) parts.push(`FDA Contraindications: ${d.contraindications.slice(0, isLarge ? 200 : 9999)}`);
    if (d.rxnormInteractions.length) parts.push(`RxNorm documented interactions: ${d.rxnormInteractions.slice(0, 3).join(' | ')}`);
    if (parts.length) lines.push(`${d.name}: ${parts.join('. ')}`);
  }
  if (!lines.length) return '';
  const fullText = lines.join('\n');
  const cappedText = isLarge && fullText.length > 4000 ? fullText.slice(0, 4000) + '\n[Truncated]' : fullText;
  return `REAL-TIME FDA AND RXNORM DATA (use as primary grounding source):\n${cappedText}\n\n`;
}

async function callClaude(k, prompt, maxTok = 1500, lang = 'en') {
  const langInstr = lang === 'es'
    ? ' Respond entirely in Spanish (español), using clear, patient-friendly language appropriate for Spanish-speaking patients in the United States. Keep drug names in their standard form (generic or brand as provided) but explain all mechanisms, effects, instructions, and recommendations in Spanish.'
    : '';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
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

  // Fast path: skip FDA calls if all DD pairs cached and no supplements/foods to analyze
  const allDDCached = missingDDPairs.length === 0 && supplements.length === 0 && foods.length === 0;
  const drugDataArr = allDDCached
    ? drugs.map(name => loadDrugProfile(name) || { name, rxcui: null, drugClass: null, warnings: null, interactions: null, contraindications: null, rxnormInteractions: [], sources: ['PairCache'] })
    : await Promise.all(drugs.map(fetchDrugData));
  if (allDDCached) console.log('[FASTPATH] All DD pairs cached — skipping FDA API calls');

  // ── ULTRA FAST PATH: Build response entirely from cache (no Claude call) ──
  if (allDDCached && !supplements.length && !foods.length) {
    const interactions = cachedDDInteractions.map(p => ({
      drugs: p.drugA + ' + ' + p.drugB,
      severity: p.severity,
      mechanism: p.mechanism || '',
      action: p.action || 'Consult your pharmacist or physician.'
    }));

    // Compute overall risk from dimensions
    const maxBleeding = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Bleeding Risk'] || 0));
    const maxCardiac  = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Cardiac Risk'] || 0));
    const maxSerotonin= Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Serotonin Risk'] || 0));
    const maxNTI      = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['NTI Conflict'] || 0));
    const maxCNS      = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['CNS Risk'] || 0));
    const maxCYP      = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['CYP450 Risk'] || 0));
    const maxRenal    = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Renal/Hepatic'] || 0));
    const maxPD       = Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Pharmacodynamic'] || 0));

    const weightedScore = Math.round((maxBleeding*0.25 + maxCardiac*0.15 + maxSerotonin*0.15 +
      maxNTI*0.15 + maxCNS*0.10 + maxCYP*0.08 + maxRenal*0.07 + maxPD*0.05));

    // Regimen-level risk must never rate below its most severe individual
    // interaction — a low dimension-weight (e.g. CYP450 at 8%) can otherwise
    // dilute a High/Critical-severity pair down to a misleadingly low score.
    const severityFloor = { Critical: 80, High: 60, Moderate: 40, Low: 20, Minimal: 0 };
    const maxSeverityScore = Math.max(0, ...cachedDDInteractions.map(p => severityFloor[p.severity] || 0));
    const riskScore = Math.max(weightedScore, maxSeverityScore);

    const overallRisk = riskScore >= 80 ? 'CRITICAL' : riskScore >= 60 ? 'HIGH' :
      riskScore >= 40 ? 'MODERATE' : riskScore >= 20 ? 'LOW' : 'MINIMAL';

    const criticalPairs = cachedDDInteractions.filter(p => p.severity === 'Critical' || p.severity === 'High');
    const topConcern = criticalPairs.length > 0
      ? criticalPairs[0].drugA + ' + ' + criticalPairs[0].drugB + ': ' + criticalPairs[0].mechanism
      : (interactions.length > 0 ? interactions[0].drugs + ': ' + interactions[0].mechanism : 'Review full interaction list');

    console.log('[CACHE RESPONSE] Returning full response from pair cache — no Claude call needed');
    return res.json({
      overall_risk: overallRisk,
      risk_score: riskScore,
      summary: interactions.length > 0
        ? criticalPairs.length + ' significant interaction(s) identified among ' + drugs.length + ' medications. ' + (criticalPairs[0] ? criticalPairs[0].drugA + ' + ' + criticalPairs[0].drugB + ' carries the highest risk.' : '')
        : 'No significant drug-drug interactions identified among the ' + drugs.length + ' medications in this regimen.',
      known_interactions: interactions,
      predictive_interactions: [],
      polypharmacy_assessment: {
        overall_burden: drugs.length >= 8 ? 'High polypharmacy burden with ' + drugs.length + ' concurrent medications.' : 'Moderate polypharmacy with ' + drugs.length + ' medications.',
        cumulative_risks: 'Bleeding Risk: ' + maxBleeding + ', Cardiac: ' + maxCardiac + ', CNS: ' + maxCNS,
        shared_pathways: 'See individual interaction details above.',
        cascade_risks: 'Monitor for cumulative effects especially with anticoagulants and CNS agents.',
        recommendations: 'Review with pharmacist; monitor for bleeding, CNS depression, and cardiac effects.'
      },
      dimensions: {
        'Bleeding Risk': maxBleeding, 'Cardiac Risk': maxCardiac, 'Serotonin Risk': maxSerotonin,
        'NTI Conflict': maxNTI, 'CNS Risk': maxCNS, 'CYP450 Risk': maxCYP,
        'Renal/Hepatic': maxRenal, 'Pharmacodynamic': maxPD
      },
      key_concern: topConcern,
      contraindicated: cachedDDInteractions.some(p => p.severity === 'Critical'),
      executive_summary: overallRisk + ' risk regimen with ' + interactions.length + ' drug interactions identified from ' + drugs.length + ' medications. ' + (criticalPairs.length > 0 ? criticalPairs.length + ' high-priority interaction(s) require attention.' : 'No critical interactions identified.'),
      data_sources: ['PreComputedCache', 'RxNorm', 'OpenFDA']
    });
  }

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

  const cachedDDSummary = cachedDDInteractions.length > 0 ? 'KNOWN DD INTERACTIONS FROM DATABASE (do NOT re-derive, include as-is in known_interactions):\n' + cachedDDInteractions.map(p => p.drugA + '+' + p.drugB + ': ' + p.severity + ' — ' + p.mechanism).join('\n') + '\n\n' : '';

  // Use simplified schema for large regimens to stay within token limits
  const isLargeRegimen = drugs.length >= 5;
  const simpleSchema = '{"overall_risk":"HIGH|MODERATE|LOW|MINIMAL","risk_score":0,"summary":"2 sentences max","known_interactions":[{"drugs":"A+B","severity":"major|moderate|minor","mechanism":"1 sentence","action":"1 sentence"}],"key_concern":"1 sentence","contraindicated":false,"executive_summary":"2 sentences","data_sources":["RxNorm","OpenFDA"]}';
  const fullSchema = '{"overall_risk":"HIGH|MODERATE|LOW|MINIMAL","risk_score":0,"summary":"2 sentences","known_interactions":[{"drugs":"A+B","type":"drug-drug|drug-supplement|supplement-supplement","severity":"major|moderate|minor","mechanism":"","clinical_effect":"","evidence":"","monitoring":"","action":"","patient_specific":""}],' + (includeFoodInMain ? foodSchema + ',' : '') + '"predictive_interactions":[{"drugs":"A+B","type":"drug-drug|drug-supplement|supplement-supplement","severity":"major|moderate|minor","basis":"","clinical_effect":"","probability":"high|moderate|low","monitoring":"","action":"","validation_sources":["RxNorm","FDA label","pharmacological mechanism"],"confidence_basis":"1 sentence mechanistic basis"}],"polypharmacy_assessment":{"overall_burden":"1 sentence","cumulative_risks":"1 sentence","shared_pathways":"1 sentence","cascade_risks":"1 sentence","recommendations":"1 sentence"},"key_concern":"1 sentence","contraindicated":false,"executive_summary":"3 sentences","data_sources":["RxNorm","OpenFDA","MedlinePlus"]}';
  const jsonSchema = isLargeRegimen ? simpleSchema : fullSchema;

  const mainPrompt = `${groundingContext}${cachedDDSummary}Drug interaction analysis. Keep ALL text fields to 2 sentences max.\n\nDRUGS:${drugs.length ? drugs.join(',') : 'None'} SUPPLEMENTS:${supplements.length ? supplements.join(',') : 'None'}${includeFoodInMain ? ' FOODS:' + foods.join(',') : ''}\nPATIENT:${pt}\nPAIRS DD(${ddP.length}):${ddP.join('|') || 'none'} DS(${dsP.length}):${dsP.join('|') || 'none'} SS(${ssP.length}):${ssP.join('|') || 'none'}${includeFoodInMain ? ' DF(' + dfP.length + '):' + dfP.join('|') : ''}${includeFoodInMain && sfP.length ? ' SF(' + sfP.length + '):' + sfP.join('|') : ''}\n${SUPP_REF}${includeFoodInMain ? '\n' + FOOD_REF : ''}\n\nReturn ONLY this raw JSON (no markdown, begin with {, end with }):\n${jsonSchema}`;

  const foodOnlyPrompt = `Food interaction analysis ONLY. Keep ALL fields to 1 sentence.\n\nDRUGS:${drugs.join(',')} SUPPLEMENTS:${supplements.length ? supplements.join(',') : 'None'} FOODS:${foods.join(',')}\nPATIENT:${pt}\nDF(${dfP.length}):${dfP.join('|')} SF(${sfP.length}):${sfP.length ? sfP.join('|') : 'none'}\n${FOOD_REF}\nHIGH-PRIORITY: grapefruit+statins/CCBs/immunosuppressants, alcohol+CNS-depressants/warfarin/metronidazole, VitK+warfarin, tyramine+MAOIs, dairy+fluoroquinolones/tetracyclines.\n\nReturn ONLY this raw JSON (no markdown, begin with {, end with }):\n{${foodSchema}}`;

  try {
    let raw, rawF = null;
    if (splitCalls && foods.length > 0) {
      [raw, rawF] = await Promise.all([callClaude(k, mainPrompt, 1500, language), callClaude(k, foodOnlyPrompt, 1000, language)]);
    } else {
      raw = await callClaude(k, mainPrompt, drugs.length >= 8 ? 6000 : drugs.length >= 5 ? 4000 : 3000, language);
    }

    let result = tryParseJSON(raw);
    if (!result) {
      const retryPrompt = 'IMPORTANT: Return raw JSON only, starting with { ending with }. No markdown, no backticks.\n\nDrug interactions for: ' + drugs.join(',') + (supplements.length ? ', supps:' + supplements.join(',') : '') + (includeFoodInMain && foods.length ? ', foods:' + foods.join(',') : '') + '.\n\n' + mainPrompt;
      raw = await callClaude(k, retryPrompt, drugs.length >= 8 ? 6000 : drugs.length >= 5 ? 4000 : 3000, language);
      result = tryParseJSON(raw);
      if (!result) {
        return res.status(500).json({ error: 'AI response could not be parsed after two attempts. Please try again.' });
      }
    }

    if (splitCalls && foods.length > 0) {
      let foodResult = tryParseJSON(rawF);
      if (!foodResult) {
        const retryF = 'IMPORTANT: Return raw JSON only, starting with { ending with }. No markdown.\n\n' + foodOnlyPrompt;
        rawF = await callClaude(k, retryF, 1000);
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
        model: 'claude-haiku-4-5-20251001',
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



// ── PILL IDENTIFIER ──────────────────────────────────────────────────────
// ── PILL IDENTIFIER (Cache-first + Claude AI fallback) ───────────────────
const PILL_INDEX_PATH = require('path').join(__dirname, 'cache', 'pill-index.json');
let pillIndex = null;

function loadPillIndex() {
  try {
    if (!pillIndex && require('fs').existsSync(PILL_INDEX_PATH)) {
      pillIndex = JSON.parse(require('fs').readFileSync(PILL_INDEX_PATH, 'utf8'));
      console.log('[PILL] Index loaded:', Object.keys(pillIndex).length, 'imprint codes');
    }
  } catch(e) { console.error('[PILL] Index load error:', e.message); }
}
loadPillIndex();

// ── PILL IDENTIFIER (Cache-first + Claude AI fallback) ───────────────────
app.post('/api/pill-identify', async (req, res) => {
  const { shape, color1, color2, imprint, coating, size } = req.body;
  try {
    let matches = [];
    let source = 'none';

    // Step 1: Cache lookup by imprint (instant, <1ms)
    if (imprint && pillIndex) {
      const key = imprint.toString().toUpperCase().replace(/\s+/g, '');
      let cacheHits = pillIndex[key] || [];
      if (shape && shape !== 'Any') {
        const filtered = cacheHits.filter(m => !m.shape || m.shape.toLowerCase() === shape.toLowerCase());
        if (filtered.length) cacheHits = filtered;
      }
      if (color1 && color1 !== 'Any') {
        const filtered = cacheHits.filter(m => !m.colors || m.colors.some(c => c.toLowerCase().includes(color1.toLowerCase())));
        if (filtered.length) cacheHits = filtered;
      }
      if (cacheHits.length) {
        matches = cacheHits.map(function(m) {
          return {
            drug_name: m.drug_name,
            generic_name: m.generic_name,
            strength: m.strength,
            confidence: 'high',
            note: [m.shape, (m.colors||[]).join('/'), m.coating].filter(Boolean).join(', '),
            imageUrl: m.imageUrl || '',
            labeler: m.manufacturer || '',
            drug_class: m.drug_class || ''
          };
        });
        source = 'cache';
      }
    }

    // Step 2: Claude AI fallback for cache misses
    if (!matches.length) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const parts = [];
        if (imprint) parts.push('Imprint code: ' + imprint);
        if (shape && shape !== 'Any') parts.push('Shape: ' + shape);
        if (color1 && color1 !== 'Any') parts.push('Primary color: ' + color1);
        if (color2 && color2 !== 'Any') parts.push('Secondary color: ' + color2);
        if (size) parts.push('Size: approximately ' + size + 'mm');
        if (coating && coating !== 'Any') parts.push('Coating: ' + coating);
        if (parts.length) {
          const promptText = 'You are a pharmaceutical pill identification expert. Identify pills matching: ' + parts.join(', ') + '. If the imprint is a well-known code (L484=Tylenol, M357=Hydrocodone, etc.), identify it confidently. Return ONLY valid JSON no markdown: {"matches":[{"drug_name":"<brand>","generic_name":"<generic>","strength":"<dose>","confidence":"<high|medium|low>","note":"<description>","imageUrl":"","labeler":"<manufacturer>"}]} Up to 5 matches.';
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 12000);
          try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              signal: ctrl.signal,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 800, messages: [{ role: 'user', content: promptText }] })
            });
            const data = await r.json();
            clearTimeout(t);
            if (data.content && data.content[0]) {
              const raw = data.content[0].text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
              const m = raw.match(/{[\s\S]*}/);
              if (m) { const parsed = JSON.parse(m[0]); if (parsed.matches) { matches = parsed.matches; source = 'ai'; } }
            }
          } catch(ae) { clearTimeout(t); console.error('[PILL] AI error:', ae.message); }
        }
      }
    }
    res.json({ matches, source });
  } catch(e) {
    console.error('[PILL] Error:', e.message);
    res.json({ matches: [], error: e.message });
  }
});



// ── INTRACTMD HELP CHATBOT ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, language } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) return res.status(401).json({ error: 'No API key' });

    const langNote = language === 'es'
      ? 'IMPORTANT: The user is using the Spanish version of the app. Respond ENTIRELY in Spanish. Keep drug names in English/generic form.'
      : 'Respond in English.';

    const SYSTEM = `You are the IntractMD Help Assistant — a friendly guide for the IntractMD medication safety app by Resolve Medical. Answer questions ONLY about how to use IntractMD and what results mean. ${langNote}

You can answer questions about:
- Drug Interaction Score (0-20 Minimal, 21-40 Low, 41-60 Moderate, 61-80 High, 81-100 Critical)
- Risk dimensions: Bleeding, Cardiac, CNS/Sedation, Serotonin, Renal, Hepatic, QT Interval, Drug Level
- What Critical/High/Moderate/Low severity means
- Supplements and foods to avoid (proactive engine)
- CONFIRMED/COMPUTED/PREDICTIVE confidence tiers
- How to add medications (type, voice, scan)
- Pill identifier (752 drugs, 2571 imprint codes)
- Privacy (no PHI stored, no account required, free)
- App limitations

RULES:
1. Never give personalized medical advice about specific combinations or doses
2. Always recommend consulting a pharmacist or physician for medical decisions
3. Stay on topic — if asked something unrelated say: "I can only help with questions about the IntractMD app."
4. Keep answers to 2-4 sentences for simple questions, up to 8 for complex ones
5. Use plain English — avoid jargon unless explaining a term the user mentioned
6. Be warm and reassuring — users may be anxious about their medications

IntractMD is made by Resolve Medical LLC, Cleveland OH. Contact: info@resolve.med / 216-509-0672. It is a clinical decision support tool, NOT a substitute for professional medical advice.`;

    const messages = [
      ...(history || []).slice(-8),
      { role: 'user', content: message }
    ];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: SYSTEM, messages })
    });
    const d = await r.json();
    const reply = d.content?.[0]?.text || 'Sorry, I could not generate a response.';
    res.json({ reply });
  } catch(e) {
    console.error('[CHAT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Computes PCPRS/risk_tier/dimensions from cached DD pairs — shared by the
// ultra-fast cache path and the slow-path timeout fallback below.
function calcPcprsFromDD(cachedDDInteractions) {
  const dims = {
    'Bleeding Risk':  Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Bleeding Risk'] || 0)),
    'Cardiac Risk':   Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Cardiac Risk'] || 0)),
    'Serotonin Risk': Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Serotonin Risk'] || 0)),
    'CNS Risk':       Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['CNS Risk'] || 0)),
    'CYP450 Risk':    Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['CYP450 Risk'] || 0)),
    'Pharmacodynamic':Math.max(0, ...cachedDDInteractions.map(p => p.dimensions?.['Pharmacodynamic'] || 0)),
  };
  const weightedPcprs = Math.round(
    dims['Bleeding Risk']*0.30 + dims['Cardiac Risk']*0.20 + dims['Serotonin Risk']*0.20 +
    dims['CNS Risk']*0.15 + dims['CYP450 Risk']*0.10 + dims['Pharmacodynamic']*0.05
  );

  // Same floor as calcPcprsFromDD's analyze-endpoint counterpart: a regimen's
  // PCPRS must never rate below its most severe individual interaction.
  const severityFloor = { Critical: 80, High: 60, Moderate: 40, Low: 20, Minimal: 0 };
  const maxSeverityScore = Math.max(0, ...cachedDDInteractions.map(p => severityFloor[p.severity] || 0));
  const pcprs = Math.min(100, Math.max(weightedPcprs, maxSeverityScore));

  const risk_tier = pcprs >= 80 ? 'Critical' : pcprs >= 60 ? 'High' :
    pcprs >= 40 ? 'Moderate' : pcprs >= 20 ? 'Low' : 'Minimal';
  return { pcprs, risk_tier, dimensions: dims };
}

app.get('/proactive', (req, res) => { res.sendFile(require('path').join(__dirname, 'proactive', 'index.html')); });
app.post('/api/proactive-analyze', async (req, res) => {
  try {
    const { drugs } = req.body;
    const defaultPrompt = `You are a clinical pharmacologist AI for IntractMD Proactive.

The patient medication regimen is: ${(drugs||[]).join(', ')}.

Perform TWO analyses: (1) drug-drug interactions, (2) supplement and food warnings. Keep ALL text fields (mechanism, action, risk_title, monitoring_notes) to 1 sentence max.

Return ONLY valid JSON:
{"pcprs":<0-100>,"risk_tier":"<Minimal|Low|Moderate|High|Critical>","risk_title":"<1 sentence>","drug_interactions":[{"drug_a":"<drug>","drug_b":"<drug>","severity":"<Critical|High|Moderate>","mechanism":"<1 sentence>","action":"<1 sentence>"}],"warnings":[{"drug":"<drug>","interacts_with":"<supplement or food>","category":"<supplement|food>","severity":"<Critical|High|Moderate>","mechanism":"<1 sentence>","action":"<1 sentence>"}],"avoid_supplements":["<name>"],"caution_supplements":["<name>"],"avoid_foods":["<name>"],"monitoring_notes":"<1 sentence>"}`;
    const prompt = req.body.prompt || defaultPrompt;
    if (!drugs || drugs.length < 1) return res.status(400).json({ error: 'Need at least 1 drug' });

    // ── FAST PATH: Check proactive profile cache first ──────────────────────
    let profileLookup;
    try { profileLookup = mergeProactiveProfiles(drugs); }
    catch(cacheErr) { console.error('[PROACTIVE CACHE ERROR]', cacheErr.message); profileLookup = { hit: false, missing: drugs }; }
    console.log('[PROACTIVE LOOKUP] hit:', profileLookup.hit, 'missing:', JSON.stringify(profileLookup.missing||[]));
    if (profileLookup.hit) {
      console.log('[PROACTIVE] Cache hit for all drugs — skipping AI call');
      // Also inject drug-drug pairs from pair cache
      if (drugs.length > 1) {
        const ddLookup = lookupPairsFromCache(drugs);
        const ddInteractions = ddLookup.found.filter(p => p.hasInteraction);
        profileLookup.result.drug_interactions = ddInteractions.map(p => ({
          drug_a: p.drugA, drug_b: p.drugB, severity: p.severity,
          mechanism: p.mechanism, action: 'Consult your pharmacist or physician.'
        }));
      }
      return res.json(profileLookup.result);
    }
    console.log('[PROACTIVE] Cache miss for:', profileLookup.missing.join(', '), '— falling back to AI');

    // ── SLOW PATH: AI generation for uncached drugs ──────────────────────────
    // Pair cache lookup for drug-drug interactions
    const pairCacheLookup = drugs.length > 1 ? lookupPairsFromCache(drugs) : { found: [], missing: [] };
    const cachedDDPairs = pairCacheLookup.found;
    const cachedDDInteractions = cachedDDPairs.filter(p => p.hasInteraction);
    const cachedSummary = cachedDDInteractions.length > 0
      ? 'KNOWN DRUG-DRUG INTERACTIONS FROM DATABASE (include as drug_interactions in response):\n' +
        cachedDDInteractions.map(p => p.drugA + '+' + p.drugB + ': ' + p.severity + ' — ' + p.mechanism).join('\n') + '\n\n'
      : '';
    console.log('[PROACTIVE CACHE] hits:' + cachedDDPairs.length + ' misses:' + pairCacheLookup.missing.length);

    // Skip FDA calls if all pairs cached and building grounding only for supplements/foods
    const allCached = pairCacheLookup.missing.length === 0 && drugs.length > 1;
    const drugDataArr = allCached
      ? drugs.map(name => ({ name, rxcui: null, drugClass: null, warnings: null, interactions: null, contraindications: null, rxnormInteractions: [], sources: ['PairCache'] }))
      : await Promise.all(drugs.map(fetchDrugData));
    if (allCached) console.log('[PROACTIVE FASTPATH] Skipping FDA calls — all pairs cached');

  // ── ULTRA FAST PATH: Build proactive response from pair cache (no Claude) ──
  if (allCached && drugs.length >= 2) {
    const ddInteractions = cachedDDInteractions.map(p => ({
      drug_a: p.drugA, drug_b: p.drugB, severity: p.severity,
      mechanism: p.mechanism || '', action: p.action || 'Consult your pharmacist or physician.'
    }));

    const { pcprs, risk_tier, dimensions } = calcPcprsFromDD(cachedDDInteractions);
    const criticals = cachedDDInteractions.filter(p => p.severity === 'Critical' || p.severity === 'High');

    // Build supplement warnings from known drug profiles
    const knownSupplWarnings = {
      'warfarin':     [{ interacts_with:"Fish Oil", severity:'High', mechanism:'Additive antiplatelet effect increases bleeding risk.', action:'Avoid Fish Oil while taking Warfarin.' },
                       { interacts_with:"Vitamin E", severity:'Moderate', mechanism:'May potentiate anticoagulant effect.', action:'Limit Vitamin E supplementation.' },
                       { interacts_with:"Ginkgo Biloba", severity:'High', mechanism:'Antiplatelet properties increase hemorrhagic risk.', action:'Avoid Ginkgo Biloba.' },
                       { interacts_with:"St. John's Wort", severity:'Critical', mechanism:'CYP2C9 inducer significantly reduces warfarin levels.', action:"Do not take St. John's Wort." }],
      'fluoxetine':   [{ interacts_with:"St. John's Wort", severity:'Critical', mechanism:'Serotonin syndrome risk.', action:"Avoid St. John's Wort." }],
      'clopidogrel':  [{ interacts_with:"Fish Oil", severity:'Moderate', mechanism:'Additive antiplatelet effect.', action:'Discuss with physician before taking Fish Oil.' },
                       { interacts_with:"Turmeric", severity:'Moderate', mechanism:'Antiplatelet properties may increase bleeding risk.', action:'Use caution with Turmeric supplements.' },
                       { interacts_with:"Garlic", severity:'Moderate', mechanism:'Antiplatelet effect may be additive.', action:'Discuss Garlic supplements with physician.' }],
      'methotrexate':  [{ interacts_with:"Echinacea", severity:'Moderate', mechanism:'May stimulate immune system counteracting methotrexate.', action:'Avoid Echinacea while on Methotrexate.' },
                        { interacts_with:"Cats Claw", severity:'Moderate', mechanism:'Immunostimulant may interfere with therapy.', action:'Avoid Cats Claw.' }],
      'levothyroxine': [{ interacts_with:"Biotin", severity:'Moderate', mechanism:'High-dose biotin may interfere with thyroid lab tests.', action:'Stop Biotin 2 days before thyroid tests.' },
                        { interacts_with:"Iron", severity:'High', mechanism:'Iron chelates levothyroxine reducing absorption.', action:'Separate Iron and Levothyroxine by at least 4 hours.' },
                        { interacts_with:"Magnesium", severity:'Moderate', mechanism:'May reduce levothyroxine absorption.', action:'Separate Magnesium and Levothyroxine by 4 hours.' },
                        { interacts_with:"Calcium", severity:'High', mechanism:'Calcium carbonate significantly reduces levothyroxine absorption.', action:'Take Levothyroxine 4 hours apart from Calcium.' }],
      'prednisone':    [{ interacts_with:"Licorice Root", severity:'High', mechanism:'May potentiate corticosteroid effects.', action:'Avoid Licorice Root while on Prednisone.' },
                        { interacts_with:"DHEA", severity:'Moderate', mechanism:'Hormonal interaction may alter effects.', action:'Discuss DHEA with physician.' },
                        { interacts_with:"Ginseng", severity:'Moderate', mechanism:'May affect immune modulation.', action:'Use caution with Ginseng.' }],
      'furosemide':    [{ interacts_with:"Hawthorn", severity:'Moderate', mechanism:'Additive hypotensive and diuretic effects.', action:'Monitor blood pressure carefully with Hawthorn.' },
                        { interacts_with:"Potassium", severity:'Low', mechanism:'Furosemide causes potassium loss — supplementation may be appropriate.', action:'Discuss Potassium supplementation with physician.' }],
      'sertraline':    [{ interacts_with:"St. John's Wort", severity:'Critical', mechanism:'Combined serotonergic effect may cause serotonin syndrome.', action:"Do not take St. John's Wort." },
                        { interacts_with:"SAMe", severity:'High', mechanism:'SAMe has serotonergic properties — combination risk.', action:'Avoid SAMe with Sertraline.' },
                        { interacts_with:"5-HTP", severity:'High', mechanism:'Serotonin precursor increases serotonin syndrome risk.', action:'Avoid 5-HTP with Sertraline.' }],
      'simvastatin':   [{ interacts_with:"Red Yeast Rice", severity:'High', mechanism:'Additive HMG-CoA reductase inhibition increases myopathy risk.', action:'Avoid Red Yeast Rice.' },
                        { interacts_with:"CoQ10", severity:'Low', mechanism:'Statins deplete CoQ10 — supplementation may be beneficial.', action:'CoQ10 supplementation is generally considered safe.' },
                        { interacts_with:"Niacin", severity:'High', mechanism:'Combined risk of myopathy and hepatotoxicity.', action:'Avoid high-dose Niacin with Simvastatin.' }],
      'aspirin':      [{ interacts_with:"Fish Oil", severity:'Moderate', mechanism:'Additive antiplatelet effect increases bleeding risk.', action:'Use caution with Fish Oil.' }],
      'metformin':    [{ interacts_with:"Chromium", severity:'Moderate', mechanism:'May enhance hypoglycemic effect.', action:'Monitor blood sugar carefully.' }],
      'lisinopril':   [{ interacts_with:"Potassium", severity:'High', mechanism:'ACE inhibitors increase potassium retention.', action:'Avoid potassium supplements.' }],
      'digoxin':      [{ interacts_with:"St. John's Wort", severity:'Critical', mechanism:'P-gp inducer reduces digoxin levels significantly.', action:"Do not take St. John's Wort." }],
      'metoprolol':   [{ interacts_with:"CoQ10", severity:'Low', mechanism:'Possible interaction with cardiac beta receptors.', action:'Inform physician if taking CoQ10.' }],
      'atorvastatin': [{ interacts_with:"Red Yeast Rice", severity:'High', mechanism:'Additive HMG-CoA reductase inhibition increases myopathy risk.', action:'Avoid Red Yeast Rice.' }],
    };

    const warnings = [];
    const avoid_supplements = new Set();
    const caution_supplements = new Set();
    const avoid_foods = [];

    drugs.forEach(drug => {
      const key = drug.toLowerCase();
      const supps = knownSupplWarnings[key] || [];
      supps.forEach(w => {
        warnings.push({ drug, ...w, category: 'supplement' });
        if (w.severity === 'Critical' || w.severity === 'High') avoid_supplements.add(w.interacts_with);
        else caution_supplements.add(w.interacts_with);
      });
    });

    // Add grapefruit warning for statins/CCBs
    const grapefruitDrugs = ['atorvastatin','simvastatin','lovastatin','amlodipine','nifedipine','diltiazem','verapamil'];
    const hasGrapefruitDrug = drugs.some(d => grapefruitDrugs.includes(d.toLowerCase()));
    if (hasGrapefruitDrug) {
      avoid_foods.push('Grapefruit and grapefruit juice');
      warnings.push({ drug: drugs.find(d => grapefruitDrugs.includes(d.toLowerCase())), interacts_with: 'Grapefruit juice', category: 'food', severity: 'High', mechanism: 'CYP3A4 inhibition increases drug levels.', action: 'Avoid grapefruit and grapefruit juice.' });
    }

    console.log('[PROACTIVE CACHE RESPONSE] Returning from pair cache — no Claude call');
    return res.json({
      pcprs,
      risk_tier,
      risk_title: criticals.length > 0
        ? criticals.length + ' significant drug interaction(s) identified — review with pharmacist'
        : 'Drug regimen analyzed — ' + ddInteractions.length + ' interaction(s) found',
      drug_interactions: ddInteractions,
      warnings,
      avoid_supplements: [...avoid_supplements],
      caution_supplements: [...caution_supplements],
      avoid_foods,
      monitoring_notes: pcprs >= 60
        ? 'High-risk regimen. Regular monitoring recommended. Consult pharmacist before adding any supplements.'
        : 'Moderate monitoring recommended. Discuss any new supplements with your pharmacist.',
      dimensions
    });
  }

    const grounding = buildGroundingContext(drugDataArr);
    const groundedPrompt = grounding + cachedSummary + prompt;

    // Falls back to a cache-derived response (drug-drug data only) if the AI
    // call times out or returns unparseable JSON, so large regimens never hang
    // past the client's timeout with nothing to show.
    const buildProactiveFallback = () => {
      const { pcprs, risk_tier, dimensions } = calcPcprsFromDD(cachedDDInteractions);
      return {
        pcprs, risk_tier,
        risk_title: risk_tier + ' risk based on known drug-drug interactions (supplement/food analysis unavailable — please retry).',
        drug_interactions: cachedDDInteractions.map(p => ({
          drug_a: p.drugA, drug_b: p.drugB, severity: p.severity,
          mechanism: p.mechanism || '', action: p.action || 'Consult your pharmacist or physician.'
        })),
        warnings: [],
        avoid_supplements: [],
        caution_supplements: [],
        avoid_foods: [],
        monitoring_notes: 'Full supplement/food analysis is taking longer than expected — please retry shortly for complete results.',
        dimensions,
        partial: true
      };
    };

    let raw;
    try {
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: (drugs||[]).length >= 10 ? 5000 : 3000, messages: [{ role: 'user', content: groundedPrompt }] })
        });
        const d = await r.json();
        raw = d.content?.[0]?.text || '';
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (fetchErr) {
      console.error('[PROACTIVE] AI call failed/timed out:', fetchErr.message);
      return res.json(buildProactiveFallback());
    }

    const clean = raw.replace(/```json[\s]*/g,'').replace(/```[\s]*/g,'').trim();
    const m = clean.match(/{[\s\S]*}/);
    if (!m) {
      console.error('[PROACTIVE] No JSON:', raw.slice(0,200));
      return res.json(buildProactiveFallback());
    }
    try {
      const parsed = JSON.parse(m[0]);
      try {
        extractProactiveProfiles(drugs, profileLookup.missing, parsed.warnings)
          .forEach(profile => writeProactiveProfile(profile.drug, profile));
      } catch (cacheWriteErr) {
        console.error('[PROACTIVE CACHE WRITE]', cacheWriteErr.message);
      }
      res.json(parsed);
    } catch (parseErr) {
      console.error('[PROACTIVE] JSON parse failed:', parseErr.message);
      res.json(buildProactiveFallback());
    }
  } catch(e) {
    console.error('[PROACTIVE]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── PROACTIVE PROFILE CACHE ───────────────────────────────────────────────────

function slugDrug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function loadProactiveProfile(drugName) {
  const key = slugDrug(drugName);
  if (proactiveProfileCache.has(key)) return proactiveProfileCache.get(key);
  const filePath = path.join(PROACTIVE_CACHE_DIR, key + '.json');
  if (fs.existsSync(filePath)) {
    try {
      const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      proactiveProfileCache.set(key, profile);
      return profile;
    } catch(e) { return null; }
  }
  return null;
}

// Persist an AI-fallback-computed profile so the next request for this drug
// (from a nightly test run or a real user) is a cache hit instead of another
// Claude call — mirrors writePairCache's self-healing behavior for pairs.
function writeProactiveProfile(drugName, profile) {
  try {
    const key = slugDrug(drugName);
    fs.writeFileSync(path.join(PROACTIVE_CACHE_DIR, key + '.json'), JSON.stringify(profile, null, 2), 'utf8');
    proactiveProfileCache.set(key, profile);
  } catch(e) { console.error('[PROACTIVE CACHE WRITE ERROR]', e.message); }
}

// Split the AI's regimen-level warnings back into per-drug profiles for
// each drug that was a cache miss, so writeProactiveProfile can persist them.
function extractProactiveProfiles(drugs, missingDrugs, warnings) {
  const missingLower = new Set((missingDrugs || []).map(d => d.toLowerCase()));
  const isAvoid = sev => sev === 'Critical' || sev === 'High';
  return drugs.filter(d => missingLower.has(d.toLowerCase())).map(drug => {
    const dWarnings = (warnings || []).filter(w => (w.drug || '').toLowerCase() === drug.toLowerCase());
    const toItem = w => ({ name: w.interacts_with, severity: w.severity, mechanism: w.mechanism, action: w.action });
    return {
      drug,
      avoid_supplements: dWarnings.filter(w => w.category === 'supplement' && isAvoid(w.severity)).map(toItem),
      caution_supplements: dWarnings.filter(w => w.category === 'supplement' && !isAvoid(w.severity)).map(toItem),
      avoid_foods: dWarnings.filter(w => w.category === 'food' && isAvoid(w.severity)).map(toItem),
      caution_foods: dWarnings.filter(w => w.category === 'food' && !isAvoid(w.severity)).map(toItem),
    };
  });
}


function calcDimensions(profiles) {
  // Use max-severity per dimension rather than additive accumulation
  // This prevents every query from scoring 100 across all dimensions
  const dims = {'Bleeding Risk':0,'Cardiac Risk':0,'Serotonin Risk':0,'NTI Conflict':0,'CNS Risk':0,'CYP450 Risk':0,'Renal/Hepatic':0,'Pharmacodynamic':0};
  const dimCounts = {'Bleeding Risk':0,'Cardiac Risk':0,'Serotonin Risk':0,'NTI Conflict':0,'CNS Risk':0,'CYP450 Risk':0,'Renal/Hepatic':0,'Pharmacodynamic':0};
  const ntiDrugs = ['warfarin','digoxin','lithium','levothyroxine','phenytoin','cyclosporine','tacrolimus','theophylline','methotrexate'];

  function score(dim, severity) {
    const base = severity==='Critical'?70:severity==='High'?45:severity==='Moderate'?20:8;
    dimCounts[dim]++;
    // First interaction sets base, subsequent ones add diminishing amounts
    const addl = dimCounts[dim]===1 ? base : Math.round(base * 0.15);
    dims[dim] = Math.min(100, dims[dim] + addl);
  }

  profiles.forEach(({profile}) => {
    if (!profile) return;
    const pathways = (profile.key_pathways||[]).map(p=>p.toUpperCase());
    if (pathways.some(p=>p.includes('CYP'))) score('CYP450 Risk','Moderate');
    if (ntiDrugs.some(d=>profile.drug&&profile.drug.toLowerCase().includes(d))) score('NTI Conflict','High');
    [...(profile.avoid_supplements||[]), ...(profile.avoid_foods||[])].forEach(item => {
      const n=(item.name||'').toLowerCase(), m=(item.mechanism||'').toLowerCase();
      const sv=item.severity||'Moderate';
      if(n.includes('ginkgo')||n.includes('garlic')||n.includes('fish oil')||n.includes('vitamin e')||m.includes('bleed')||m.includes('anticoag')||m.includes('platelet')) score('Bleeding Risk',sv);
      if(n.includes("st. john")||n.includes('5-htp')||n.includes('sam-e')||m.includes('serotonin')) score('Serotonin Risk',sv);
      if(m.includes('cardiac')||m.includes(' qt ')||m.includes('arrhythmia')) score('Cardiac Risk',sv);
      if(m.includes('sedati')||m.includes('cns depress')||m.includes('drowsi')) score('CNS Risk',sv);
      if(m.includes('renal')||m.includes('kidney')||m.includes('hepat')||m.includes('liver')) score('Renal/Hepatic',sv);
      if(m.includes('cyp')||m.includes('enzyme inhibit')||m.includes('enzyme induc')) score('CYP450 Risk',sv);
      if(m.includes('blood pressure')||m.includes('glucose')||m.includes('absorption')||m.includes('additive')) score('Pharmacodynamic',sv);
    });
  });
  return dims;
}

function mergeProactiveProfiles(drugs) {
  const profiles = drugs.map(d => ({ drug: d, profile: loadProactiveProfile(d) }));
  const missing = profiles.filter(p => !p.profile).map(p => p.drug);
  const found = profiles.filter(p => p.profile);

  if (missing.length > 0) return { hit: false, missing };

  // Merge all profiles into unified response
  const avoidSupplements = [], cautionSupplements = [], avoidFoods = [], cautionFoods = [];
  const seen = new Set();

  // Filter out non-purchasable medical items and downgrade food severity
  const excludeTerms = ['contrast dye','contrast media','iodinated','radioactive',
    'general anesthesia','intravenous','iv fluid','blood transfusion','dialysis',
    'intraoperative','perioperative','ct scan','mri contrast','x-ray dye'];
  const isExcluded = name => excludeTerms.some(t => (name||'').toLowerCase().includes(t));
  const foodSev = sev => sev==='Critical'?'High':sev==='High'?'Moderate':'Low';

  // Supplements over-classified as Critical by AI — downgrade to High
  // These are real interactions but not acutely life-threatening for a patient-education tool
  const downgradeToHigh = ['potassium','magnesium','calcium','sodium','electrolyte',
    'vitamin k','high-potassium','salt substitute','nonsteroidal','nsaid'];
  const suppSev = (name, sev) => {
    if(sev !== 'Critical') return sev;
    const n = (name||'').toLowerCase();
    return downgradeToHigh.some(t => n.includes(t)) ? 'High' : sev;
  };

  found.forEach(({ drug, profile }) => {
    (profile.avoid_supplements || []).forEach(s => {
      if(isExcluded(s.name)) return;
      const key = s.name.toLowerCase() + drug;
      if (!seen.has(key)) { seen.add(key); avoidSupplements.push({ ...s, drug, severity: suppSev(s.name, s.severity) }); }
    });
    (profile.caution_supplements || []).forEach(s => {
      if(isExcluded(s.name)) return;
      const key = 'c' + s.name.toLowerCase() + drug;
      if (!seen.has(key)) { seen.add(key); cautionSupplements.push({ ...s, drug }); }
    });
    (profile.avoid_foods || []).forEach(f => {
      if(isExcluded(f.name)) return;
      const key = 'f' + f.name.toLowerCase() + drug;
      if (!seen.has(key)) { seen.add(key); avoidFoods.push({ ...f, drug, severity: foodSev(f.severity) }); }
    });
    (profile.caution_foods || []).forEach(f => {
      if(isExcluded(f.name)) return;
      const key = 'cf' + f.name.toLowerCase() + drug;
      if (!seen.has(key)) { seen.add(key); cautionFoods.push({ ...f, drug }); }
    });
  });

  // Calculate PCPRS from severity counts
  const critCount = [...avoidSupplements, ...avoidFoods].filter(x => x.severity === 'Critical').length;
  const highCount = [...avoidSupplements, ...avoidFoods].filter(x => x.severity === 'High').length;
  const modCount = [...avoidSupplements, ...avoidFoods].filter(x => x.severity === 'Moderate').length;
  const worstSev=critCount>0?'Critical':highCount>0?'High':modCount>0?'Moderate':'Low';
  let pcprs;
  if(worstSev==='Critical'){pcprs=Math.min(85,55+Math.min(critCount-1,3)*10);}
  else if(worstSev==='High'){pcprs=Math.min(58,22+Math.min(highCount,6)*4);}
  else if(worstSev==='Moderate'){pcprs=Math.min(28,15+Math.min(modCount,5)*2);}
  else{pcprs=Math.min(14,cautionSupplements.length+cautionFoods.length);}
  const risk_tier=pcprs>=70?"Critical":pcprs>=50?"High":pcprs>=30?"Moderate":pcprs>=10?"Low":"Minimal";

  const warnings = [
    ...avoidSupplements.map(s => ({ drug: s.drug, interacts_with: s.name, category: 'supplement', severity: s.severity, mechanism: s.mechanism, action: s.action })),
    ...avoidFoods.map(f => ({ drug: f.drug, interacts_with: f.name, category: 'food', severity: f.severity, mechanism: f.mechanism, action: f.action })),
    ...cautionSupplements.map(s => ({ drug: s.drug, interacts_with: s.name, category: 'supplement', severity: 'Low', mechanism: s.mechanism, action: s.action })),
    ...cautionFoods.map(f => ({ drug: f.drug, interacts_with: f.name, category: 'food', severity: 'Low', mechanism: f.mechanism, action: f.action })),
  ];

  return {
    hit: true,
    result: {
      pcprs,
      risk_tier,
      risk_title: risk_tier + ' supplement and food interaction burden for this regimen',
      warnings,
      avoid_supplements: [...new Set(avoidSupplements.map(s => s.name))],
      caution_foods: [...new Set([...cautionFoods, ...avoidFoods].map(f => f.name))],
      drug_interactions: [], // populated separately by pair cache
      dimensions: calcDimensions(found),
      ai_summary: 'Pre-computed analysis: ' + (avoidSupplements.length + avoidFoods.length) + ' supplement/food interactions identified across ' + drugs.length + ' medication(s). Review the AVOID list carefully before taking any supplements or consuming flagged foods.',
      from_cache: true
    }
  };
}
// ── END PROACTIVE PROFILE CACHE ───────────────────────────────────────────────

// ── STREAMING ANALYSIS ENDPOINT ─────────────────────────────────────────────
// Uses Server-Sent Events to stream Claude's response token-by-token.
// Frontend receives partial JSON and renders as soon as risk score appears.
app.post('/api/analyze-stream', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!k) return res.status(401).json({ error: 'No API key' });

  const { drugs = [], supplements = [], foods = [], patient, language = 'en' } = req.body;
  if (drugs.length < 1) return res.status(400).json({ error: 'At least 1 drug required' });

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (event, data) => {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };

  try {
    // Step 1: Pair cache lookup (instant)
    const pairCacheLookup = lookupPairsFromCache(drugs);
    const cachedDDPairs = pairCacheLookup.found;
    const missingDDPairs = pairCacheLookup.missing;
    const cachedDDInteractions = cachedDDPairs.filter(p => p.hasInteraction);
    send('cache', { hits: cachedDDPairs.length, misses: missingDDPairs.length });

    // Step 2: FDA data (skip if all cached and no supplements/foods)
    const allCached = missingDDPairs.length === 0 && supplements.length === 0 && foods.length === 0;
    let groundingContext = '';
    if (!allCached) {
      send('status', { message: 'Querying FDA databases...' });
      const drugDataArr = await Promise.all(drugs.map(fetchDrugData));
      groundingContext = buildGroundingContext(drugDataArr);
    } else {
      send('status', { message: 'Cache hit — skipping FDA lookup...' });
    }

    // Step 3: Build prompt
    const langInstr = language === 'es' ? ' Respond in Spanish.' : '';
    const cachedSummary = cachedDDInteractions.length > 0
      ? 'KNOWN INTERACTIONS FROM DATABASE:\n' + cachedDDInteractions.map(p => p.drugA + '+' + p.drugB + ': ' + p.severity + ' — ' + p.mechanism).join('\n') + '\n\n'
      : '';

    const prompt = groundingContext + cachedSummary +
      'Drug interaction analysis for: ' + drugs.join(', ') +
      (supplements.length ? ', supplements: ' + supplements.join(', ') : '') +
      (foods.length ? ', foods: ' + foods.join(', ') : '') +
      '.\n\nReturn ONLY raw JSON (no markdown): {"overall_risk":"HIGH|MODERATE|LOW|MINIMAL","risk_score":0,"summary":"2 sentences","known_interactions":[{"drugs":"A+B","type":"drug-drug","severity":"major|moderate|minor","mechanism":"","clinical_effect":"","monitoring":"","action":""}],"predictive_interactions":[{"drugs":"A+B","severity":"moderate","basis":"","clinical_effect":"","probability":"high|moderate|low","action":""}],"polypharmacy_assessment":{"overall_burden":"1 sentence","recommendations":"1 sentence"},"key_concern":"1 sentence","contraindicated":false,"executive_summary":"2 sentences"}' + langInstr;

    send('status', { message: 'Running AI analysis...' });

    // Step 4: Stream from Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': k,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      send('error', { message: 'Claude API error: ' + err.slice(0, 200) });
      return res.end();
    }

    // Stream the response chunks
    let fullText = '';
    const reader = claudeRes.body;
    let buffer = '';

    reader.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text;
              send('token', { text: parsed.delta.text });

              // Try to parse partial JSON and send risk score as soon as available
              if (fullText.includes('"risk_score"')) {
                const scoreMatch = fullText.match(/"risk_score"s*:s*(d+)/);
                const riskMatch = fullText.match(/"overall_risk"s*:s*"([^"]+)"/);
                if (scoreMatch && riskMatch) {
                  send('risk', { score: parseInt(scoreMatch[1]), tier: riskMatch[1] });
                }
              }
            }
          } catch (e) {}
        }
      }
    });

    reader.on('end', () => {
      // Parse and send the complete result
      try {
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          result.realtime_sources = allCached ? ['PairCache'] : ['RxNorm', 'OpenFDA'];
          send('complete', result);
        } else {
          send('error', { message: 'Could not parse JSON from response' });
        }
      } catch (e) {
        send('error', { message: 'Parse error: ' + e.message });
      }
      res.end();
    });

    reader.on('error', err => {
      send('error', { message: err.message });
      res.end();
    });

  } catch (e) {
    send('error', { message: e.message });
    res.end();
  }
});
// ── END STREAMING ENDPOINT ───────────────────────────────────────────────────


// ── OPENAI TTS ENDPOINT ──────────────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  try {
    const { text, language = 'en' } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    // Trim text to 4096 chars (OpenAI TTS limit per call)
    const trimmed = text.slice(0, 4096);

    // Use OpenAI TTS API
    const voice = language === 'es' ? 'nova' : 'alloy'; // nova works well for both languages
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: trimmed,
        voice: voice,
        speed: 1.0
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[TTS] OpenAI error:', err.slice(0, 200));
      return res.status(502).json({ error: 'TTS API error' });
    }

    // Stream the MP3 back to the browser
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    r.body.pipe(res);

  } catch (e) {
    console.error('[TTS] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── END TTS ENDPOINT ─────────────────────────────────────────────────────────


// ── CLINICAL WORKFLOW ROUTE ───────────────────────────────────────────────
app.get('/clinical', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(require('path').join(__dirname, 'clinical', 'index.html'));
});
// ── END CLINICAL ROUTE ────────────────────────────────────────────────────

// ── STEP 6: OUTREACH MESSAGE GENERATOR ──────────────────────────────────────
app.post('/api/generate-outreach', async (req, res) => {
  try {
    const {
      drugs = [],
      ddiResults = {},
      riskFactors = [],
      patientContext = {},
      language = 'en'
    } = req.body;

    if (!drugs.length) return res.status(400).json({ error: 'Drug list required' });

    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) return res.status(401).json({ error: 'No API key' });

    const confirmedFindings = [];
    const computedFindings = [];
    const predictiveFindings = [];

    // Layer 1: DDI results — CONFIRMED
    if (ddiResults.drug_interactions && ddiResults.drug_interactions.length) {
      ddiResults.drug_interactions.forEach(i => {
        if (i.severity === 'Critical' || i.severity === 'High') {
          confirmedFindings.push({
            type: 'drug_drug',
            finding: i.drug_a + ' and ' + i.drug_b + ' have a ' + (i.severity||'').toLowerCase() + ' drug interaction',
            action: i.action || 'Discuss with your pharmacist or physician.'
          });
        }
      });
    }

    // Layer 2-3: Selected risk factors — MANUALLY_CONFIRMED
    riskFactors.forEach(f => {
      if (f.value) {
        computedFindings.push({
          type: 'risk_factor',
          factorId: f.factorId,
          finding: f.plainLanguage || f.label,
          action: f.action || ''
        });
      }
    });

    // Layer 5: Supplement/food warnings — PREDICTIVE
    if (ddiResults.warnings && ddiResults.warnings.length) {
      ddiResults.warnings
        .filter(w => w.severity === 'Critical' || w.severity === 'High')
        .slice(0, 5)
        .forEach(w => {
          predictiveFindings.push({
            type: 'supplement_food',
            finding: w.interacts_with + ' (' + w.category + ') interacts with ' + w.drug,
            mechanism: w.mechanism || '',
            action: w.action || ''
          });
        });
    }

    const langInstr = language === 'es'
      ? 'Write the entire message in Spanish (español), clear and patient-friendly.'
      : 'Write in clear, warm, patient-friendly English. Avoid clinical jargon.';

    const patientName = patientContext.firstName || 'Member';
    const caseManagerName = patientContext.caseManagerName || 'your care team';
    const planName = patientContext.planName || 'your health plan';

    const prompt = `You are a clinical pharmacist generating a patient outreach message for ${planName}.

PATIENT: ${patientName}
MEDICATIONS: ${drugs.join(', ')}
OVERALL RISK: ${ddiResults.risk_tier || 'Unknown'}

CONFIRMED FINDINGS (declarative language — reference the record):
${confirmedFindings.length ? confirmedFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\n') : 'None identified.'}

COMPUTED FINDINGS (system-identified patterns):
${computedFindings.length ? computedFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\n') : 'None selected.'}

SPECIFIC SUPPLEMENTS/FOODS TO NAME (list each by name in the message):
${predictiveFindings.map(f => "- " + f.finding.split(" (")[0]).join("\n") || "None"}

PREDICTIVE FINDINGS (conditional language ONLY — inferred, not confirmed):
${predictiveFindings.length ? predictiveFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\n') : 'None identified.'}

COPY RULES — follow exactly:
- CONFIRMED (drug interactions): Strong declarative. "We see that you are taking [Drug A] and [Drug B] together — this combination requires careful monitoring because..."
- CONFIRMED (patient-reported foods/supplements): Strong, urgent, and specific. "Because you regularly consume/use [food/supplement], this is important: [specific risk]. You should [strong action — use words like stop, avoid, discontinue, or discuss stopping immediately with your doctor]." Always recommend stopping or discussing with doctor for High/Critical risk items. Name the specific drug it interacts with.
- COMPUTED: Pattern framing. "Our medication review identified..." or "Based on your current regimen..."
- PREDICTIVE: Name each supplement/food SPECIFICALLY by name. Use: "Based on your medications, you may want to avoid [SPECIFIC NAME] because..." NEVER imply the patient IS currently taking a predictive item.
- CRITICAL: Supplements and foods are things like Fish Oil, Vitamin E, Ginkgo Biloba, St. John's Wort, grapefruit juice, alcohol, leafy greens. NEVER list prescription drugs (like Morphine, Oxycodone, Warfarin, etc.) as supplements or foods to avoid — those are medications, not supplements.
- Confirmed foods/supplements must appear PROMINENTLY early in the letter, not buried.
- No raw lab values, no risk score numbers, no terms like eGFR, LFT, PCPRS, polypharmacy, frail, non-adherent
- End the email with ONLY this closing — no modifications, no additions, no placeholders: "Please reach out to us with any questions. Warm regards, ${caseManagerName}". Do NOT add phone numbers, portal links, brackets, or any other tokens after this closing.
- Keep the message hopeful and action-oriented, not alarming

Generate THREE versions:
1. EMAIL — 150-200 words, subject line included, warm and professional
2. SMS — max 160 characters, clear and direct
3. CASE_MANAGER_SCRIPT — talking points for a phone call (bullet points)

Return ONLY valid JSON (no markdown):
{
  "email": { "subject": "<subject>", "body": "<full email>" },
  "sms": { "body": "<SMS max 160 chars>" },
  "case_manager_script": {
    "opening": "<opening line>",
    "key_points": ["<point 1>", "<point 2>", "<point 3>"],
    "closing": "<closing line>"
  },
  "confidence_summary": {
    "confirmed_count": ${confirmedFindings.length},
    "computed_count": ${computedFindings.length},
    "predictive_count": ${predictiveFindings.length},
    "highest_tier_used": "${confirmedFindings.length > 0 ? 'CONFIRMED' : computedFindings.length > 0 ? 'COMPUTED' : 'PREDICTIVE'}"
  }
}`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }] })
    });

    if (!claudeResp.ok) {
      const err = await claudeResp.text();
      return res.status(502).json({ error: 'AI API error' });
    }

    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.[0]?.text || '';
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');

    const result = JSON.parse(m[0]);

    // Step 2: Translate to Spanish if requested (English-first for clinical accuracy)
    if (language === 'es' && result.email && result.sms) {
      const translatePrompt = `Translate this patient medication outreach from English to Spanish. Keep all drug names in English/generic form. Keep clinical facts identical. Closing must be "Atentamente, ${caseManagerName}". SMS under 160 chars.

Email subject: ${JSON.stringify(result.email.subject)}
Email body: ${JSON.stringify(result.email.body)}
SMS: ${JSON.stringify(result.sms.body)}
Script opening: ${JSON.stringify(result.case_manager_script?.opening||'')}
Script points: ${JSON.stringify(result.case_manager_script?.key_points||[])}
Script closing: ${JSON.stringify(result.case_manager_script?.closing||'')}

Return ONLY valid JSON: {"email":{"subject":"<es>","body":"<es>"},"sms":{"body":"<es>"},"case_manager_script":{"opening":"<es>","key_points":["<es>"],"closing":"<es>"}}`;
      try {
        const tr = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
          body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:2000,messages:[{role:'user',content:translatePrompt}]})
        });
        if(tr.ok){
          const td = await tr.json();
          const traw = td.content?.[0]?.text||'';
          const tm = traw.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim().match(/\{[\s\S]*\}/);
          if(tm){
            const translated = JSON.parse(tm[0]);
            result.email_en = result.email;
            result.sms_en = result.sms;
            result.case_manager_script_en = result.case_manager_script;
            result.email = translated.email || result.email;
            result.sms = translated.sms || result.sms;
            result.case_manager_script = translated.case_manager_script || result.case_manager_script;
            result.translated = true;
          }
        }
      } catch(te){ console.error('Translation error:',te.message); }
    }

    result.drugs = drugs;
    result.risk_tier = ddiResults.risk_tier;
    result.generated_at = new Date().toISOString();
    res.json(result);

  } catch (e) {
    console.error('[STEP6]', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── END STEP 6 ────────────────────────────────────────────────────────────

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

