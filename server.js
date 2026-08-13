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

// Load .env before anything reads process.env. Does not override vars that are
// already set, so Render's dashboard config still wins in production.
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();


// Terms of Use
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
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

// ── MECHANISM GROUPING ───────────────────────────────────────────────────────
// Collapses pairwise findings into one finding per CPRS dimension so that a
// regimen with several agents sharing a mechanism produces one clinical finding
// rather than N-choose-2 alerts.
//
// Does NOT touch risk_score or dimension scores. computeCompositeFromPairs()
// keeps its existing max-per-dimension semantics. This is display shaping only.
//
// Paste this near lookupPairsFromCache() in server.js.
 
// Dimension names as used in CPRS_WEIGHTS and in cached pair.dimensions objects.
const GROUPABLE_DIMENSIONS = [
  'Bleeding Risk',
  'Cardiac Risk',
  'Serotonin Risk',
  'CNS Risk'
];
 
// Dimensions deliberately NOT grouped: 'NTI Conflict', 'CYP450 Risk',
// 'Renal/Hepatic', 'Pharmacodynamic'. These are pair-specific — a narrow
// therapeutic index conflict or a specific CYP inhibition is about those two
// drugs, not an additive burden across the regimen. Collapsing them would
// lose the clinically relevant detail.
 
const SEVERITY_RANK = { major: 3, moderate: 2, minor: 1, none: 0 };
 
// A finding is grouped only if its dominant dimension is groupable AND that
// dimension score clears this floor. Prevents trivial contributions from
// inflating the contributing-agent count.
const DIMENSION_FLOOR = 3;
 
function severityOf(finding) {
  return SEVERITY_RANK[String(finding.severity || '').toLowerCase()] || 0;
}
 
// Pull individual substance names out of a "A+B" drugs string.
function agentsOf(finding) {
  return String(finding.drugs || '')
    .split('+')
    .map(s => s.trim())
    .filter(Boolean);
}
 
// Given a cached pair, return the dimension carrying the highest score,
// or null if nothing clears the floor.
function dominantDimension(pair) {
  const dims = pair && pair.dimensions;
  if (!dims) return null;
  let best = null;
  let bestScore = 0;
  for (const dim of GROUPABLE_DIMENSIONS) {
    const score = Number(dims[dim]) || 0;
    if (score > bestScore) {
      bestScore = score;
      best = dim;
    }
  }
  return bestScore >= DIMENSION_FLOOR ? best : null;
}
 
// Build a lookup from "druga|drugb" -> cached pair, for attaching dimension
// data to model-returned findings.
function indexPairs(foundPairs) {
  const idx = {};
  for (const p of foundPairs || []) {
    if (!p || !p.drugA || !p.drugB) continue;
    const a = String(p.drugA).toLowerCase();
    const b = String(p.drugB).toLowerCase();
    idx[a + '|' + b] = p;
    idx[b + '|' + a] = p;
  }
  return idx;
}
 
/**
 * Group a flat array of findings by shared mechanism.
 *
 * @param {Array}  findings   known_interactions from the model
 * @param {Array}  foundPairs cached pairs from lookupPairsFromCache().found
 * @returns {Array} findings, grouped where warranted, ordered for display
 */
function groupFindingsByMechanism(findings, foundPairs) {
  if (!Array.isArray(findings) || findings.length === 0) return findings || [];
 
  const pairIdx = indexPairs(foundPairs);
  const buckets = {};   // dimension -> array of findings
  const ungrouped = [];
 
  for (const f of findings) {
    const agents = agentsOf(f);
    let dim = null;
 
    if (agents.length === 2) {
      const key = agents[0].toLowerCase() + '|' + agents[1].toLowerCase();
      const pair = pairIdx[key];
      if (pair) dim = dominantDimension(pair);
    }
 
    if (dim) {
      (buckets[dim] = buckets[dim] || []).push(f);
    } else {
      ungrouped.push(f);
    }
  }
 
  const grouped = [];
 
  for (const [dim, members] of Object.entries(buckets)) {
    // A single finding in a bucket is not a group — pass it through untouched
    // so we don't rewrite a normal one-pair interaction into group phrasing.
    if (members.length < 2) {
      ungrouped.push(members[0]);
      continue;
    }
 
    // Collect distinct contributing agents across the bucket.
    const agentSet = [];
    const seen = {};
    for (const m of members) {
      for (const a of agentsOf(m)) {
        const k = a.toLowerCase();
        if (!seen[k]) { seen[k] = 1; agentSet.push(a); }
      }
    }
 
    // The group inherits the highest severity present among its members, and
    // the narrative fields from that worst member.
    const worst = members.reduce((acc, m) => severityOf(m) > severityOf(acc) ? m : acc, members[0]);
 
    grouped.push({
      drugs: dim.replace(/ Risk$/, '') + ' — ' + agentSet.length + ' contributing agents',
      type: worst.type || 'drug-drug',
      severity: worst.severity,
      grouped: true,
      dimension: dim,
      contributing_agents: agentSet,
      component_count: members.length,
      mechanism: worst.mechanism,
      clinical_effect: worst.clinical_effect,
      evidence: worst.evidence,
      monitoring: worst.monitoring,
      action: worst.action,
      patient_specific: worst.patient_specific,
      components: members
    });
  }
 
  // Order: severity first, then grouped findings ahead of singletons at equal
  // severity (a shared mechanism across several agents outranks one pair).
  const all = grouped.concat(ungrouped);
  all.sort((a, b) => {
    const s = severityOf(b) - severityOf(a);
    if (s !== 0) return s;
    return (b.grouped ? 1 : 0) - (a.grouped ? 1 : 0);
  });
 
  return all;
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
      max_tokens: 8000,
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

// ── PILOT ACCESS GATE ────────────────────────────────────────────────────────
// Password-protects the three institutional surfaces. The patient app at / and
// intractmd.com stays open to anyone.
//
//   /proactive      Proactive Engine
//   /clinical       Clinical Workflow
//   /deprescribing  Deprescribing Review
//
// WHAT IS AND IS NOT PROTECTED
// ----------------------------
// This gates the PAGES, not the API endpoints behind them. The endpoints are
// left open deliberately: /api/analyze and several others are shared with the
// patient app, and locking a shared endpoint would break the public tool.
// Someone who knows an API URL could still call it directly.
//
// That is an acceptable trade for a pilot gate — the purpose here is to stop
// the surfaces being browsable, not to secure the compute. Locking the
// institutional-only endpoints is a sensible second step once the live patient
// app's API usage has been confirmed.
//
// CREDENTIALS
// -----------
// Set PILOT_USERS in Render as a comma-separated list, so each pilot partner
// can have its own login and one can be revoked without disturbing the others:
//
//   PILOT_USERS = mercy:8Kd2mQx7,banner:pT4vR9wL,demo:Xy7nB3kR
//
// A single PILOT_USER / PILOT_PASSWORD pair also works if you prefer one login.
//
// FAIL CLOSED
// -----------
// If no credentials are configured the surfaces return 503 rather than opening
// to the public. A forgotten environment variable should not silently expose an
// unreviewed clinical tool.

const PILOT_PATHS = ['/proactive', '/clinical', '/deprescribing'];

function loadPilotUsers() {
  const users = {};
  const list = (process.env.PILOT_USERS || '').trim();
  if (list) {
    for (const entry of list.split(',')) {
      const i = entry.indexOf(':');
      if (i < 1) continue;
      const u = entry.slice(0, i).trim();
      const p = entry.slice(i + 1).trim();
      if (u && p) users[u] = p;
    }
  }
  if (process.env.PILOT_USER && process.env.PILOT_PASSWORD) {
    users[process.env.PILOT_USER] = process.env.PILOT_PASSWORD;
  }
  return users;
}

const PILOT_USERS = loadPilotUsers();
const PILOT_USER_COUNT = Object.keys(PILOT_USERS).length;

if (PILOT_USER_COUNT > 0) {
  console.log('[PILOT GATE] Active on ' + PILOT_PATHS.join(', ') +
    ' — ' + PILOT_USER_COUNT + ' credential' + (PILOT_USER_COUNT === 1 ? '' : 's') + ' configured');
} else {
  console.warn('[PILOT GATE] No PILOT_USERS configured — institutional surfaces will return 503. ' +
    'Set PILOT_USERS in the environment to enable access.');
}

const pilotAuth = basicAuth({
  users: PILOT_USERS,
  challenge: true,
  realm: 'IntractMD Pilot Access',
  unauthorizedResponse: () =>
    'This IntractMD surface is available to pilot participants. ' +
    'Contact Resolve Medical at 216-509-0672 or info@resolve.med for access.',
});

app.use((req, res, next) => {
  // Match the path itself and anything beneath it, but not merely a shared
  // prefix — /deprescribing-info should not be gated by /deprescribing.
  const gated = PILOT_PATHS.some(
    p => req.path === p || req.path.startsWith(p + '/')
  );
  if (!gated) return next();

  if (PILOT_USER_COUNT === 0) {
    return res.status(503).send(
      'This IntractMD surface is not currently available. ' +
      'Contact Resolve Medical at 216-509-0672 or info@resolve.med.'
    );
  }
  return pilotAuth(req, res, next);
});
// ── END PILOT ACCESS GATE ────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 — PARTNER DATA FEED · PHASE 1: AUTH + DATABASE
// ════════════════════════════════════════════════════════════════════════════
// Clerk handles identity; Postgres holds partner records keyed by Clerk user id.
// Both are OPTIONAL at boot: if the env vars are missing the server still starts
// and every existing public route keeps working unauthenticated. Only the
// /api/partner/* routes require a signed-in user.
// ════════════════════════════════════════════════════════════════════════════

const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');

const CLERK_ENABLED = !!(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);

if (CLERK_ENABLED) {
  // Attaches req.auth to every request. It does NOT block anything on its own —
  // unauthenticated visitors simply get a null userId, so the public drug
  // checker is unaffected.
  app.use(clerkMiddleware());
  console.log('[CLERK] Middleware active (' +
    (process.env.CLERK_PUBLISHABLE_KEY.startsWith('pk_live_') ? 'live' : 'test') + ' instance)');
} else {
  console.warn('[CLERK] Disabled — CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY not set');
}

// ── Postgres pool ───────────────────────────────────────────────────────────
const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  const isInternal = /\.internal\b/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render's external Postgres endpoint terminates TLS with a certificate our
    // Node trust store can't chain to, so verification is relaxed there. The
    // internal (private-network) endpoint doesn't use TLS at all.
    ssl: isInternal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // A dropped backend connection emits on the pool; without a listener Node
  // treats it as an unhandled error event and kills the process.
  pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));

  pool.query('SELECT 1')
    .then(() => console.log('[DB] Connected'))
    .catch((e) => console.error('[DB] Initial connection failed:', e.message));
} else {
  console.warn('[DB] Disabled — DATABASE_URL not set');
}

// Idempotent schema bootstrap. Every partner is one Clerk user; this table is
// where partner-specific feed config will hang off in Phase 2.
async function initPartnerSchema() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partner_accounts (
        id             SERIAL PRIMARY KEY,
        clerk_user_id  TEXT UNIQUE NOT NULL,
        email          TEXT,
        organization   TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at   TIMESTAMPTZ
      )
    `);
    console.log('[DB] partner_accounts ready');
  } catch (e) {
    console.error('[DB] Schema bootstrap failed:', e.message);
  }
}
// Phase 2 extends this with the member/consent/feed tables. Chained rather than
// fired in parallel because member_consents carries an FK onto member_profiles.
bootstrapV2Schema();

// ── Auth/database status endpoints ──────────────────────────────────────────

// The frontend pulls its publishable key from here rather than having it baked
// into index.src.html, so test/live keys switch with the environment.
app.get('/api/auth/config', (req, res) => {
  res.json({
    enabled: CLERK_ENABLED,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || null,
  });
});

app.get('/api/db/health', async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, now: rows[0].now });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ── Protected partner routes ────────────────────────────────────────────────
// Deliberately not Clerk's requireAuth(): that redirects browsers to a sign-in
// page (302), which is wrong for a data feed. API clients need a JSON 401.
// This also avoids the deprecated requireAuth() helper.
function protect(req, res, next) {
  if (!CLERK_ENABLED) {
    return res.status(503).json({ error: 'Authentication is not configured on this server' });
  }
  const auth = getAuth(req);
  if (!auth || !auth.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Returns the signed-in user and upserts their partner_accounts row.
app.get('/api/partner/me', protect, async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const user = await clerkClient.users.getUser(userId);
    const email = user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : null;

    let account = null;
    if (pool) {
      const { rows } = await pool.query(
        `INSERT INTO partner_accounts (clerk_user_id, email, last_seen_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (clerk_user_id)
         DO UPDATE SET email = EXCLUDED.email, last_seen_at = NOW()
         RETURNING id, clerk_user_id, email, organization, status, created_at`,
        [userId, email]
      );
      account = rows[0];
    }

    res.json({
      userId,
      email,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      account,
    });
  } catch (e) {
    console.error('[PARTNER] /me failed:', e.message);
    res.status(500).json({ error: 'Failed to load partner profile' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 · PHASE 2: DATABASE SCHEMA
// ════════════════════════════════════════════════════════════════════════════
// Implements the storage layer for FIG. 13 of the specification:
//
//   step 1306  member_profiles         PHI-free persistent medication profile
//   steps 1302/1304  member_consents   two-tier, independently revocable consent
//   steps 1308/1310  member_risk_history   longitudinal risk continuity
//   step 1322  partner_brand_configs   per-partner brand object (multi-tenant)
//   steps 1320/1324  outreach_events   delta-triggered outreach log
//   step 1318  reanalysis_runs         scheduled population re-analysis audit
//
// Every statement is idempotent so the server can boot against a fresh database
// or one that already has some of these tables.
// ════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

// ── PHI exclusion ───────────────────────────────────────────────────────────
// Spec 1306: the schema "contains no fields for name, date of birth, address,
// member identification number, or any other personal identifier ... such that
// the system is architecturally incapable of storing such information rather
// than merely configured to avoid collecting it."
//
// Two mechanisms enforce that here:
//   1. member_profiles has no column any such value could land in. The three
//      substance columns are normalised to arrays of plain strings on write
//      (normalizeSubstanceList), so an object carrying PHI cannot survive.
//   2. Request bodies are scanned for PHI-shaped keys and rejected outright,
//      so a client cannot even attempt the write.
const PHI_KEY_PATTERN = new RegExp(
  '^(' +
  'name|first_?name|last_?name|full_?name|middle_?name|' +
  'dob|date_?of_?birth|birth_?date|age|' +
  'ssn|social_?security|mrn|medical_?record_?number|' +
  'member_?id|member_?number|subscriber_?id|patient_?id|insurance_?id|' +
  'address|street|address_?line_?[12]|city|state|zip|zipcode|postal_?code|' +
  'phone|phone_?number|mobile|email|email_?address|' +
  'gender|sex|race|ethnicity' +
  ')$', 'i'
);

// Walks a request body and reports the first PHI-shaped key it finds.
function findPhiKey(value, path) {
  path = path || '';
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPhiKey(value[i], path + '[' + i + ']');
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (PHI_KEY_PATTERN.test(key)) return (path ? path + '.' : '') + key;
    const hit = findPhiKey(value[key], (path ? path + '.' : '') + key);
    if (hit) return hit;
  }
  return null;
}

// Express middleware form of the above. Applied to every member write route.
function rejectPhi(req, res, next) {
  const offending = findPhiKey(req.body, '');
  if (offending) {
    return res.status(400).json({
      error: 'Personal identifiers are not accepted by this endpoint',
      field: offending,
      detail: 'Member profiles are stored PHI-free against an anonymous session token.',
    });
  }
  next();
}

// Collapses whatever a client sends into a de-duplicated array of trimmed
// substance-name strings. Objects are reduced to their name-ish field, which is
// what makes the PHI-free guarantee structural rather than advisory.
function normalizeSubstanceList(input, max) {
  max = max || 60;
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of input) {
    let label = null;
    if (typeof entry === 'string') label = entry;
    else if (entry && typeof entry === 'object') {
      label = entry.name || entry.drug || entry.substance || entry.label || null;
    }
    if (typeof label !== 'string') continue;
    label = label.trim().slice(0, 120);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

async function initMemberSchema() {
  if (!pool) return;

  // NOTE: no name / dob / address / member-number column exists here, and none
  // may be added — see the PHI exclusion note above.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_profiles (
      id               SERIAL PRIMARY KEY,
      session_token    TEXT UNIQUE NOT NULL,
      partner_id       INTEGER REFERENCES partner_accounts(id) ON DELETE SET NULL,
      medications      JSONB NOT NULL DEFAULT '[]'::jsonb,
      supplements      JSONB NOT NULL DEFAULT '[]'::jsonb,
      food_factors     JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_analyzed_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_member_profiles_partner ON member_profiles(partner_id)`
  );

  // Spec 1302/1304: two consents, separate rows of state, independently
  // revocable. Tier 1 gates persistence; tier 2 gates outbound transmission
  // only and never affects the stored profile.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_consents (
      session_token         TEXT PRIMARY KEY
                              REFERENCES member_profiles(session_token) ON DELETE CASCADE,
      tier1_persist_granted BOOLEAN NOT NULL DEFAULT FALSE,
      tier1_granted_at      TIMESTAMPTZ,
      tier1_revoked_at      TIMESTAMPTZ,
      tier2_share_granted   BOOLEAN NOT NULL DEFAULT FALSE,
      tier2_granted_at      TIMESTAMPTZ,
      tier2_revoked_at      TIMESTAMPTZ,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Append-only consent audit trail. Revocation must remain provable after the
  // fact even though member_consents only holds current state.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_consent_events (
      id            SERIAL PRIMARY KEY,
      session_token TEXT NOT NULL,
      tier          SMALLINT NOT NULL CHECK (tier IN (1, 2)),
      action        TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_consent_events_token ON member_consent_events(session_token, occurred_at DESC)`
  );

  // Spec 1308/1310: every computed score is retained so the risk-continuity
  // module can compare the current tier against the previous cycle's tier.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_risk_history (
      id                SERIAL PRIMARY KEY,
      session_token     TEXT NOT NULL,
      cprs              SMALLINT NOT NULL,
      risk_tier         TEXT NOT NULL,
      dimensions        JSONB,
      interaction_count SMALLINT NOT NULL DEFAULT 0,
      cycle             TEXT NOT NULL DEFAULT 'session',
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_risk_history_token ON member_risk_history(session_token, computed_at DESC)`
  );

  // Spec 1322: one brand configuration object per licensed health plan partner.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_brand_configs (
      partner_id                  INTEGER PRIMARY KEY
                                    REFERENCES partner_accounts(id) ON DELETE CASCADE,
      organization_name           TEXT,
      member_services_contact     TEXT,
      clinical_escalation_pathway TEXT,
      tone_profile                TEXT DEFAULT 'warm, professional, plain-language',
      language                    TEXT NOT NULL DEFAULT 'en',
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Spec 1320/1324: one row per delta-triggered outreach event. Rows are only
  // created on an upward tier change — that condition is the whole point.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_events (
      id           SERIAL PRIMARY KEY,
      session_token TEXT NOT NULL,
      partner_id   INTEGER REFERENCES partner_accounts(id) ON DELETE SET NULL,
      prior_tier   TEXT,
      new_tier     TEXT NOT NULL,
      prior_cprs   SMALLINT,
      new_cprs     SMALLINT NOT NULL,
      package      JSONB,
      status       TEXT NOT NULL DEFAULT 'pending',
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_outreach_partner ON outreach_events(partner_id, created_at DESC)`
  );

  // Spec 1318: audit of each scheduled population re-analysis cycle.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reanalysis_runs (
      id                 SERIAL PRIMARY KEY,
      partner_id         INTEGER REFERENCES partner_accounts(id) ON DELETE CASCADE,
      trigger            TEXT NOT NULL DEFAULT 'scheduled',
      status             TEXT NOT NULL DEFAULT 'running',
      members_analyzed   INTEGER NOT NULL DEFAULT 0,
      tier_upgrades      INTEGER NOT NULL DEFAULT 0,
      outreach_generated INTEGER NOT NULL DEFAULT 0,
      error              TEXT,
      started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at        TIMESTAMPTZ
    )
  `);

  // Partner-configured re-analysis schedule (spec 1318). Added to the Phase 1
  // table rather than a new one, since it is per-partner configuration.
  await pool.query(`
    ALTER TABLE partner_accounts
      ADD COLUMN IF NOT EXISTS feed_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS reanalysis_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reanalysis_hour_utc     SMALLINT NOT NULL DEFAULT 3,
      ADD COLUMN IF NOT EXISTS reanalysis_cadence_days SMALLINT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS last_reanalysis_at      TIMESTAMPTZ
  `);

  // Phase 5 authenticates partners with an issued API key rather than a Clerk
  // session, because a health plan care management system pulls the feed
  // server-to-server and never sits in a browser. Only the SHA-256 of the key
  // is stored; the plaintext is shown once at issue time and is unrecoverable.
  await pool.query(`
    ALTER TABLE partner_accounts
      ADD COLUMN IF NOT EXISTS api_key_hash      TEXT,
      ADD COLUMN IF NOT EXISTS api_key_prefix    TEXT,
      ADD COLUMN IF NOT EXISTS api_key_issued_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS api_key_last_used_at TIMESTAMPTZ
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_partner_api_key ON partner_accounts(api_key_hash)`
  );

  // Partners provisioned by an administrator have no Clerk user, so the Phase 1
  // NOT NULL on clerk_user_id no longer holds. The UNIQUE constraint stays —
  // Postgres permits multiple NULLs under it.
  try {
    await pool.query(`ALTER TABLE partner_accounts ALTER COLUMN clerk_user_id DROP NOT NULL`);
  } catch (e) {
    console.error('[DB] clerk_user_id nullability migration skipped:', e.message);
  }

  // Enrollment code: how an anonymous member session is associated with the
  // partner whose feed it belongs to, without the member ever being identified.
  // Separate statement so a pre-existing conflicting column cannot take the
  // rest of the migration down with it. gen_random_uuid() is built in on the
  // Postgres 18 instance backing this, so no pgcrypto extension is required.
  try {
    await pool.query(`
      ALTER TABLE partner_accounts
        ADD COLUMN IF NOT EXISTS enrollment_code TEXT UNIQUE
        DEFAULT replace(gen_random_uuid()::text, '-', '')
    `);
  } catch (e) {
    console.error('[DB] enrollment_code migration skipped:', e.message);
  }

  console.log('[DB] v2 member/consent/feed schema ready');
}

// Durable storage for the nightly test runner. Render's filesystem is
// ephemeral, so logs/latest.json is wiped by every deploy and restart and
// /test-status would revert to "No results yet" until the next 02:00 UTC run.
// Postgres survives both.
async function initTestResultSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_test_runs (
      id               SERIAL PRIMARY KEY,
      run_day          DATE NOT NULL,
      trigger          TEXT NOT NULL,
      target           TEXT,
      all_green        BOOLEAN,
      feature_check    JSONB,
      test_suite       JSONB,
      duration_seconds INTEGER,
      error            TEXT,
      started_at       TIMESTAMPTZ,
      finished_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_test_runs_finished ON scheduled_test_runs(finished_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_test_runs_day ON scheduled_test_runs(run_day, trigger)`
  );
  console.log('[DB] scheduled_test_runs ready');
}

async function bootstrapV2Schema() {
  if (!pool) return;
  try {
    await initPartnerSchema();
    await initMemberSchema();
    await initTestResultSchema();
  } catch (e) {
    console.error('[DB] v2 schema bootstrap failed:', e.message);
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

// Resolves the Clerk-authenticated caller to their partner_accounts row.
// protect() has already guaranteed a userId by the time this runs.
async function getPartnerAccount(req) {
  if (!pool) return null;
  const { userId } = getAuth(req);
  const { rows } = await pool.query(
    `SELECT * FROM partner_accounts WHERE clerk_user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// Ranking used for every tier comparison in phases 3-6. Kept in one place so
// the feed, the continuity module and the delta trigger cannot drift apart.
const RISK_TIER_RANK = { Minimal: 0, Low: 1, Moderate: 2, High: 3, Critical: 4 };

function tierRank(tier) {
  return RISK_TIER_RANK[tier] != null ? RISK_TIER_RANK[tier] : 0;
}

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 · PHASE 3: MEMBER PROFILE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════
// Spec FIG. 13 steps 1306, 1308 and 1310.
//
// A member is an ANONYMOUS SESSION TOKEN and nothing else. There is no login,
// no Clerk user, no identifier of any kind — Clerk authenticates *partners*
// (phase 1), never members. The token is the only handle on a profile, so it is
// generated with 32 bytes of CSPRNG entropy and is unguessable.
//
// step 1308: the CPRS engine recomputes a composite score from the persisted
//            lists on each session initialisation.
// step 1310: the risk-continuity module compares that score against the score
//            stored for the same token last cycle and reports any tier change,
//            giving longitudinal tracking with no identity linkage whatsoever.
// ════════════════════════════════════════════════════════════════════════════

const SESSION_TOKEN_BYTES = 32;

function mintSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

// The codebase carries three different tier cut-off sets (calcPcprsFromDD uses
// 80/60/40/20, the proactive path uses 70/50/30/10). Phases 3-6 standardise on
// analyzeRegimenHybrid's thresholds so that a tier stored by /api/member/analyze
// is directly comparable to one computed by the scheduled re-analysis.
function classifyRiskTier(cprs) {
  if (cprs >= 81) return 'Critical';
  if (cprs >= 61) return 'High';
  if (cprs >= 41) return 'Moderate';
  if (cprs >= 21) return 'Low';
  return 'Minimal';
}

const SEVERITY_SCORE = { Critical: 85, High: 65, Moderate: 40, Low: 15, Minimal: 0 };

// Loose containment match in both directions, so a member's "Fish Oil" matches
// a profile entry of "Fish Oil (Omega-3)" and vice versa.
function substanceMatches(memberEntry, profileEntry) {
  const a = String(memberEntry || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const b = String(profileEntry || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // Containment only counts when the shorter side is substantial enough to be a
  // real substance name. Without this, a member entry of "K" or "B6" matches
  // half the profile catalogue and manufactures findings that do not exist.
  if (Math.min(a.length, b.length) < 4) return false;
  return a.includes(b) || b.includes(a);
}

// Resolves a member session from the X-Session-Token header (body.sessionToken
// is accepted as a fallback for clients that cannot set headers). Attaches
// req.member — the profile row — and req.consent.
async function resolveMember(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  const token = req.get('X-Session-Token') || (req.body && req.body.sessionToken);
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Missing session token' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              c.tier1_persist_granted, c.tier2_share_granted,
              c.tier1_granted_at, c.tier1_revoked_at,
              c.tier2_granted_at, c.tier2_revoked_at
         FROM member_profiles p
         LEFT JOIN member_consents c ON c.session_token = p.session_token
        WHERE p.session_token = $1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Unknown session token' });
    req.member = rows[0];
    req.sessionToken = token;
    next();
  } catch (e) {
    console.error('[MEMBER] resolve failed:', e.message);
    res.status(500).json({ error: 'Session lookup failed' });
  }
}

// Tier 1 gate. Persistence of a medication profile is only lawful once the
// member has granted the first consent (spec 1302).
function requireTier1(req, res, next) {
  if (!req.member || !req.member.tier1_persist_granted) {
    return res.status(403).json({
      error: 'Tier 1 consent required',
      detail: 'Grant consent at POST /api/member/consent {"tier":1,"granted":true} before storing a medication profile.',
    });
  }
  next();
}

// ── step 1308: composite risk from the persisted profile ────────────────────
// Cache-only by design (spec FIG. 11): drug-drug severity comes from the
// pre-computed pair cache and supplement/food severity from the pre-computed
// proactive profile cache. No AI call, so this is cheap enough to run on every
// session init and across a whole population on a schedule (phase 6).
function computeMemberRisk(profile) {
  const medications = Array.isArray(profile.medications) ? profile.medications : [];
  const supplements = Array.isArray(profile.supplements) ? profile.supplements : [];
  const foodFactors = Array.isArray(profile.food_factors) ? profile.food_factors : [];
  const totalSubstances = medications.length + supplements.length + foodFactors.length;

  // Drug-drug leg — pre-computed pair cache.
  const { found, missing, totalPairs } = lookupPairsFromCache(medications);
  const ddComposite = computeCompositeFromPairs(found, totalSubstances);
  const ddInteractions = found.filter(p => p.hasInteraction).map(p => ({
    kind: 'drug-drug',
    drug_a: p.drugA,
    drug_b: p.drugB,
    severity: p.severity,
    mechanism: p.mechanism || '',
    action: p.action || '',
  }));

  // Supplement/food leg — the member's OWN supplements and foods matched
  // against each medication's proactive profile. Spec 1312 is explicit that the
  // finding must involve a substance in that member's profile, not merely a
  // substance the medication could theoretically interact with.
  const sfFindings = [];
  const seenFinding = new Set();
  const memberSubstances = supplements.map(s => ({ name: s, category: 'supplement' }))
    .concat(foodFactors.map(f => ({ name: f, category: 'food' })));

  for (const med of medications) {
    const prof = loadProactiveProfile(med);
    if (!prof) continue;
    const buckets = [
      { list: prof.avoid_supplements, category: 'supplement' },
      { list: prof.caution_supplements, category: 'supplement' },
      { list: prof.avoid_foods, category: 'food' },
      { list: prof.caution_foods, category: 'food' },
    ];
    for (const bucket of buckets) {
      for (const item of bucket.list || []) {
        if (!item || !item.name) continue;
        const owned = memberSubstances.find(
          ms => ms.category === bucket.category && substanceMatches(ms.name, item.name)
        );
        if (!owned) continue;
        const key = (med + '|' + owned.name).toLowerCase();
        if (seenFinding.has(key)) continue;
        seenFinding.add(key);
        sfFindings.push({
          kind: 'drug-' + bucket.category,
          medication: med,
          substance: owned.name,
          matched_profile_entry: item.name,
          category: bucket.category,
          severity: item.severity || 'Moderate',
          mechanism: item.mechanism || '',
          action: item.action || '',
        });
      }
    }
  }

  // Composite. computeCompositeFromPairs already folds in the polypharmacy
  // factor and the critical-severity floor, so phi is applied to the
  // supplement/food leg separately and the two legs are then maxed rather than
  // summed — consistent with the conservative max-not-sum rule used there.
  const phi = 1 + 0.05 * Math.max(0, totalSubstances - 4);
  const sfWorst = sfFindings.reduce(
    (worst, f) => (tierRank(f.severity) > tierRank(worst) ? f.severity : worst),
    'Minimal'
  );
  const sfCprs = Math.min(100, Math.round((SEVERITY_SCORE[sfWorst] || 0) * phi));
  const cprs = Math.min(100, Math.max(ddComposite.cprs, sfCprs));

  return {
    cprs,
    risk_tier: classifyRiskTier(cprs),
    dimensions: ddComposite.dimensions,
    drug_interactions: ddInteractions,
    supplement_food_findings: sfFindings,
    worst_supplement_food_severity: sfWorst,
    substance_counts: {
      medications: medications.length,
      supplements: supplements.length,
      food_factors: foodFactors.length,
    },
    coverage: {
      pairs_total: totalPairs,
      pairs_cached: found.length,
      pairs_missing: missing.length,
      // Surfaced honestly: a low hit rate means the score is based on partial
      // pair coverage, which the caller may want to resolve via /api/analyze.
      pair_hit_rate: totalPairs > 0 ? Math.round((found.length / totalPairs) * 100) : 100,
    },
  };
}

// ── step 1310: risk continuity ──────────────────────────────────────────────
// Compares against the most recent stored score for the SAME anonymous token.
async function getPreviousRisk(sessionToken) {
  const { rows } = await pool.query(
    `SELECT cprs, risk_tier, computed_at, cycle
       FROM member_risk_history
      WHERE session_token = $1
      ORDER BY computed_at DESC
      LIMIT 1`,
    [sessionToken]
  );
  return rows[0] || null;
}

function buildContinuity(previous, current) {
  if (!previous) {
    return {
      is_first_analysis: true,
      previous_tier: null,
      previous_cprs: null,
      current_tier: current.risk_tier,
      current_cprs: current.cprs,
      tier_changed: false,
      direction: 'baseline',
      cprs_delta: 0,
    };
  }
  const delta = tierRank(current.risk_tier) - tierRank(previous.risk_tier);
  return {
    is_first_analysis: false,
    previous_tier: previous.risk_tier,
    previous_cprs: previous.cprs,
    previous_computed_at: previous.computed_at,
    current_tier: current.risk_tier,
    current_cprs: current.cprs,
    tier_changed: delta !== 0,
    direction: delta > 0 ? 'increased' : delta < 0 ? 'decreased' : 'unchanged',
    cprs_delta: current.cprs - previous.cprs,
  };
}

// Runs step 1308 + 1310 and appends to the history table. Shared verbatim by
// the member-initiated route below and the scheduled population re-analysis in
// phase 6, so a scheduled tier is always comparable to a session tier.
async function analyzeAndRecord(profile, cycle) {
  const risk = computeMemberRisk(profile);
  const previous = await getPreviousRisk(profile.session_token);
  const continuity = buildContinuity(previous, risk);

  await pool.query(
    `INSERT INTO member_risk_history
       (session_token, cprs, risk_tier, dimensions, interaction_count, cycle)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      profile.session_token,
      risk.cprs,
      risk.risk_tier,
      JSON.stringify(risk.dimensions || {}),
      risk.drug_interactions.length + risk.supplement_food_findings.length,
      cycle || 'session',
    ]
  );
  await pool.query(
    `UPDATE member_profiles SET last_analyzed_at = NOW() WHERE session_token = $1`,
    [profile.session_token]
  );

  return { risk, continuity, previous };
}

// ── Member routes ───────────────────────────────────────────────────────────

// Mints an anonymous session. Optionally associates it with a partner via that
// partner's enrollment code — the only link between a member and a health plan,
// and still not an identifier of the member.
app.post('/api/member/session', rejectPhi, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  try {
    let partnerId = null;
    let partnerName = null;
    const code = req.body && req.body.enrollmentCode;
    if (code) {
      const { rows } = await pool.query(
        `SELECT id, organization FROM partner_accounts WHERE enrollment_code = $1`,
        [String(code)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Unknown enrollment code' });
      partnerId = rows[0].id;
      partnerName = rows[0].organization;
    }

    const token = mintSessionToken();
    await pool.query(
      `INSERT INTO member_profiles (session_token, partner_id) VALUES ($1, $2)`,
      [token, partnerId]
    );
    // Consent row starts with both tiers false — nothing is persisted or shared
    // until the member affirmatively grants each one (phase 4).
    await pool.query(
      `INSERT INTO member_consents (session_token) VALUES ($1)`,
      [token]
    );

    res.status(201).json({
      sessionToken: token,
      partner: partnerId ? { id: partnerId, organization: partnerName } : null,
      consent: { tier1_persist: false, tier2_share: false },
      notice: 'Store this token client-side. It is the only handle on this profile and cannot be recovered.',
    });
  } catch (e) {
    console.error('[MEMBER] session create failed:', e.message);
    res.status(500).json({ error: 'Could not create member session' });
  }
});

app.get('/api/member/profile', resolveMember, async (req, res) => {
  const m = req.member;
  try {
    const latest = await getPreviousRisk(m.session_token);
    res.json({
      sessionToken: m.session_token,
      partnerId: m.partner_id,
      profile: {
        medications: m.medications || [],
        supplements: m.supplements || [],
        food_factors: m.food_factors || [],
      },
      consent: {
        tier1_persist: !!m.tier1_persist_granted,
        tier2_share: !!m.tier2_share_granted,
      },
      created_at: m.created_at,
      updated_at: m.updated_at,
      last_analyzed_at: m.last_analyzed_at,
      latest_risk: latest || null,
    });
  } catch (e) {
    console.error('[MEMBER] profile read failed:', e.message);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

// step 1306 write path. rejectPhi runs before requireTier1 so an attempt to
// store a personal identifier is refused on its own terms, not merely gated.
app.put('/api/member/profile', rejectPhi, resolveMember, requireTier1, async (req, res) => {
  try {
    const medications = normalizeSubstanceList(req.body.medications);
    const supplements = normalizeSubstanceList(req.body.supplements);
    const foodFactors = normalizeSubstanceList(req.body.food_factors || req.body.foodFactors);

    const { rows } = await pool.query(
      `UPDATE member_profiles
          SET medications = $2, supplements = $3, food_factors = $4, updated_at = NOW()
        WHERE session_token = $1
        RETURNING medications, supplements, food_factors, updated_at`,
      [
        req.sessionToken,
        JSON.stringify(medications),
        JSON.stringify(supplements),
        JSON.stringify(foodFactors),
      ]
    );

    res.json({ ok: true, profile: rows[0] });
  } catch (e) {
    console.error('[MEMBER] profile write failed:', e.message);
    res.status(500).json({ error: 'Could not save profile' });
  }
});

// Full erasure. Cascades to consents; history and outreach rows are removed
// explicitly since they are keyed by token rather than by foreign key.
app.delete('/api/member/profile', resolveMember, async (req, res) => {
  try {
    await pool.query(`DELETE FROM member_risk_history WHERE session_token = $1`, [req.sessionToken]);
    await pool.query(`DELETE FROM outreach_events WHERE session_token = $1`, [req.sessionToken]);
    await pool.query(`DELETE FROM member_consent_events WHERE session_token = $1`, [req.sessionToken]);
    await pool.query(`DELETE FROM member_profiles WHERE session_token = $1`, [req.sessionToken]);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[MEMBER] profile delete failed:', e.message);
    res.status(500).json({ error: 'Could not delete profile' });
  }
});

// steps 1308 + 1310 on demand — called by the client at session initialisation.
app.post('/api/member/analyze', resolveMember, requireTier1, async (req, res) => {
  try {
    const { risk, continuity } = await analyzeAndRecord(req.member, 'session');
    res.json({ ok: true, risk, continuity });
  } catch (e) {
    console.error('[MEMBER] analyze failed:', e.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// Longitudinal series for the member's own view.
app.get('/api/member/history', resolveMember, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cprs, risk_tier, interaction_count, cycle, computed_at
         FROM member_risk_history
        WHERE session_token = $1
        ORDER BY computed_at DESC
        LIMIT 50`,
      [req.sessionToken]
    );
    res.json({ sessionToken: req.sessionToken, history: rows });
  } catch (e) {
    console.error('[MEMBER] history failed:', e.message);
    res.status(500).json({ error: 'Could not load history' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 · PHASE 4: TWO-TIER CONSENT FLOW
// ════════════════════════════════════════════════════════════════════════════
// Spec FIG. 13 steps 1302, 1304 and 1314.
//
//   Tier 1 — authorises local persistence of the medication profile.
//   Tier 2 — authorises outbound transmission of derived risk data to a
//            licensed health plan partner. Separate and independently
//            revocable.
//
// The two properties the specification actually turns on:
//
//   1. Tier 2 status NEVER affects persistence. Granting, withholding or
//      revoking tier 2 leaves member_profiles completely untouched, so a member
//      gets longitudinal tracking without ever sharing anything.
//
//   2. Revoking tier 2 suppresses the member from the partner feed
//      automatically, as a property of the architecture rather than an
//      administrative step. That is why the phase 5 feed query filters on
//      tier2_share_granted inside the SQL that selects feed rows: there is no
//      code path that can emit a record for a member whose tier 2 consent is
//      currently false, and no batch job that has to remember to exclude them.
//
// Direction of dependency, which the spec leaves to the implementation:
//   - Tier 2 may only be granted while tier 1 stands — there is nothing to
//     transmit from an unpersisted profile.
//   - Revoking tier 1 withdraws authorisation to hold the data at all, so the
//     persisted lists and derived history are purged, and tier 2 is revoked
//     with it (recorded as its own audit event). Both movements are toward
//     less data retention and less sharing.
// ════════════════════════════════════════════════════════════════════════════

async function readConsent(sessionToken) {
  const { rows } = await pool.query(
    `SELECT * FROM member_consents WHERE session_token = $1`,
    [sessionToken]
  );
  return rows[0] || null;
}

async function recordConsentEvent(sessionToken, tier, action) {
  await pool.query(
    `INSERT INTO member_consent_events (session_token, tier, action) VALUES ($1, $2, $3)`,
    [sessionToken, tier, action]
  );
}

function shapeConsent(row) {
  if (!row) return null;
  return {
    tier1_persist: {
      granted: !!row.tier1_persist_granted,
      granted_at: row.tier1_granted_at,
      revoked_at: row.tier1_revoked_at,
      authorizes: 'Persistence of your medication, supplement and food list against an anonymous token.',
    },
    tier2_share: {
      granted: !!row.tier2_share_granted,
      granted_at: row.tier2_granted_at,
      revoked_at: row.tier2_revoked_at,
      authorizes: 'Transmission of derived interaction risk data to your health plan partner.',
      independently_revocable: true,
      revocation_effect: 'Immediately suppresses you from the partner feed. Your stored profile is not affected.',
    },
    updated_at: row.updated_at,
  };
}

app.get('/api/member/consent', resolveMember, async (req, res) => {
  try {
    const row = await readConsent(req.sessionToken);
    const { rows: events } = await pool.query(
      `SELECT tier, action, occurred_at
         FROM member_consent_events
        WHERE session_token = $1
        ORDER BY occurred_at DESC
        LIMIT 50`,
      [req.sessionToken]
    );
    res.json({ sessionToken: req.sessionToken, consent: shapeConsent(row), audit_trail: events });
  } catch (e) {
    console.error('[CONSENT] read failed:', e.message);
    res.status(500).json({ error: 'Could not load consent state' });
  }
});

app.post('/api/member/consent', rejectPhi, resolveMember, async (req, res) => {
  const tier = Number(req.body.tier);
  const granted = req.body.granted;

  if (tier !== 1 && tier !== 2) {
    return res.status(400).json({ error: 'tier must be 1 or 2' });
  }
  if (typeof granted !== 'boolean') {
    return res.status(400).json({ error: 'granted must be a boolean' });
  }

  try {
    const before = await readConsent(req.sessionToken);
    if (!before) return res.status(404).json({ error: 'No consent record for this session' });

    const currently = tier === 1 ? !!before.tier1_persist_granted : !!before.tier2_share_granted;

    // Idempotent: re-asserting the current state is a no-op and must not stamp
    // a fresh granted_at or add a spurious audit event.
    if (currently === granted) {
      const row = await readConsent(req.sessionToken);
      return res.json({ ok: true, unchanged: true, consent: shapeConsent(row) });
    }

    if (tier === 2 && granted && !before.tier1_persist_granted) {
      return res.status(409).json({
        error: 'Tier 1 consent required before Tier 2',
        detail: 'There is no persisted profile to derive shareable risk data from.',
      });
    }

    const effects = [];

    if (tier === 1) {
      if (granted) {
        await pool.query(
          `UPDATE member_consents
              SET tier1_persist_granted = TRUE, tier1_granted_at = NOW(),
                  tier1_revoked_at = NULL, updated_at = NOW()
            WHERE session_token = $1`,
          [req.sessionToken]
        );
        await recordConsentEvent(req.sessionToken, 1, 'grant');
        effects.push('Profile persistence authorised.');
      } else {
        // Authorisation to hold the data is withdrawn: purge it.
        await pool.query(
          `UPDATE member_consents
              SET tier1_persist_granted = FALSE, tier1_revoked_at = NOW(),
                  tier2_share_granted = FALSE,
                  tier2_revoked_at = CASE WHEN tier2_share_granted
                                          THEN NOW() ELSE tier2_revoked_at END,
                  updated_at = NOW()
            WHERE session_token = $1`,
          [req.sessionToken]
        );
        await recordConsentEvent(req.sessionToken, 1, 'revoke');
        if (before.tier2_share_granted) {
          await recordConsentEvent(req.sessionToken, 2, 'revoke');
          effects.push('Tier 2 sharing revoked as a consequence.');
        }
        await pool.query(
          `UPDATE member_profiles
              SET medications = '[]'::jsonb, supplements = '[]'::jsonb,
                  food_factors = '[]'::jsonb, updated_at = NOW()
            WHERE session_token = $1`,
          [req.sessionToken]
        );
        await pool.query(
          `DELETE FROM member_risk_history WHERE session_token = $1`,
          [req.sessionToken]
        );
        effects.push('Persisted medication profile and derived risk history purged.');
      }
    } else {
      if (granted) {
        await pool.query(
          `UPDATE member_consents
              SET tier2_share_granted = TRUE, tier2_granted_at = NOW(),
                  tier2_revoked_at = NULL, updated_at = NOW()
            WHERE session_token = $1`,
          [req.sessionToken]
        );
        await recordConsentEvent(req.sessionToken, 2, 'grant');
        effects.push('Partner feed transmission authorised.');
      } else {
        // Step 1314. Outbound gate only — member_profiles is deliberately not
        // touched here, which is the property the specification requires.
        await pool.query(
          `UPDATE member_consents
              SET tier2_share_granted = FALSE, tier2_revoked_at = NOW(), updated_at = NOW()
            WHERE session_token = $1`,
          [req.sessionToken]
        );
        await recordConsentEvent(req.sessionToken, 2, 'revoke');
        effects.push('Suppressed from the partner feed with immediate effect.');
        effects.push('Persisted medication profile retained and unaffected.');
      }
    }

    const after = await readConsent(req.sessionToken);
    res.json({ ok: true, tier, granted, effects, consent: shapeConsent(after) });
  } catch (e) {
    console.error('[CONSENT] update failed:', e.message);
    res.status(500).json({ error: 'Could not update consent' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 · PHASE 5: PARTNER DATA FEED API
// ════════════════════════════════════════════════════════════════════════════
// Spec FIG. 13 steps 1312, 1314 and 1316.
//
// Authentication (step 1316, "secure authenticated API endpoint"): partners are
// health plan care management SYSTEMS, not browser users, so the feed is
// authenticated with an issued API key presented as a bearer token. Keys are
// provisioned by an administrator and stored only as SHA-256 digests.
//
// Member identity: the feed emits an HMAC pseudonym, never the session token.
// The session token is the member's own credential — handing it to a partner
// would let the partner read, rewrite or delete that member's profile. The
// pseudonym is stable for a given member so a partner can track them across
// cycles, but it authenticates nothing.
//
// Consent gate (step 1314): tier2_share_granted is tested inside the SQL that
// selects feed candidates. There is no code path that can emit a record for a
// member whose tier 2 consent is currently false — revocation suppresses them
// on the very next request, with no batch job to run and nothing to remember.
// ════════════════════════════════════════════════════════════════════════════

// A changed secret silently rotates every pseudonym and breaks partner-side
// longitudinal tracking, so fall back to a value that is at least stable across
// restarts rather than to something random per boot.
const FEED_ID_SECRET = process.env.FEED_MEMBER_ID_SECRET || (() => {
  if (process.env.DATABASE_URL || process.env.CLERK_SECRET_KEY) {
    console.warn('[FEED] FEED_MEMBER_ID_SECRET not set — deriving a stable fallback. ' +
      'Set it explicitly before going to production.');
    return crypto.createHash('sha256')
      .update('intractmd-feed-v2|' + (process.env.DATABASE_URL || '') + '|' + (process.env.CLERK_SECRET_KEY || ''))
      .digest('hex');
  }
  console.warn('[FEED] No secret material available — member pseudonyms are NOT stable.');
  return crypto.randomBytes(32).toString('hex');
})();

function feedMemberId(sessionToken) {
  return crypto.createHmac('sha256', FEED_ID_SECRET).update(sessionToken).digest('hex').slice(0, 32);
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function issueApiKey() {
  // Prefixed so it is recognisable in logs and greppable in a partner's config.
  const raw = 'imd_' + crypto.randomBytes(24).toString('hex');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

// ── Administrative provisioning ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_API_KEY;
  if (!configured) {
    return res.status(503).json({ error: 'ADMIN_API_KEY is not configured on this server' });
  }
  const presented = req.get('X-Admin-Key') || '';
  // Constant-time compare; length is checked first because timingSafeEqual
  // throws on a length mismatch.
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

app.post('/api/admin/partners', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  const organization = (req.body && req.body.organization || '').trim();
  if (!organization) return res.status(400).json({ error: 'organization is required' });
  try {
    const key = issueApiKey();
    const { rows } = await pool.query(
      `INSERT INTO partner_accounts
         (organization, email, status, api_key_hash, api_key_prefix, api_key_issued_at)
       VALUES ($1, $2, 'active', $3, $4, NOW())
       RETURNING id, organization, status, enrollment_code, created_at`,
      [organization, (req.body.email || null), key.hash, key.prefix]
    );
    res.status(201).json({
      partner: rows[0],
      apiKey: key.raw,
      notice: 'This API key is shown once and is not recoverable. Store it now.',
    });
  } catch (e) {
    console.error('[ADMIN] partner create failed:', e.message);
    res.status(500).json({ error: 'Could not create partner' });
  }
});

app.get('/api/admin/partners', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  try {
    const { rows } = await pool.query(
      `SELECT id, organization, email, status, enrollment_code, api_key_prefix,
              api_key_issued_at, api_key_last_used_at, feed_enabled,
              reanalysis_enabled, reanalysis_hour_utc, reanalysis_cadence_days,
              last_reanalysis_at, created_at
         FROM partner_accounts ORDER BY id`
    );
    res.json({ partners: rows });
  } catch (e) {
    console.error('[ADMIN] partner list failed:', e.message);
    res.status(500).json({ error: 'Could not list partners' });
  }
});

app.post('/api/admin/partners/:id/rotate-key', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  try {
    const key = issueApiKey();
    const { rows } = await pool.query(
      `UPDATE partner_accounts
          SET api_key_hash = $2, api_key_prefix = $3, api_key_issued_at = NOW(),
              api_key_last_used_at = NULL
        WHERE id = $1
        RETURNING id, organization`,
      [req.params.id, key.hash, key.prefix]
    );
    if (!rows.length) return res.status(404).json({ error: 'Unknown partner' });
    res.json({
      partner: rows[0],
      apiKey: key.raw,
      notice: 'The previous key stopped working immediately.',
    });
  } catch (e) {
    console.error('[ADMIN] key rotation failed:', e.message);
    res.status(500).json({ error: 'Could not rotate key' });
  }
});

// ── Partner authentication ──────────────────────────────────────────────────
async function partnerAuth(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  const header = req.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const key = bearer || req.get('X-Api-Key');
  if (!key) {
    return res.status(401).json({
      error: 'Authentication required',
      detail: 'Present your partner API key as: Authorization: Bearer <key>',
    });
  }
  try {
    // Looked up by digest, so the plaintext key is never compared in the
    // database and a dump of partner_accounts yields no usable credential.
    const { rows } = await pool.query(
      `SELECT * FROM partner_accounts WHERE api_key_hash = $1`,
      [hashApiKey(key)]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid API key' });
    const partner = rows[0];
    if (partner.status !== 'active') {
      return res.status(403).json({ error: 'Partner account is not active', status: partner.status });
    }
    req.partner = partner;
    pool.query(`UPDATE partner_accounts SET api_key_last_used_at = NOW() WHERE id = $1`, [partner.id])
      .catch(() => {});
    next();
  } catch (e) {
    console.error('[PARTNER] auth failed:', e.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ── Feed construction (step 1312) ───────────────────────────────────────────
const CLINICALLY_SIGNIFICANT = { Moderate: 2, High: 3, Critical: 4 };

// Selects the members eligible to appear in a partner's feed. The tier 2 gate
// lives here, in the candidate query itself — see step 1314 note above.
async function selectFeedCandidates(partnerId, limit, offset) {
  const { rows } = await pool.query(
    `SELECT p.session_token, p.medications, p.supplements, p.food_factors,
            p.updated_at, p.last_analyzed_at
       FROM member_profiles p
       JOIN member_consents c ON c.session_token = p.session_token
      WHERE p.partner_id = $1
        AND c.tier2_share_granted = TRUE
        AND c.tier1_persist_granted = TRUE
        AND jsonb_array_length(p.medications) > 0
      ORDER BY p.updated_at DESC
      LIMIT $2 OFFSET $3`,
    [partnerId, limit, offset]
  );
  return rows;
}

// Builds one structured feed record per spec: member identifier, composite
// score, risk tier, the specific supplement/food factor giving rise to the
// interaction, and the prescription medication involved.
function buildFeedRecord(profile, risk, minSeverityRank) {
  const findings = risk.supplement_food_findings.filter(
    f => (CLINICALLY_SIGNIFICANT[f.severity] || 0) >= minSeverityRank
  );
  if (!findings.length) return null;

  return {
    member_identifier: feedMemberId(profile.session_token),
    composite_risk_score: risk.cprs,
    risk_tier: risk.risk_tier,
    medication_count: risk.substance_counts.medications,
    supplement_food_interactions: findings.map(f => ({
      substance: f.substance,
      substance_category: f.category,
      interacting_medication: f.medication,
      severity: f.severity,
      mechanism: f.mechanism,
      recommended_action: f.action,
    })),
    highest_severity: findings.reduce(
      (worst, f) => (tierRank(f.severity) > tierRank(worst) ? f.severity : worst),
      'Minimal'
    ),
    drug_drug_interaction_count: risk.drug_interactions.length,
    profile_updated_at: profile.updated_at,
    last_analyzed_at: profile.last_analyzed_at,
  };
}

app.get('/api/partner/feed', partnerAuth, async (req, res) => {
  if (!req.partner.feed_enabled) {
    return res.status(403).json({ error: 'Feed is disabled for this partner account' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const minSeverity = req.query.minSeverity || 'Moderate';
  const minSeverityRank = CLINICALLY_SIGNIFICANT[minSeverity] || CLINICALLY_SIGNIFICANT.Moderate;

  try {
    const candidates = await selectFeedCandidates(req.partner.id, limit, offset);

    // Scored from the pre-computed caches (spec FIG. 11) — no AI call, so a
    // whole page of members costs only local cache reads.
    const records = [];
    for (const profile of candidates) {
      const risk = computeMemberRisk(profile);
      const record = buildFeedRecord(profile, risk, minSeverityRank);
      // Spec 1312: a member appears only if at least one supplement or food
      // factor in their own profile interacts with one of their own
      // medications. Consented members with no such finding are not emitted.
      if (record) records.push(record);
    }

    res.json({
      partner: { id: req.partner.id, organization: req.partner.organization },
      generated_at: new Date().toISOString(),
      criteria: {
        consent: 'Tier 2 sharing consent currently granted',
        minimum_severity: minSeverity,
        inclusion: 'At least one supplement or food factor interacting with a prescription medication in the same profile',
      },
      paging: { limit, offset, candidates_scanned: candidates.length, records_returned: records.length },
      records,
    });
  } catch (e) {
    console.error('[FEED] generation failed:', e.message);
    res.status(500).json({ error: 'Feed generation failed' });
  }
});

// Population-level aggregation across the consented cohort.
app.get('/api/partner/feed/stats', partnerAuth, async (req, res) => {
  try {
    const { rows: counts } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.tier1_persist_granted)                          AS persisted,
         COUNT(*) FILTER (WHERE c.tier2_share_granted)                            AS sharing,
         COUNT(*) FILTER (WHERE c.tier1_persist_granted AND NOT c.tier2_share_granted) AS suppressed
       FROM member_profiles p
       JOIN member_consents c ON c.session_token = p.session_token
      WHERE p.partner_id = $1`,
      [req.partner.id]
    );

    const candidates = await selectFeedCandidates(req.partner.id, 500, 0);
    const tierCounts = {};
    const substanceCounts = {};
    const medicationCounts = {};
    let withFindings = 0;

    for (const profile of candidates) {
      const risk = computeMemberRisk(profile);
      const findings = risk.supplement_food_findings.filter(
        f => (CLINICALLY_SIGNIFICANT[f.severity] || 0) >= CLINICALLY_SIGNIFICANT.Moderate
      );
      if (!findings.length) continue;
      withFindings++;
      tierCounts[risk.risk_tier] = (tierCounts[risk.risk_tier] || 0) + 1;
      for (const f of findings) {
        substanceCounts[f.substance] = (substanceCounts[f.substance] || 0) + 1;
        medicationCounts[f.medication] = (medicationCounts[f.medication] || 0) + 1;
      }
    }

    const top = (obj) => Object.entries(obj)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, members]) => ({ name, members }));

    res.json({
      partner: { id: req.partner.id, organization: req.partner.organization },
      generated_at: new Date().toISOString(),
      population: {
        profiles_persisted: Number(counts[0].persisted),
        sharing_consent_granted: Number(counts[0].sharing),
        suppressed_by_consent: Number(counts[0].suppressed),
        included_in_feed: withFindings,
      },
      risk_tier_distribution: tierCounts,
      top_supplements_and_foods: top(substanceCounts),
      top_implicated_medications: top(medicationCounts),
      note: 'Aggregated over at most 500 consented members per call.',
    });
  } catch (e) {
    console.error('[FEED] stats failed:', e.message);
    res.status(500).json({ error: 'Stats generation failed' });
  }
});

// The code a partner distributes so member sessions associate with their feed.
app.get('/api/partner/enrollment', partnerAuth, async (req, res) => {
  res.json({
    partner: { id: req.partner.id, organization: req.partner.organization },
    enrollment_code: req.partner.enrollment_code,
    usage: 'POST /api/member/session {"enrollmentCode":"<code>"}',
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD v2 · PHASE 6: SCHEDULED POPULATION RE-ANALYSIS
// ════════════════════════════════════════════════════════════════════════════
// Spec FIG. 13 steps 1318, 1320, 1322 and 1324.
//
// step 1318  Population-level re-analysis on a PARTNER-CONFIGURED schedule,
//            not in response to a member session. Reuses analyzeAndRecord() so
//            a scheduled tier is computed identically to a session tier and the
//            two are directly comparable.
//
// step 1320  DELTA TRIGGER. An outreach package is generated if and only if the
//            member's risk tier moved UPWARD against the prior cycle. Unchanged
//            or improved members generate nothing. This is the whole point of
//            the design — it holds outreach volume down and keeps every outreach
//            event clinically meaningful — so the condition is enforced in one
//            place and short-circuits before any generation work happens.
//
// step 1322  Per-partner brand configuration object.
//
// step 1324  The brand object is inserted INTO the prompt before submission, so
//            the model writes the plan's identity, tone and escalation pathway
//            throughout the output. There is deliberately no post-generation
//            find-and-replace of brand tokens.
//
// Re-analysis covers every tier-1 member of the partner, because recomputing a
// member's own longitudinal risk is a tier-1 activity. Partner-branded outreach
// is additionally gated on tier 2, since that is outbound partner involvement.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_BRAND = {
  organization_name: 'your health plan',
  member_services_contact: 'your plan member services line',
  clinical_escalation_pathway: 'Advise the member to contact their prescriber or pharmacist.',
  tone_profile: 'warm, professional, plain-language',
  language: 'en',
};

async function getBrandConfig(partnerId) {
  const { rows } = await pool.query(
    `SELECT b.*, p.organization
       FROM partner_accounts p
       LEFT JOIN partner_brand_configs b ON b.partner_id = p.id
      WHERE p.id = $1`,
    [partnerId]
  );
  const row = rows[0] || {};
  return {
    organization_name: row.organization_name || row.organization || DEFAULT_BRAND.organization_name,
    member_services_contact: row.member_services_contact || DEFAULT_BRAND.member_services_contact,
    clinical_escalation_pathway: row.clinical_escalation_pathway || DEFAULT_BRAND.clinical_escalation_pathway,
    tone_profile: row.tone_profile || DEFAULT_BRAND.tone_profile,
    language: row.language || DEFAULT_BRAND.language,
    configured: !!row.partner_id,
  };
}

// step 1324. The brand object is part of the instruction the model receives —
// not a set of tokens swapped into its output afterwards.
function buildBrandedOutreachPrompt(brand, continuity, findings, ddInteractions) {
  const sf = findings.slice(0, 6).map(f =>
    '- ' + f.substance + ' (' + f.category + ') with ' + f.medication +
    ' — severity ' + f.severity + (f.mechanism ? '. ' + f.mechanism : '')
  ).join('\n') || 'None identified.';

  const dd = ddInteractions.slice(0, 5).map(i =>
    '- ' + i.drug_a + ' + ' + i.drug_b + ' — severity ' + i.severity +
    (i.mechanism ? '. ' + i.mechanism : '')
  ).join('\n') || 'None identified.';

  return `You are a clinical pharmacist writing member outreach on behalf of the health plan described below.

HEALTH PLAN BRAND PROFILE — write AS this organisation. Its identity, tone and
escalation pathway must be carried throughout every message you generate. Do not
leave placeholders or bracketed tokens for any of these values; write them in
naturally as you compose.
  Organisation: ${brand.organization_name}
  Member services contact: ${brand.member_services_contact}
  Clinical escalation pathway: ${brand.clinical_escalation_pathway}
  Tone profile: ${brand.tone_profile}
  Language: ${brand.language === 'es' ? 'Spanish (español)' : 'English'}

WHY THIS MEMBER IS BEING CONTACTED NOW
Their medication interaction risk tier rose from ${continuity.previous_tier} to ${continuity.current_tier} at the latest review. Outreach is triggered only by such an increase.

SUPPLEMENT AND FOOD INTERACTIONS FOUND IN THEIR OWN PROFILE:
${sf}

DRUG-DRUG INTERACTIONS IN THEIR REGIMEN:
${dd}

WRITING RULES — follow exactly:
- The member is ANONYMOUS. You have no name, age, or any personal detail, and you must not invent one. Open with a neutral greeting appropriate to ${brand.organization_name}.
- Name each specific supplement or food and the medication it interacts with.
- Never print a numeric risk score, a risk tier label, or clinical jargon such as CPRS, polypharmacy, or pharmacokinetic.
- Be specific and action-oriented about what to do next, routing the member through the escalation pathway above.
- Warm and encouraging, never alarming.

Generate THREE versions:
1. EMAIL — 150-200 words including a subject line
2. SMS — 160 characters maximum
3. CASE_MANAGER_SCRIPT — talking points for a phone call

Return ONLY valid JSON:
{"email":{"subject":"<subject>","body":"<body>"},"sms":{"body":"<max 160 chars>"},"case_manager_script":{"opening":"<line>","key_points":["<p1>","<p2>","<p3>"],"closing":"<line>"}}`;
}

async function generateOutreachPackage(brand, continuity, findings, ddInteractions) {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) return { status: 'skipped', error: 'ANTHROPIC_API_KEY not configured', package: null };
  try {
    const prompt = buildBrandedOutreachPrompt(brand, continuity, findings, ddInteractions);
    const raw = await callClaude(k, prompt, 1800, brand.language);
    const parsed = tryParseJSON(raw);
    if (!parsed || !parsed.email) {
      return { status: 'failed', error: 'Model returned unparseable output', package: null };
    }
    parsed.brand_applied = {
      organization_name: brand.organization_name,
      language: brand.language,
      injected_into_prompt: true,
    };
    return { status: 'generated', error: null, package: parsed };
  } catch (e) {
    return { status: 'failed', error: e.message, package: null };
  }
}

// One partner may only have one cycle in flight at a time.
const reanalysisInFlight = new Set();

async function runReanalysisForPartner(partner, trigger) {
  if (!pool) return { skipped: true, reason: 'no database' };
  if (reanalysisInFlight.has(partner.id)) {
    return { skipped: true, reason: 'a re-analysis for this partner is already running' };
  }
  reanalysisInFlight.add(partner.id);

  const { rows: runRows } = await pool.query(
    `INSERT INTO reanalysis_runs (partner_id, trigger) VALUES ($1, $2) RETURNING id, started_at`,
    [partner.id, trigger || 'scheduled']
  );
  const runId = runRows[0].id;

  let analyzed = 0, upgrades = 0, generated = 0;
  const upgradedMembers = [];

  try {
    const { rows: members } = await pool.query(
      `SELECT p.*, c.tier2_share_granted
         FROM member_profiles p
         JOIN member_consents c ON c.session_token = p.session_token
        WHERE p.partner_id = $1
          AND c.tier1_persist_granted = TRUE
          AND jsonb_array_length(p.medications) > 0`,
      [partner.id]
    );

    const brand = await getBrandConfig(partner.id);

    for (const member of members) {
      const { risk, continuity } = await analyzeAndRecord(member, 'scheduled');
      analyzed++;

      // ── step 1320: the delta gate ──────────────────────────────────────
      // Everything below this line is reachable ONLY on an upward tier move.
      if (continuity.direction !== 'increased') continue;
      upgrades++;

      upgradedMembers.push({
        member_identifier: feedMemberId(member.session_token),
        from_tier: continuity.previous_tier,
        to_tier: continuity.current_tier,
      });

      // Partner-branded outreach is outbound partner involvement, so it also
      // requires tier 2. The tier change is still recorded for the member.
      if (!member.tier2_share_granted) continue;

      const { rows: evRows } = await pool.query(
        `INSERT INTO outreach_events
           (session_token, partner_id, prior_tier, new_tier, prior_cprs, new_cprs, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id`,
        [
          member.session_token, partner.id,
          continuity.previous_tier, continuity.current_tier,
          continuity.previous_cprs, continuity.current_cprs,
        ]
      );
      const eventId = evRows[0].id;

      const result = await generateOutreachPackage(
        brand, continuity, risk.supplement_food_findings, risk.drug_interactions
      );
      await pool.query(
        `UPDATE outreach_events SET package = $2, status = $3, error = $4 WHERE id = $1`,
        [eventId, result.package ? JSON.stringify(result.package) : null, result.status, result.error]
      );
      if (result.status === 'generated') generated++;
    }

    await pool.query(
      `UPDATE reanalysis_runs
          SET status = 'complete', finished_at = NOW(), members_analyzed = $2,
              tier_upgrades = $3, outreach_generated = $4
        WHERE id = $1`,
      [runId, analyzed, upgrades, generated]
    );
    await pool.query(
      `UPDATE partner_accounts SET last_reanalysis_at = NOW() WHERE id = $1`,
      [partner.id]
    );

    console.log('[REANALYSIS] partner=' + partner.id + ' analyzed=' + analyzed +
      ' upgrades=' + upgrades + ' outreach=' + generated);

    return {
      run_id: runId, trigger: trigger || 'scheduled',
      members_analyzed: analyzed, tier_upgrades: upgrades,
      outreach_generated: generated, upgraded_members: upgradedMembers,
    };
  } catch (e) {
    console.error('[REANALYSIS] partner=' + partner.id + ' failed:', e.message);
    await pool.query(
      `UPDATE reanalysis_runs SET status = 'failed', finished_at = NOW(), error = $2,
              members_analyzed = $3, tier_upgrades = $4, outreach_generated = $5
        WHERE id = $1`,
      [runId, e.message, analyzed, upgrades, generated]
    ).catch(() => {});
    throw e;
  } finally {
    reanalysisInFlight.delete(partner.id);
  }
}

// ── step 1318: the scheduler ────────────────────────────────────────────────
// Ticks every five minutes and runs any partner whose configured UTC hour has
// arrived and whose cadence has elapsed. The cadence test doubles as the
// guard against running twice inside the same hour window.
async function runDueReanalyses() {
  if (!pool) return;
  try {
    const hour = new Date().getUTCHours();
    const { rows: due } = await pool.query(
      `SELECT * FROM partner_accounts
        WHERE reanalysis_enabled = TRUE
          AND status = 'active'
          AND reanalysis_hour_utc = $1
          AND (last_reanalysis_at IS NULL
               OR last_reanalysis_at < NOW() - (reanalysis_cadence_days || ' days')::interval)`,
      [hour]
    );
    for (const partner of due) {
      try {
        await runReanalysisForPartner(partner, 'scheduled');
      } catch (e) {
        // One partner's failure must not stop the others.
        console.error('[REANALYSIS] scheduled run failed for partner', partner.id, e.message);
      }
    }
  } catch (e) {
    console.error('[REANALYSIS] scheduler tick failed:', e.message);
  }
}

setInterval(runDueReanalyses, 5 * 60 * 1000);

// ── Partner configuration routes ────────────────────────────────────────────

app.get('/api/partner/brand', partnerAuth, async (req, res) => {
  try {
    res.json({ partner_id: req.partner.id, brand: await getBrandConfig(req.partner.id) });
  } catch (e) {
    console.error('[BRAND] read failed:', e.message);
    res.status(500).json({ error: 'Could not load brand configuration' });
  }
});

app.put('/api/partner/brand', partnerAuth, async (req, res) => {
  const b = req.body || {};
  const language = b.language === 'es' ? 'es' : 'en';
  try {
    await pool.query(
      `INSERT INTO partner_brand_configs
         (partner_id, organization_name, member_services_contact,
          clinical_escalation_pathway, tone_profile, language, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (partner_id) DO UPDATE SET
         organization_name = EXCLUDED.organization_name,
         member_services_contact = EXCLUDED.member_services_contact,
         clinical_escalation_pathway = EXCLUDED.clinical_escalation_pathway,
         tone_profile = EXCLUDED.tone_profile,
         language = EXCLUDED.language,
         updated_at = NOW()`,
      [
        req.partner.id,
        b.organization_name || null,
        b.member_services_contact || null,
        b.clinical_escalation_pathway || null,
        b.tone_profile || null,
        language,
      ]
    );
    res.json({ ok: true, brand: await getBrandConfig(req.partner.id) });
  } catch (e) {
    console.error('[BRAND] write failed:', e.message);
    res.status(500).json({ error: 'Could not save brand configuration' });
  }
});

app.get('/api/partner/schedule', partnerAuth, (req, res) => {
  res.json({
    partner_id: req.partner.id,
    schedule: {
      enabled: req.partner.reanalysis_enabled,
      hour_utc: req.partner.reanalysis_hour_utc,
      cadence_days: req.partner.reanalysis_cadence_days,
      last_run_at: req.partner.last_reanalysis_at,
    },
  });
});

app.put('/api/partner/schedule', partnerAuth, async (req, res) => {
  const b = req.body || {};
  const hour = b.hour_utc === undefined ? req.partner.reanalysis_hour_utc : parseInt(b.hour_utc, 10);
  const cadence = b.cadence_days === undefined
    ? req.partner.reanalysis_cadence_days : parseInt(b.cadence_days, 10);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return res.status(400).json({ error: 'hour_utc must be an integer 0-23' });
  }
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > 365) {
    return res.status(400).json({ error: 'cadence_days must be an integer 1-365' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE partner_accounts
          SET reanalysis_enabled = COALESCE($2, reanalysis_enabled),
              reanalysis_hour_utc = $3, reanalysis_cadence_days = $4
        WHERE id = $1
        RETURNING reanalysis_enabled, reanalysis_hour_utc,
                  reanalysis_cadence_days, last_reanalysis_at`,
      [
        req.partner.id,
        typeof b.enabled === 'boolean' ? b.enabled : null,
        hour, cadence,
      ]
    );
    res.json({ ok: true, schedule: rows[0] });
  } catch (e) {
    console.error('[SCHEDULE] write failed:', e.message);
    res.status(500).json({ error: 'Could not save schedule' });
  }
});

// Manual trigger — same code path as the scheduled run.
app.post('/api/partner/reanalysis/run', partnerAuth, async (req, res) => {
  try {
    const result = await runReanalysisForPartner(req.partner, 'manual');
    if (result.skipped) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[REANALYSIS] manual run failed:', e.message);
    res.status(500).json({ error: 'Re-analysis failed', detail: e.message });
  }
});

app.get('/api/partner/reanalysis/runs', partnerAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, trigger, status, members_analyzed, tier_upgrades,
              outreach_generated, error, started_at, finished_at
         FROM reanalysis_runs
        WHERE partner_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [req.partner.id]
    );
    res.json({ partner_id: req.partner.id, runs: rows });
  } catch (e) {
    console.error('[REANALYSIS] run history failed:', e.message);
    res.status(500).json({ error: 'Could not load run history' });
  }
});

// Delta-triggered outreach packages. Member identity is pseudonymised here for
// exactly the same reason it is in the feed.
app.get('/api/partner/outreach', partnerAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const { rows } = await pool.query(
      `SELECT id, session_token, prior_tier, new_tier, prior_cprs, new_cprs,
              package, status, error, created_at
         FROM outreach_events
        WHERE partner_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.partner.id, limit]
    );
    res.json({
      partner_id: req.partner.id,
      trigger_rule: 'Generated only on an upward risk tier change (spec step 1320).',
      events: rows.map(r => ({
        id: r.id,
        member_identifier: feedMemberId(r.session_token),
        prior_tier: r.prior_tier,
        new_tier: r.new_tier,
        prior_cprs: r.prior_cprs,
        new_cprs: r.new_cprs,
        status: r.status,
        error: r.error,
        package: r.package,
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    console.error('[OUTREACH] list failed:', e.message);
    res.status(500).json({ error: 'Could not load outreach events' });
  }
});

console.log('[STARTUP] Middleware configured');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Root
app.get('/', (req, res) => {
  const fs_=require('fs'),pf=path.join(__dirname,'public','index.prod.html'),df=path.join(__dirname,'public','index.src.html');res.sendFile(fs_.existsSync(pf)?pf:df);
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
  if (meds + foods.length < 1) return res.status(400).json({ error: 'At least 1 medication/supplement required' });

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
// ── AUTHORITATIVE IMPRINT TABLE ─────────────────────────────────────────────
// Hardcoded for NTI and high-risk drugs. AI/cache are unreliable for these.
// Sources: FDA Orange Book, NLM DailyMed, manufacturer labeling.
const AUTH_IMPRINTS = {
  // ANTICOAGULANTS
  'COUMADIN1':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'1 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Pink round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN2':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'2 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Lavender round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN25':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'2.5 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Green round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN3':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'3 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Tan round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN4':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'4 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Blue round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN5':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'5 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Peach oval tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN6':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'6 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Teal round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN75':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'7.5 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. Yellow round tablet.','labeler':'Bristol-Myers Squibb'},
  'COUMADIN10':{'drug_name':'Coumadin','generic_name':'warfarin sodium','strength':'10 mg','drug_class':'Anticoagulant (NTI)','note':'NTI drug — anticoagulant. White round tablet.','labeler':'Bristol-Myers Squibb'},
  // CARDIAC GLYCOSIDES
  'Y3B':{'drug_name':'Lanoxin','generic_name':'digoxin','strength':'0.125 mg','drug_class':'Cardiac Glycoside (NTI)','note':'NTI drug — digoxin. Yellow round tablet. Toxic range close to therapeutic range.','labeler':'Covis Pharma'},
  'X3A':{'drug_name':'Lanoxin','generic_name':'digoxin','strength':'0.25 mg','drug_class':'Cardiac Glycoside (NTI)','note':'NTI drug — digoxin. White round tablet.','labeler':'Covis Pharma'},
  'LANOXIN125':{'drug_name':'Lanoxin','generic_name':'digoxin','strength':'0.125 mg','drug_class':'Cardiac Glycoside (NTI)','note':'NTI drug — digoxin. Yellow round tablet.','labeler':'Covis Pharma'},
  'LANOXIN25':{'drug_name':'Lanoxin','generic_name':'digoxin','strength':'0.25 mg','drug_class':'Cardiac Glycoside (NTI)','note':'NTI drug — digoxin. White round tablet.','labeler':'Covis Pharma'},
  // THYROID
  'ML3':{'drug_name':'Levothyroxine','generic_name':'levothyroxine sodium','strength':'50 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug — levothyroxine 50mcg. White round tablet.','labeler':'Mylan'},
  'SYNTHROID25':{'drug_name':'Synthroid','generic_name':'levothyroxine sodium','strength':'25 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug. Orange round tablet.','labeler':'AbbVie'},
  'SYNTHROID50':{'drug_name':'Synthroid','generic_name':'levothyroxine sodium','strength':'50 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug. White round tablet.','labeler':'AbbVie'},
  'SYNTHROID75':{'drug_name':'Synthroid','generic_name':'levothyroxine sodium','strength':'75 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug. Violet round tablet.','labeler':'AbbVie'},
  'SYNTHROID88':{'drug_name':'Synthroid','generic_name':'levothyroxine sodium','strength':'88 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug. Olive round tablet.','labeler':'AbbVie'},
  'SYNTHROID100':{'drug_name':'Synthroid','generic_name':'levothyroxine sodium','strength':'100 mcg','drug_class':'Thyroid Hormone (NTI)','note':'NTI drug. Yellow round tablet.','labeler':'AbbVie'},
  // ANTICONVULSANTS
  'PD362':{'drug_name':'Dilantin Kapseals','generic_name':'phenytoin sodium','strength':'100 mg','drug_class':'Anticonvulsant (NTI)','note':'NTI drug — phenytoin. White/orange capsule. Saturation kinetics — small dose changes cause toxicity.','labeler':'Pfizer'},
  'PD365':{'drug_name':'Dilantin Infatabs','generic_name':'phenytoin','strength':'50 mg','drug_class':'Anticonvulsant (NTI)','note':'NTI drug — phenytoin. Triangular chewable tablet.','labeler':'Pfizer'},
  'TEGRETOL200':{'drug_name':'Tegretol','generic_name':'carbamazepine','strength':'200 mg','drug_class':'Anticonvulsant (NTI)','note':'NTI drug — carbamazepine. Pink round tablet.','labeler':'Novartis'},
  'TEGRETOL100':{'drug_name':'Tegretol','generic_name':'carbamazepine','strength':'100 mg','drug_class':'Anticonvulsant (NTI)','note':'NTI drug — carbamazepine. White round tablet.','labeler':'Novartis'},
  // IMMUNOSUPPRESSANTS
  'CSA100':{'drug_name':'Neoral','generic_name':'cyclosporine','strength':'100 mg','drug_class':'Immunosuppressant (NTI)','note':'NTI drug — cyclosporine. Oblong soft gel. Brand and generic NOT interchangeable.','labeler':'Novartis'},
  'CSA25':{'drug_name':'Neoral','generic_name':'cyclosporine','strength':'25 mg','drug_class':'Immunosuppressant (NTI)','note':'NTI drug — cyclosporine. Oblong soft gel.','labeler':'Novartis'},
  // LITHIUM
  'LITHIUM300':{'drug_name':'Lithium Carbonate','generic_name':'lithium carbonate','strength':'300 mg','drug_class':'Mood Stabilizer (NTI)','note':'NTI drug — lithium. Gray capsule. Toxic range very close to therapeutic range.','labeler':'Various'},
  'LITHIUMCARBONATE300':{'drug_name':'Lithium Carbonate','generic_name':'lithium carbonate','strength':'300 mg','drug_class':'Mood Stabilizer (NTI)','note':'NTI drug — lithium. Gray capsule.','labeler':'Various'},
  // METHOTREXATE
  'MTX25':{'drug_name':'Methotrexate','generic_name':'methotrexate','strength':'2.5 mg','drug_class':'Antimetabolite (NTI)','note':'NTI drug — WEEKLY DOSING ONLY. Daily dosing is fatal. Yellow round tablet.','labeler':'Various'},
  'METHOTREXATE25':{'drug_name':'Methotrexate','generic_name':'methotrexate','strength':'2.5 mg','drug_class':'Antimetabolite (NTI)','note':'NTI drug — WEEKLY DOSING ONLY. Yellow round tablet.','labeler':'Various'},
  // COMMON HIGH-RISK
  'BI72':{'drug_name':'Toprol-XL','generic_name':'metoprolol succinate','strength':'50 mg','drug_class':'Beta Blocker','note':'White oval ER tablet. Succinate NOT interchangeable with tartrate.','labeler':'AstraZeneca'},
  'MSD952':{'drug_name':'Cozaar','generic_name':'losartan potassium','strength':'50 mg','drug_class':'ARB (Angiotensin Receptor Blocker)','note':'White oval tablet.','labeler':'Merck'},
  'BMS5':{'drug_name':'Eliquis','generic_name':'apixaban','strength':'5 mg','drug_class':'Anticoagulant (DOAC)','note':'Gold oval tablet. Direct oral anticoagulant — bleeding risk. Do not stop without consulting physician.','labeler':'Bristol-Myers Squibb/Pfizer'},
  'BMS25':{'drug_name':'Eliquis','generic_name':'apixaban','strength':'2.5 mg','drug_class':'Anticoagulant (DOAC)','note':'Yellow oval tablet. Direct oral anticoagulant.','labeler':'Bristol-Myers Squibb/Pfizer'},
  'PD15620':{'drug_name':'Lipitor','generic_name':'atorvastatin calcium','strength':'20 mg','drug_class':'Statin','note':'White elliptical tablet.','labeler':'Pfizer'},
  'PD15640':{'drug_name':'Lipitor','generic_name':'atorvastatin calcium','strength':'40 mg','drug_class':'Statin','note':'White elliptical tablet.','labeler':'Pfizer'},
  'PD15680':{'drug_name':'Lipitor','generic_name':'atorvastatin calcium','strength':'80 mg','drug_class':'Statin','note':'White elliptical tablet.','labeler':'Pfizer'},
  'MSD740':{'drug_name':'Zocor','generic_name':'simvastatin','strength':'20 mg','drug_class':'Statin','note':'Tan oval tablet. High CYP3A4 interaction risk.','labeler':'Merck'},
  'MSD735':{'drug_name':'Zocor','generic_name':'simvastatin','strength':'40 mg','drug_class':'Statin','note':'Tan oval tablet.','labeler':'Merck'},
  'LUPIN10':{'drug_name':'Lisinopril','generic_name':'lisinopril','strength':'10 mg','drug_class':'ACE Inhibitor','note':'Pink round tablet.','labeler':'Lupin'},
  'MYLAN216':{'drug_name':'Hydrochlorothiazide','generic_name':'hydrochlorothiazide','strength':'25 mg','drug_class':'Thiazide Diuretic','note':'White round tablet. Monitor electrolytes.','labeler':'Mylan'},
  'CIBA7':{'drug_name':'Ritalin','generic_name':'methylphenidate hydrochloride','strength':'10 mg','drug_class':'CNS Stimulant (Schedule II)','note':'Pale green round tablet. Controlled substance — Schedule II.','labeler':'Novartis'},
  '9348':{'drug_name':'Naproxen','generic_name':'naproxen sodium','strength':'500 mg','drug_class':'NSAID','note':'White oval tablet. NSAID — avoid with anticoagulants.','labeler':'Teva'},
  'KU118':{'drug_name':'Omeprazole','generic_name':'omeprazole','strength':'20 mg','drug_class':'Proton Pump Inhibitor','note':'Pink/tan delayed-release capsule.','labeler':'Kremers Urban'},
  '20MGKU118':{'drug_name':'Omeprazole','generic_name':'omeprazole','strength':'20 mg','drug_class':'Proton Pump Inhibitor','note':'Pink/tan delayed-release capsule.','labeler':'Kremers Urban'},
  // OTC COMMON
  'L484':{'drug_name':'Tylenol','generic_name':'acetaminophen','strength':'500 mg','drug_class':'Analgesic/Antipyretic','note':'White oblong tablet. Most common OTC pain reliever. Max 4g/day.','labeler':'Johnson & Johnson'},
  'L':{'drug_name':'Aspirin','generic_name':'aspirin','strength':'81 mg','drug_class':'NSAID/Antiplatelet','note':'White round enteric-coated tablet. Low-dose aspirin for cardiac/stroke prevention.','labeler':'Various'},
  'ADVIL':{'drug_name':'Advil','generic_name':'ibuprofen','strength':'200 mg','drug_class':'NSAID','note':'Brown oval tablet. OTC NSAID.','labeler':'Pfizer Consumer'},
  // CONTROLLED SUBSTANCES
  'IP110':{'drug_name':'Norco 10/325','generic_name':'hydrocodone bitartrate / acetaminophen','strength':'10 mg / 325 mg','drug_class':'Opioid Analgesic (Schedule II)','note':'White oblong tablet. Controlled substance — opioid. High abuse potential.','labeler':'Amneal'},
  'M357':{'drug_name':'Hydrocodone/APAP','generic_name':'hydrocodone bitartrate / acetaminophen','strength':'5 mg / 500 mg','drug_class':'Opioid Analgesic (Schedule II)','note':'White oblong tablet. Controlled substance — opioid.','labeler':'Mallinckrodt'},
  'AN627':{'drug_name':'Ultram','generic_name':'tramadol hydrochloride','strength':'50 mg','drug_class':'Opioid Analgesic (Schedule IV)','note':'White round tablet. Controlled substance — Schedule IV.','labeler':'Amneal'},
  '5CDN':{'drug_name':'Oxycodone','generic_name':'oxycodone hydrochloride','strength':'5 mg','drug_class':'Opioid Analgesic (Schedule II)','note':'Round white tablet. Controlled substance — Schedule II. High abuse potential.','labeler':'Various'},
  'XANAX025':{'drug_name':'Xanax','generic_name':'alprazolam','strength':'0.25 mg','drug_class':'Benzodiazepine (Schedule IV)','note':'White oval tablet. Controlled substance.','labeler':'Pfizer'},
  'XANAX05':{'drug_name':'Xanax','generic_name':'alprazolam','strength':'0.5 mg','drug_class':'Benzodiazepine (Schedule IV)','note':'Peach oval tablet. Controlled substance.','labeler':'Pfizer'},
  'XANAX1':{'drug_name':'Xanax','generic_name':'alprazolam','strength':'1 mg','drug_class':'Benzodiazepine (Schedule IV)','note':'Blue oval tablet. Controlled substance.','labeler':'Pfizer'},
  'KLONOPIN05':{'drug_name':'Klonopin','generic_name':'clonazepam','strength':'0.5 mg','drug_class':'Benzodiazepine (Schedule IV)','note':'Orange round tablet. Controlled substance. NOT the same as clonidine (blood pressure drug).','labeler':'Roche'},
  'KLONOPIN1':{'drug_name':'Klonopin','generic_name':'clonazepam','strength':'1 mg','drug_class':'Benzodiazepine (Schedule IV)','note':'Blue round tablet. Controlled substance.','labeler':'Roche'},
  // METHOTREXATE additional imprint
  'M10':{'drug_name':'Methotrexate','generic_name':'methotrexate','strength':'2.5 mg','drug_class':'Antimetabolite (NTI)','note':'NTI drug — WEEKLY DOSING ONLY. Daily dosing is fatal. Yellow round tablet. Confirm dosing schedule with prescriber.','labeler':'Roxane/Hikma'},
  // AMBIGUOUS IMPRINTS
  'V':{'drug_name':'Multiple possibilities — see note','generic_name':'diazepam OR oxycodone OR sildenafil','strength':'Varies','drug_class':'AMBIGUOUS — requires further identification','note':'V imprint on blue oval may be: Diazepam 10mg (Valium, blue oval), Oxycodone 5mg (blue oval, Schedule II), or Sildenafil 50mg (blue diamond). Color and exact shape are critical for differentiation. Consult pharmacist.','labeler':'Multiple manufacturers'},
  // LASA PAIRS
  'HYDROXYZINE25':{'drug_name':'Vistaril','generic_name':'hydroxyzine pamoate','strength':'25 mg','drug_class':'Antihistamine / Anxiolytic','note':'White round tablet. NOT hydralazine — completely different drug. Antihistamine/anti-anxiety.','labeler':'Pfizer'},
};

function normImprint(s) {
  if (!s) return '';
  return s.toString().toUpperCase().replace(/[\s\-\.\/]+/g,'');
}

app.post('/api/pill-identify', async (req, res) => {
  const imprint     = req.body.imprint     || '';
  const shape       = req.body.shape       || 'Any';
  const color1      = req.body.color1      || req.body.color  || 'Any';
  const color2      = req.body.color2      || '';
  const coating     = req.body.coating     || 'Any';
  const size        = req.body.size        || '';
  const description = req.body.description || '';
  const language    = req.body.language    || 'en';
  try {
    let matches = [];
    let source = 'none';
    const impKey = normImprint(imprint);

    // PRIORITY 0 — Counterfeit safety override
    if (impKey === 'M30' && (color1.toLowerCase().includes('blue') || color1 === 'Any' || !color1)) {
      return res.json({ matches:[{
        drug_name:'⚠️ POTENTIAL COUNTERFEIT — DO NOT TAKE',
        generic_name:'Unknown / Suspected Fentanyl',
        strength:'Unknown',
        confidence:'high',
        note:'M30 blue round pills are widely counterfeited with illicitly manufactured fentanyl. These pills have caused thousands of overdose deaths. DO NOT take this pill. Call Poison Control (1-800-222-1222) or 911 immediately if ingested.',
        imageUrl:'',
        labeler:'⚠️ POISON CONTROL: 1-800-222-1222',
        drug_class:'COUNTERFEIT DANGER'
      }], source:'safety_override' });
    }

    // PRIORITY 1 — Authoritative hardcoded table (100% accurate)
    if (impKey && AUTH_IMPRINTS[impKey]) {
      const a = AUTH_IMPRINTS[impKey];
      matches = [{ drug_name:a.drug_name, generic_name:a.generic_name, strength:a.strength,
        confidence:'high', note:a.note, imageUrl:a.imageUrl||'', labeler:a.labeler, drug_class:a.drug_class }];
      source = 'authoritative';
    }

    // PRIORITY 2 — Pill index cache
    if (!matches.length && imprint && pillIndex) {
      let cacheHits = pillIndex[impKey] || [];
      if (shape && shape !== 'Any') {
        const f = cacheHits.filter(m => !m.shape || m.shape.toLowerCase() === shape.toLowerCase());
        if (f.length) cacheHits = f;
      }
      if (color1 && color1 !== 'Any') {
        const f = cacheHits.filter(m => !m.colors || m.colors.some(c => c.toLowerCase().includes(color1.toLowerCase())));
        if (f.length) cacheHits = f;
      }
      if (cacheHits.length) {
        matches = cacheHits.map(m => ({
          drug_name:m.drug_name, generic_name:m.generic_name, strength:m.strength,
          confidence:'medium',
          note:[m.shape,(m.colors||[]).join('/'),m.coating].filter(Boolean).join(', '),
          imageUrl:m.imageUrl||'', labeler:m.manufacturer||'', drug_class:m.drug_class||''
        }));
        source = 'cache';
      }
    }

    // PRIORITY 2.5 — Live FDA NSDE lookup for cache misses
    if (!matches.length && imprint) {
      try {
        const enc = encodeURIComponent(imprint.trim());
        const nsdeUrl = `https://api.fda.gov/other/nsde.json?search=imprint_code:"${enc}"&limit=5`;
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 6000);
        const nsdeResp = await fetch(nsdeUrl, { signal: ctrl2.signal });
        clearTimeout(t2);
        if (nsdeResp.ok) {
          const nsdeData = await nsdeResp.json();
          if (nsdeData.results && nsdeData.results.length) {
            let hits = nsdeData.results;
            if (color1 && color1 !== 'Any') {
              const cf = hits.filter(r => r.color_text && r.color_text.toLowerCase().includes(color1.toLowerCase()));
              if (cf.length) hits = cf;
            }
            if (shape && shape !== 'Any') {
              const sf = hits.filter(r => r.shape_text && r.shape_text.toLowerCase().includes(shape.toLowerCase()));
              if (sf.length) hits = sf;
            }
            matches = hits.slice(0,3).map(r => ({
              drug_name:    r.proprietaryname || r.nonproprietaryname || 'Unknown',
              generic_name: r.nonproprietaryname || '',
              strength:     r.active_numerator_strength
                              ? r.active_numerator_strength + ' ' + (r.active_ingred_unit||'')
                              : '',
              confidence:   'high',
              note:         [r.shape_text, r.color_text, r.coating_text].filter(Boolean).join(', '),
              imageUrl:     '',
              labeler:      r.labelername || '',
              drug_class:   ''
            }));
            source = 'fda_nsde';
          }
        }
      } catch(nsdeErr) {
        console.error('[PILL] NSDE lookup error:', nsdeErr.message);
      }
    }

    // PRIORITY 3 — Claude AI fallback
    if (!matches.length) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const parts = [];
        if (imprint)                    parts.push('Imprint: ' + imprint);
        if (shape && shape!=='Any')     parts.push('Shape: ' + shape);
        if (color1 && color1!=='Any')   parts.push('Color: ' + color1);
        if (color2 && color2!=='Any')   parts.push('Secondary color: ' + color2);
        if (size)                       parts.push('Size: ' + size + 'mm');
        if (coating && coating!=='Any') parts.push('Coating: ' + coating);
        if (description)                parts.push('Description: ' + description);
        const langNote = language==='es' ? 'Description may be in Spanish — translate to identify pill. Return drug names in English.' : '';
        if (parts.length) {
          const prompt = `You are a clinical pharmacist doing pill identification. ${langNote}

RULES:
1. IMPRINT is the primary identifier — base identification on imprint first.
2. Known imprints: L484=Acetaminophen 500mg, L=Aspirin 81mg (white round EC), M357=Hydrocodone/APAP 5/500mg, IP 110=Hydrocodone/APAP 10/325mg, AN 627=Tramadol 50mg, ADVIL=Ibuprofen 200mg, V (blue oval)=Diazepam 10mg, CIBA 7=Ritalin (methylphenidate) 10mg, 93 48=Naproxen 500mg, LUPIN 10=Lisinopril 10mg, BI 72=Metoprolol succinate 50mg, MSD 952=Losartan 50mg, BMS 5=Apixaban (Eliquis) 5mg, MSD 740=Simvastatin 20mg, PD 156 20=Atorvastatin 20mg, PD 157 40=Atorvastatin 40mg, MYLAN 216=Hydrochlorothiazide 25mg, 5 CDN=Oxycodone 5mg, P-D 362=Dilantin (phenytoin) 100mg capsule, TEGRETOL 200=Carbamazepine 200mg, Y3B=Digoxin 0.125mg, M L 3=Levothyroxine 50mcg, KU 118=Omeprazole 20mg.
3. If no imprint and pill is white/round/oval: return top 3 most likely OTC drugs.
4. If no imprint and capsule: suggest it may be a supplement (vitamin, fish oil, herbal).
5. If genuinely uncertain: use confidence "low" and explain.
6. NEVER identify M30 blue round as oxycodone — it is likely counterfeit fentanyl.

Pill: ${parts.join(', ')}

Return ONLY valid JSON:
{"matches":[{"drug_name":"<brand>","generic_name":"<generic>","strength":"<dose>","confidence":"<high|medium|low>","note":"<description>","imageUrl":"","labeler":"<maker>","drug_class":"<class>"}]}
Up to 3 matches.`;
          const ctrl = new AbortController();
          const tmr = setTimeout(()=>ctrl.abort(), 12000);
          try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              signal:ctrl.signal, method:'POST',
              headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
              body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1000,messages:[{role:'user',content:prompt}]})
            });
            const d = await r.json(); clearTimeout(tmr);
            if (d.content&&d.content[0]) {
              const raw = d.content[0].text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
              const m = raw.match(/{[\s\S]*}/);
              if (m) { const p2=JSON.parse(m[0]); if (p2.matches) { matches=p2.matches; source='ai'; } }
            }
          } catch(ae){clearTimeout(tmr);console.error('[PILL] AI error:',ae.message);}
        }
      }
    }
    res.json({ matches, source });
  } catch(e) {
    console.error('[PILL] Error:', e.message);
    res.json({ matches:[], error:e.message });
  }
});
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
                const scoreMatch = fullText.match(/"risk_score"\s*:\s*(\d+)/);
                const riskMatch = fullText.match(/"overall_risk"\s*:\s*"([^"]+)"/);    
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
app.get('/deprescribing', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'deprescribing', 'index.html'));
});

// ── DEPRESCRIBING CANDIDATE RANKING (criteria-based) ─────────────────────────
//
// Replaces the CPRS-delta ranking on /api/deprescribing-analyze.
//
// WHY THE CHANGE
// --------------
// The delta ranking called /api/analyze once per removal and ranked by the drop
// in composite score. Because computeCompositeFromPairs takes the MAX per
// dimension rather than the sum, removing any drug in the dominant pair
// collapses that dimension to zero — so multiple drugs produce identical
// deltas and the ranking cannot discriminate. Observed 3 Aug 2026: a
// metformin / oxycodone / naloxone regimen returned −60 for two different
// drugs on a baseline of 60.
//
// Ranking now uses published deprescribing criteria (Beers, STOPP, CMS Star
// Ratings measures). These are peer-reviewed, periodically updated, and already
// what pharmacists use. The output is defensible by citation rather than by
// trusting an internal score. The CPRS is left untouched and is still shown as
// the current risk profile.
//
// ⚠ CLINICAL REVIEW REQUIRED
// The criteria content below must be verified by a pharmacist before pilot.
// The mechanism is sound; the completeness and wording of individual entries
// are not something to take on faith. Beers 2023 covers well over 100
// medications and classes — this map is a starting subset.

// ── Age conditionality ───────────────────────────────────────────────────────
// The AGS Beers Criteria apply to adults 65+. STOPP is likewise geriatric.
// Applying them to a 40-year-old is wrong. Where patient age is unknown the
// tool must say so rather than imply the criteria have been met.
const GERIATRIC_AGE = 65;

// ── Tiers ────────────────────────────────────────────────────────────────────
// Ordering reflects strength of the published recommendation, not our opinion.
const TIER = {
  AVOID:      { rank: 4, label: 'Avoid',              note: 'Listed as a medication to avoid' },
  CAUTION:    { rank: 3, label: 'Use with caution',   note: 'Listed with cautions or conditions' },
  INTERACTION:{ rank: 2, label: 'Interaction flag',   note: 'Flagged in combination with another drug in this regimen' },
  MEASURE:    { rank: 1, label: 'Quality measure',    note: 'Appears in a CMS Star Ratings measure' },
};

// ── Never candidates ─────────────────────────────────────────────────────────
// Rescue and antidote medications protect against the risks of other drugs in
// the regimen. Ranking naloxone as a deprescribing candidate on a regimen
// containing oxycodone is backwards and would destroy clinician trust in the
// tool. These are excluded from candidacy outright.
const NEVER_DEPRESCRIBE = new Set([
  'naloxone', 'naloxone hydrochloride', 'narcan',
  'epinephrine', 'epinephrine auto-injector', 'epipen',
  'glucagon',
  'albuterol', 'levalbuterol',            // rescue inhalers
  'nitroglycerin', 'nitrostat',           // rescue antianginal
  'diazepam rectal', 'midazolam nasal',   // rescue anticonvulsants
  'flumazenil', 'sugammadex',
  'activated charcoal', 'acetylcysteine', // antidotes
  'hydroxocobalamin', 'pralidoxime',
  'insulin', 'insulin glargine', 'insulin aspart', 'insulin lispro',
  'insulin detemir', 'insulin degludec', 'insulin human',
  'levothyroxine',                        // replacement therapy, not surplus
]);

// ── CRITERIA MAP — cite, do not quote ────────────────────────────────────────
//
// STRUCTURE AND WHY IT CHANGED
// ----------------------------
// The earlier version stored citation strings that paraphrased the rationale
// text of the AGS Beers Criteria®. AGS Beers Criteria® is a registered
// trademark, AGS has been its steward since 2010, and reproducing its
// expression in a commercial product is a licensing question rather than a
// settled one.
//
// The facts are not the issue. That benzodiazepines are associated with falls
// in older adults is established in primary literature and is not AGS's
// property. AGS's particular wording of that fact is.
//
// So each entry now separates the two:
//
//   concern  — an independently written clinical statement. Ours. Says what the
//              risk is, in our own words, from the underlying pharmacology and
//              primary evidence.
//   sources  — pointers to where the reader can find the published criteria.
//              Bibliographic citation only. No reproduced rationale text.
//
// A reader who wants the published rationale is directed to the publication.
// The tool asserts the clinical fact and names its sources; it does not
// reproduce anyone's expression of that fact.
//
// STOPP codes have been dropped entirely. The earlier version cited v2 codes
// (B5, D8, J4 …). STOPP/START v3 (2023) expanded from 80 to 133 criteria,
// renumbered them, and reorganised by drug class rather than individual drug,
// so the v2 codes were probably wrong as well as unnecessary. The source is
// cited without a code.
//
// ⚠ STILL NEEDS CLINICAL REVIEW. The clinical statements below are ours, which
// means they are ours to get wrong. A pharmacist must confirm each one is
// accurate before pilot.

// Bibliographic pointers, defined once and referenced by key.
const SOURCES = {
  // ── Explicit criteria sets — three continents, developed independently ────
  BEERS:    'AGS Beers Criteria 2023 — J Am Geriatr Soc 2023;71(7):2052–2081',
  STOPP:    'STOPP/START v3 — Eur Geriatr Med 2023;14(4):625–632',
  EU7_PIM:  'EU(7)-PIM list — Eur J Clin Pharmacol 2015;71(7):861–875 (seven-country European expert consensus)',

  // ── Deprescribing guidelines — tapering and discontinuation ───────────────
  CFP_PPI:  'Deprescribing proton pump inhibitors — Farrell et al., Can Fam Physician 2017;63:354–364',
  CFP_BZRA: 'Deprescribing benzodiazepine receptor agonists — Pottie et al., Can Fam Physician 2018;64:339–351',
  CFP_AP:   'Deprescribing antipsychotics for behavioural and psychological symptoms of dementia and insomnia — Bjerre et al., Can Fam Physician 2018;64:17–27',

  // ── US quality measures ───────────────────────────────────────────────────
  CMS_D09:  'CMS Star Ratings measure D09 — concurrent use of opioids and benzodiazepines',
  CMS_D10:  'CMS Star Ratings measure D10 — use of multiple anticholinergic medications',
};

const CRITERIA = {
  // ── Benzodiazepines ───────────────────────────────────────────────────────
  'alprazolam': { tier:'AVOID', geriatric:true,
    concern:'Benzodiazepine. Older adults clear these drugs more slowly and are more sensitive to their sedative effect, raising the risk of falls, fractures, confusion and motor impairment.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },
  'lorazepam': { tier:'AVOID', geriatric:true,
    concern:'Benzodiazepine. Older adults clear these drugs more slowly and are more sensitive to their sedative effect, raising the risk of falls, fractures, confusion and motor impairment.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },
  'clonazepam': { tier:'AVOID', geriatric:true,
    concern:'Long-acting benzodiazepine. Accumulation with repeated dosing compounds the sedation, fall and cognitive risks already elevated in older adults.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },
  'diazepam': { tier:'AVOID', geriatric:true,
    concern:'Long-acting benzodiazepine with active metabolites. Accumulates in older adults, prolonging sedation and fall risk well beyond the dosing interval.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },
  'temazepam': { tier:'AVOID', geriatric:true,
    concern:'Benzodiazepine hypnotic. Sedation carrying into the following day contributes to falls and impaired daytime function in older adults.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },

  // ── Z-hypnotics ───────────────────────────────────────────────────────────
  'zolpidem': { tier:'AVOID', geriatric:true,
    concern:'Non-benzodiazepine hypnotic acting at the same receptor. Carries a comparable profile of falls, fractures, delirium and next-day impairment despite the different chemical class.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_BZRA'] },
  'eszopiclone': { tier:'AVOID', geriatric:true,
    concern:'Non-benzodiazepine hypnotic. Sedation, fall risk and cognitive effects in older adults are comparable to benzodiazepines.',
    sources:['BEERS','EU7_PIM','CFP_BZRA'] },
  'zaleplon': { tier:'AVOID', geriatric:true,
    concern:'Non-benzodiazepine hypnotic. Short half-life reduces but does not remove the fall and confusion risk in older adults.',
    sources:['BEERS','EU7_PIM','CFP_BZRA'] },

  // ── Antipsychotics ────────────────────────────────────────────────────────
  'quetiapine': { tier:'AVOID', geriatric:true,
    concern:'Atypical antipsychotic. Use for behavioural symptoms of dementia carries increased mortality; also causes sedation, orthostatic hypotension and falls.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_AP'] },
  'olanzapine': { tier:'AVOID', geriatric:true,
    concern:'Atypical antipsychotic. Use for behavioural symptoms of dementia carries increased mortality; also causes sedation, metabolic effects and falls.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_AP'] },
  'risperidone': { tier:'AVOID', geriatric:true,
    concern:'Atypical antipsychotic. Associated with increased mortality and cerebrovascular events when used for dementia-related behavioural symptoms.',
    sources:['BEERS','EU7_PIM','CFP_AP'] },
  'haloperidol': { tier:'AVOID', geriatric:true,
    concern:'Typical antipsychotic. Increased mortality in dementia, plus extrapyramidal effects and QT prolongation that are more pronounced in older adults.',
    sources:['BEERS','STOPP','EU7_PIM','CFP_AP'] },

  // ── Anticholinergic burden ────────────────────────────────────────────────
  'diphenhydramine': { tier:'AVOID', geriatric:true,
    concern:'First-generation antihistamine with strong anticholinergic activity. Causes confusion, dry mouth, constipation, urinary retention and sedation; tolerance to the sedative effect develops but the anticholinergic burden does not.',
    sources:['BEERS','EU7_PIM','CMS_D10'] },
  'hydroxyzine': { tier:'AVOID', geriatric:true,
    concern:'First-generation antihistamine with strong anticholinergic activity. Contributes to confusion, sedation and peripheral anticholinergic effects in older adults.',
    sources:['BEERS','EU7_PIM'] },
  'amitriptyline': { tier:'AVOID', geriatric:true,
    concern:'Tertiary tricyclic antidepressant. Among the most anticholinergic of the antidepressants; also sedating and a cause of orthostatic hypotension and falls.',
    sources:['BEERS','EU7_PIM'] },
  'paroxetine': { tier:'AVOID', geriatric:true,
    concern:'SSRI with meaningful anticholinergic activity, unusual within its class. Adds to total anticholinergic burden alongside its other effects.',
    sources:['BEERS','EU7_PIM','CMS_D10'] },
  'oxybutynin': { tier:'AVOID', geriatric:true,
    concern:'Oral antimuscarinic for overactive bladder. Crosses the blood–brain barrier readily and may worsen cognition; alternatives with less CNS penetration exist.',
    sources:['BEERS','EU7_PIM'] },
  'cyclobenzaprine': { tier:'AVOID', geriatric:true,
    concern:'Skeletal muscle relaxant, structurally a tricyclic. Anticholinergic and sedating, with poor evidence of benefit at doses tolerated by older adults.',
    sources:['BEERS','EU7_PIM'] },

  // ── Cardiovascular ────────────────────────────────────────────────────────
  'amiodarone': { tier:'CAUTION', geriatric:true,
    concern:'Antiarrhythmic with a very long half-life and cumulative thyroid, pulmonary, hepatic and ocular toxicity. Generally reserved rather than used first-line for atrial fibrillation.',
    sources:['BEERS','STOPP','EU7_PIM'] },
  'digoxin': { tier:'CAUTION', geriatric:true,
    concern:'Narrow therapeutic index and renal clearance that declines with age, so toxicity can develop on a stable dose as renal function falls. Higher doses offer no added benefit in heart failure.',
    sources:['BEERS','STOPP','EU7_PIM'] },
  'doxazosin': { tier:'CAUTION', geriatric:true,
    concern:'Peripheral alpha-1 blocker. Causes orthostatic hypotension, a direct contributor to falls; not a preferred antihypertensive in older adults.',
    sources:['BEERS','STOPP','EU7_PIM'] },
  'terazosin': { tier:'CAUTION', geriatric:true,
    concern:'Peripheral alpha-1 blocker. Orthostatic hypotension and syncope risk, particularly at initiation and after dose increases.',
    sources:['BEERS','EU7_PIM'] },

  // ── Gastrointestinal ──────────────────────────────────────────────────────
  'omeprazole': { tier:'CAUTION', geriatric:false,
    concern:'Proton pump inhibitor. Continued beyond the indicated course, associated with C. difficile infection, fracture and low magnesium. Worth confirming an ongoing indication exists.',
    sources:['STOPP','CFP_PPI','EU7_PIM'] },
  'pantoprazole': { tier:'CAUTION', geriatric:false,
    concern:'Proton pump inhibitor. Continued beyond the indicated course, associated with C. difficile infection, fracture and low magnesium. Worth confirming an ongoing indication exists.',
    sources:['STOPP','CFP_PPI','EU7_PIM'] },
  'esomeprazole': { tier:'CAUTION', geriatric:false,
    concern:'Proton pump inhibitor. Long-term use without a documented ongoing indication is a common target for deprescribing review.',
    sources:['STOPP','CFP_PPI'] },

  // ── Analgesia ─────────────────────────────────────────────────────────────
  'oxycodone': { tier:'CAUTION', geriatric:true,
    concern:'Opioid analgesic. Sedation and impaired balance raise fall and fracture risk; respiratory depression risk rises sharply when combined with other CNS depressants.',
    sources:['BEERS','EU7_PIM','CMS_D09'] },
  'hydrocodone': { tier:'CAUTION', geriatric:true,
    concern:'Opioid analgesic. Sedation and impaired balance raise fall and fracture risk; respiratory depression risk rises sharply when combined with other CNS depressants.',
    sources:['BEERS','EU7_PIM','CMS_D09'] },
  'morphine': { tier:'CAUTION', geriatric:true,
    concern:'Opioid analgesic with renally cleared active metabolites that accumulate as renal function declines, prolonging sedation and respiratory depression.',
    sources:['BEERS','EU7_PIM','CMS_D09'] },
  'tramadol': { tier:'CAUTION', geriatric:true,
    concern:'Opioid analgesic with serotonergic and seizure-threshold effects. Also a recognised cause of hyponatraemia in older adults.',
    sources:['BEERS','EU7_PIM','CMS_D09'] },
  'meperidine': { tier:'AVOID', geriatric:true,
    concern:'Opioid whose metabolite normeperidine accumulates and is neurotoxic, causing tremor and seizures. Poor oral analgesic efficacy; better alternatives exist.',
    sources:['BEERS','EU7_PIM'] },

  // ── NSAIDs ────────────────────────────────────────────────────────────────
  'ibuprofen': { tier:'CAUTION', geriatric:true,
    concern:'Non-selective NSAID. Chronic use raises the risk of GI bleeding and peptic ulcer in older adults, and can worsen renal function and blood pressure.',
    sources:['BEERS','EU7_PIM'] },
  'naproxen': { tier:'CAUTION', geriatric:true,
    concern:'Non-selective NSAID. Chronic use raises the risk of GI bleeding and peptic ulcer in older adults, and can worsen renal function and blood pressure.',
    sources:['BEERS','EU7_PIM'] },
  'ketorolac': { tier:'AVOID', geriatric:true,
    concern:'Potent NSAID with a high rate of GI bleeding and acute kidney injury; risk is greater in older adults and rises with duration of use.',
    sources:['BEERS','EU7_PIM'] },
  'indomethacin': { tier:'AVOID', geriatric:true,
    concern:'NSAID with the highest rate of CNS adverse effects in its class, including confusion and headache, on top of the usual GI and renal risks.',
    sources:['BEERS','EU7_PIM'] },

  // ── Endocrine ─────────────────────────────────────────────────────────────
  'glyburide': { tier:'AVOID', geriatric:true,
    concern:'Long-acting sulfonylurea. Prolonged hypoglycaemia in older adults, made worse by declining renal clearance; shorter-acting alternatives are preferred.',
    sources:['BEERS','EU7_PIM'] },
  'chlorpropamide': { tier:'AVOID', geriatric:true,
    concern:'Long-acting sulfonylurea. Very long half-life causing prolonged hypoglycaemia, and a recognised cause of SIADH and hyponatraemia.',
    sources:['BEERS','EU7_PIM'] },

  // ── Other ─────────────────────────────────────────────────────────────────
  'simvastatin': { tier:'MEASURE', geriatric:false,
    concern:'Statin. Where life expectancy is short, the years needed to realise cardiovascular benefit may exceed it — worth reassessing the goal of therapy rather than continuing by default.',
    sources:['STOPP'] },
  'nitrofurantoin': { tier:'CAUTION', geriatric:true,
    concern:'Urinary antibacterial requiring adequate renal function to reach therapeutic concentrations in urine; long-term use carries pulmonary and hepatic toxicity risk.',
    sources:['BEERS','EU7_PIM'] },
  'megestrol': { tier:'AVOID', geriatric:true,
    concern:'Progestational appetite stimulant. Minimal effect on weight or appetite in older adults, with an increased risk of venous thromboembolism.',
    sources:['BEERS','EU7_PIM'] },
};

// ── Combination flags ────────────────────────────────────────────────────────
// Risks that exist only in combination. Same rule: our statement of the risk,
// their publication as the pointer.
const COMBINATION_FLAGS = [
  { drugs: ['opioid','benzodiazepine'],
    concern: 'Opioid combined with a benzodiazepine. Both suppress respiratory drive; taken together the risk of respiratory depression and overdose is substantially higher than either alone.',
    sources: ['CMS_D09','BEERS'] },
  { drugs: ['opioid','gabapentinoid'],
    concern: 'Opioid combined with gabapentin or pregabalin. Additive sedation and respiratory depression; the combination is a recognised contributor to overdose.',
    sources: ['BEERS'] },
  { drugs: ['anticholinergic','anticholinergic'],
    concern: 'More than one anticholinergic medication. Effects are cumulative — confusion, dry mouth, constipation and urinary retention increase with total burden rather than with any single drug.',
    sources: ['CMS_D10','BEERS'] },
];

/**
 * Build the evidence list shown to the user: our clinical statement, then the
 * publications where the corresponding criteria can be read in full.
 */
function buildEvidence(concern, sourceKeys) {
  const out = [concern];
  const seen = {};
  for (const k of sourceKeys) {
    if (!SOURCES[k] || seen[k]) continue;
    seen[k] = 1;
    out.push('Referenced in: ' + SOURCES[k]);
  }
  return out;
}

const CLASS_OF = {
  opioid: ['oxycodone','hydrocodone','morphine','tramadol','fentanyl','methadone','meperidine','codeine','hydromorphone'],
  benzodiazepine: ['alprazolam','lorazepam','clonazepam','diazepam','temazepam','chlordiazepoxide'],
  gabapentinoid: ['gabapentin','pregabalin'],
  anticholinergic: ['diphenhydramine','hydroxyzine','amitriptyline','paroxetine','oxybutynin','cyclobenzaprine','tolterodine','benztropine'],
};

function classesPresent(drugsLower) {
  const present = {};
  for (const [cls, members] of Object.entries(CLASS_OF)) {
    present[cls] = drugsLower.filter(d => members.includes(d));
  }
  return present;
}

/**
 * Rank deprescribing candidates by published criteria.
 *
 * @param {string[]} drugs      medication names as entered
 * @param {number|null} age     patient age, or null if not collected
 * @returns {{candidates:Array, excluded:Array, ageApplied:boolean}}
 */
function rankByCriteria(drugs, age) {
  const lower = drugs.map(d => String(d).toLowerCase().trim());
  const geriatric = typeof age === 'number' && age >= GERIATRIC_AGE;
  const ageKnown = typeof age === 'number';
  const present = classesPresent(lower);

  // Combination citations, keyed by drug
  // Each entry is {concern, sources} so the combination statement keeps the
  // same shape as a single-drug one.
  const comboCites = {};
  function addCombo(drug, flag) {
    (comboCites[drug] = comboCites[drug] || []).push(flag);
  }
  for (const flag of COMBINATION_FLAGS) {
    const [a, b] = flag.drugs;
    if (a === b) {
      if ((present[a] || []).length >= 2) present[a].forEach(d => addCombo(d, flag));
    } else if ((present[a] || []).length && (present[b] || []).length) {
      [...present[a], ...present[b]].forEach(d => addCombo(d, flag));
    }
  }

  const candidates = [];
  const excluded = [];

  drugs.forEach((drug, i) => {
    const d = lower[i];

    if (NEVER_DEPRESCRIBE.has(d)) {
      excluded.push({ drug, reason: 'Rescue, antidote or replacement therapy — not a deprescribing candidate' });
      return;
    }

    const entry = CRITERIA[d];
    const combos = comboCites[d] || [];
    if (!entry && !combos.length) return;          // no published criteria — not listed

    let tierKey = entry ? entry.tier : 'INTERACTION';
    if (combos.length && TIER[tierKey].rank < TIER.INTERACTION.rank) tierKey = 'INTERACTION';

    // Our clinical statements first, then the source pointers. buildEvidence
    // keeps the two separated so no reproduced rationale text can creep in.
    const cites = [];
    if (entry) cites.push(...buildEvidence(entry.concern, entry.sources));
    for (const flag of combos) cites.push(...buildEvidence(flag.concern, flag.sources));
    const concernCount = (entry ? 1 : 0) + combos.length;

    candidates.push({
      drug,
      drug_class: null,                 // filled by the caller's DRUG_CLASSES map
      tier: tierKey,
      tier_label: TIER[tierKey].label,
      tier_rank: TIER[tierKey].rank,
      criteria_count: concernCount,   // clinical statements, not source lines
      age_conditional: !!(entry && entry.geriatric),
      evidence: cites,
      rationale: buildRationale(drug, tierKey, concernCount),
    });
  });

  // Sort: tier first, then number of criteria, then alphabetically for stability.
  candidates.sort((a, b) =>
    b.tier_rank - a.tier_rank ||
    b.criteria_count - a.criteria_count ||
    a.drug.localeCompare(b.drug));

  return {
    candidates,
    excluded,
    ageApplied: geriatric,
    ageKnown,
    age_disclosure: buildAgeDisclosure(candidates, age),
  };
}

function buildRationale(drug, tierKey, n) {
  const lead = {
    AVOID:      drug + ' appears in published criteria as a medication to avoid in this population.',
    CAUTION:    drug + ' appears in published criteria as a medication to use with caution or to review.',
    INTERACTION:drug + ' is flagged in combination with another medication in this regimen.',
    MEASURE:    drug + ' appears in a quality measure used to assess prescribing.',
  }[tierKey];
  const cite = n === 1 ? 'One concern is noted below, with its source.'
                       : n + ' concerns are noted below, each with its source.';
  const caution = 'This is a prompt to review with the prescriber, not a recommendation to discontinue.';
  return [lead, cite, caution].join(' ');
}

/**
 * One age disclosure for the whole result set, shown under the section header
 * rather than repeated on every card. Returns null when no listed criterion is
 * age-conditional, so the line does not appear when it would be irrelevant.
 */
function buildAgeDisclosure(candidates, age) {
  if (!candidates.some(c => c.age_conditional)) return null;
  const base = 'Criteria shown are drawn from AGS Beers and STOPP, which apply to adults 65 and over.';
  if (typeof age !== 'number') return base + ' Patient age was not collected for this analysis.';
  if (age >= GERIATRIC_AGE) return base;
  return base + ' This patient is ' + age + '; these criteria may not apply.';
}



// ── Deprescribing analysis endpoint ──────────────────────────────────────────
// Runs N+1 CPRS calculations: one baseline + one per drug removed.
// Returns ranked candidates by CPRS delta (highest risk reduction first).
app.post('/api/deprescribing-analyze', async (req, res) => {
  const { drugs } = req.body || {};
  if (!drugs || !Array.isArray(drugs) || drugs.length < 2) {
    return res.status(400).json({ error: 'At least 2 medications required.' });
  }
  if (drugs.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 medications per analysis.' });
  }

  // Drug class map for display
  const DRUG_CLASSES = {
    'warfarin':'Anticoagulant','aspirin':'Antiplatelet/NSAID','clopidogrel':'Antiplatelet',
    'apixaban':'Anticoagulant','rivaroxaban':'Anticoagulant','ibuprofen':'NSAID',
    'naproxen':'NSAID','celecoxib':'NSAID','prednisone':'Corticosteroid',
    'methotrexate':'DMARD','sertraline':'SSRI','fluoxetine':'SSRI','paroxetine':'SSRI',
    'citalopram':'SSRI','escitalopram':'SSRI','venlafaxine':'SNRI','duloxetine':'SNRI',
    'tramadol':'Opioid analgesic','oxycodone':'Opioid analgesic','morphine':'Opioid analgesic',
    'fentanyl':'Opioid analgesic','hydrocodone':'Opioid analgesic',
    'alprazolam':'Benzodiazepine','lorazepam':'Benzodiazepine','clonazepam':'Benzodiazepine',
    'diazepam':'Benzodiazepine','temazepam':'Benzodiazepine','zolpidem':'Z-hypnotic',
    'amiodarone':'Antiarrhythmic','digoxin':'Cardiac glycoside','diltiazem':'CCB',
    'verapamil':'CCB','amlodipine':'CCB','nifedipine':'CCB','metoprolol':'Beta-blocker',
    'atenolol':'Beta-blocker','carvedilol':'Beta-blocker','bisoprolol':'Beta-blocker',
    'lisinopril':'ACE inhibitor','ramipril':'ACE inhibitor','losartan':'ARB',
    'valsartan':'ARB','spironolactone':'Potassium-sparing diuretic',
    'furosemide':'Loop diuretic','hydrochlorothiazide':'Thiazide diuretic',
    'atorvastatin':'Statin','simvastatin':'Statin','rosuvastatin':'Statin',
    'pravastatin':'Statin','omeprazole':'PPI','pantoprazole':'PPI',
    'metformin':'Biguanide','glipizide':'Sulfonylurea','insulin':'Insulin',
    'levothyroxine':'Thyroid hormone','gabapentin':'Anticonvulsant/neuropathic',
    'pregabalin':'Anticonvulsant/neuropathic','carbamazepine':'Anticonvulsant',
    'valproic acid':'Anticonvulsant','phenytoin':'Anticonvulsant',
    'quetiapine':'Atypical antipsychotic','olanzapine':'Atypical antipsychotic',
    'haloperidol':'Typical antipsychotic','donepezil':'Cholinesterase inhibitor',
    'memantine':'NMDA antagonist','lithium':'Mood stabilizer',
    'sildenafil':'PDE5 inhibitor','tamsulosin':'Alpha-blocker',
    'doxazosin':'Alpha-blocker','finasteride':'5-alpha reductase inhibitor',
    'ciprofloxacin':'Fluoroquinolone','azithromycin':'Macrolide',
    'fluconazole':'Azole antifungal','trazodone':'SARI antidepressant',
    'bupropion':'NDRI antidepressant','mirtazapine':'NaSSA antidepressant',
    'topiramate':'Anticonvulsant/migraine','nitrostat':'Nitrate',
    'acetaminophen':'Analgesic/antipyretic'
  };

  // Beers/STOPP criteria map
  const CRITERIA = {
    'alprazolam':['Beers Criteria: Benzodiazepines in older adults — increased fall/fracture risk','STOPP B5: Benzodiazepine — CNS depression, motor incoordination'],
    'lorazepam':['Beers Criteria: Benzodiazepines in older adults — increased fall/fracture risk','STOPP B5: Benzodiazepine — CNS depression, motor incoordination'],
    'clonazepam':['Beers Criteria: Benzodiazepines in older adults — increased fall/fracture risk','STOPP B5: Benzodiazepine — CNS depression, motor incoordination'],
    'diazepam':['Beers Criteria: Benzodiazepines in older adults — increased fall/fracture risk','STOPP B5: Benzodiazepine — CNS depression, motor incoordination'],
    'temazepam':['Beers Criteria: Benzodiazepines in older adults — increased fall/fracture risk','STOPP B5: Benzodiazepine — CNS depression, motor incoordination'],
    'zolpidem':['Beers Criteria: Z-drugs in older adults — delirium, falls, fractures','STOPP B6: Z-hypnotic — same risks as benzodiazepines in older adults'],
    'quetiapine':['Beers Criteria: Antipsychotics in older adults — increased mortality in dementia','STOPP D8: Antipsychotic — risk of stroke, excessive sedation, falls'],
    'olanzapine':['Beers Criteria: Antipsychotics in older adults — increased mortality in dementia','STOPP D8: Antipsychotic — risk of stroke, excessive sedation, falls'],
    'haloperidol':['Beers Criteria: Antipsychotics in older adults — increased mortality in dementia','STOPP D8: Antipsychotic — risk of stroke, excessive sedation, falls'],
    'amiodarone':['Beers Criteria: Amiodarone — high risk of toxicity, thyroid/pulmonary/hepatic','STOPP H2: First-line antiarrhythmic — safer alternatives preferred'],
    'digoxin':['Beers Criteria: Digoxin >0.125mg/day in HF — no mortality benefit, narrow TI','STOPP I1: Digoxin in HF — toxicity risk without mortality benefit'],
    'omeprazole':['STOPP J4: PPI without gastroprotection indication — C. diff risk, hypomagnesemia','Canadian Deprescribing Network: PPI deprescribing guideline 2017'],
    'pantoprazole':['STOPP J4: PPI without gastroprotection indication — C. diff risk, hypomagnesemia','Canadian Deprescribing Network: PPI deprescribing guideline 2017'],
    'simvastatin':['STOPP K1: Statin in limited life expectancy <1yr or frailty — benefit not realized','CMS polypharmacy measure: High-risk medications in older adults'],
    'doxazosin':['Beers Criteria: Alpha-blockers as antihypertensives — high risk of orthostatic hypotension','STOPP C7: Alpha-1 blocker antihypertensive — safer alternatives preferred'],
    'oxycodone':['Beers Criteria: Opioids in older adults without pain specialist input — falls, fractures','CMS: Concurrent Use of Opioids and Benzodiazepines (Star Ratings measure D09)'],
    'hydrocodone':['Beers Criteria: Opioids in older adults — falls, fractures, delirium','CMS: Concurrent Use of Opioids and Benzodiazepines (Star Ratings measure D09)'],
    'morphine':['Beers Criteria: Opioids in older adults — falls, fractures, delirium','CMS: Concurrent Use of Opioids and Benzodiazepines (Star Ratings measure D09)'],
    'paroxetine':['Beers Criteria: Paroxetine — strong anticholinergic, avoid in older adults','CMS: Polypharmacy — Multiple Anticholinergic Medications (Star Ratings measure D10)'],
    'diphenhydramine':['Beers Criteria: First-gen antihistamines — highly anticholinergic','CMS: Polypharmacy — Multiple Anticholinergic Medications (Star Ratings measure D10)'],
  };

  try {
    // Call the existing /api/analyze endpoint for each scenario
    const baseUrl = 'http://localhost:' + (process.env.PORT || 3000);

    async function runAnalysis(drugList) {
      const response = await fetch(baseUrl + '/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'intractmd-2024' },
        body: JSON.stringify({ drugs: drugList, supplements: [], foods: [], patient: {}, language: 'en' })
      });
      return response.json();
    }

    // Extract CPRS and dimensions from analysis result
    function extractScores(result) {
      const dims = { bleeding:0, cardiac:0, serotonin:0, nti:0, cns:0, pharmacokinetic:0, renal_hepatic:0, pharmacodynamic:0 };
      const cprs = result.risk_score || 0;
      // Map API response dimension keys to our internal keys
      if (result.dimensions) {
        const d = result.dimensions;
        dims.bleeding    = d['Bleeding Risk']      || d['bleeding']        || 0;
        dims.cardiac     = d['Cardiac Risk']       || d['cardiac']         || 0;
        dims.serotonin   = d['Serotonin Risk']     || d['serotonin']       || 0;
        dims.nti         = d['NTI Conflict']       || d['nti']             || 0;
        dims.cns         = d['CNS Risk']           || d['cns']             || 0;
        // Cache and CPRS_WEIGHTS both use 'CYP450 Risk' and 'Renal/Hepatic'.
        // The earlier spellings never matched, so both dimensions read as zero.
        dims.pharmacokinetic = d['CYP450 Risk'] || d['Pharmacokinetic Risk'] || d['pharmacokinetic'] || 0;
        dims.renal_hepatic   = d['Renal/Hepatic'] || d['Renal/Hepatic Risk'] || d['renal_hepatic'] || 0;
        dims.pharmacodynamic = d['Pharmacodynamic Risk'] || d['pharmacodynamic'] || 0;
      }
      return { cprs, dimensions: dims };
    }

    // Run baseline analysis
    const baselineResult = await runAnalysis(drugs);
    const baseline = extractScores(baselineResult);

// Rank by published criteria, then enrich each candidate with CPRS delta.
    const ranked = rankByCriteria(drugs, req.body.age ?? null);
    // Run N+1 counterfactual: remove one drug at a time and measure CPRS drop.
    const enriched = await Promise.all(ranked.candidates.map(async function(c){
      const reduced = drugs.filter(d => d.toLowerCase() !== c.drug.toLowerCase());
      let cprs_after = baseline.cprs;
      if (reduced.length >= 1) {
        try {
          const r = await runAnalysis(reduced);
          cprs_after = extractScores(r).cprs;
        } catch(e) { /* keep baseline if simulation fails */ }
      }
      return Object.assign({}, c, {
        drug_class: DRUG_CLASSES[c.drug.toLowerCase()] || 'Medication',
        cprs_before: baseline.cprs,
        cprs_after: cprs_after,
        cprs_delta: Math.round((baseline.cprs - cprs_after) * 10) / 10
      });
    }));
    // Secondary sort: within same tier, highest delta first.
    enriched.sort(function(a,b){
      const tierOrder = {AVOID:0,CAUTION:1,INTERACTION:2,MEASURE:3};
      const ta = tierOrder[a.tier] ?? 4;
      const tb = tierOrder[b.tier] ?? 4;
      if (ta !== tb) return ta - tb;
      return b.cprs_delta - a.cprs_delta;
    });

    return res.json({
      baseline,
      candidates: enriched,
      excluded: ranked.excluded,
      age_disclosure: ranked.age_disclosure,
      age_known: ranked.ageKnown,
      drug_count: drugs.length,
      ranking_basis: 'published_criteria_with_delta'
    });


     
  } catch(e) {
    console.error('[Deprescribing] Error:', e.message);
    return res.status(500).json({ error: 'Analysis failed: ' + e.message });
  }
});

app.get('/clinical', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(require('path').join(__dirname, 'clinical', 'index.html'));
});
// ── END CLINICAL ROUTE ────────────────────────────────────────────────────

// ── STEP 6: OUTREACH MESSAGE GENERATOR ──────────────────────────────────────

// Deterministic, non-AI outreach message built from the already-computed
// findings — used when the AI call fails or returns malformed JSON, so a
// rare generation hiccup never surfaces as a hard failure to the user.
// Mirrors buildProactiveFallback's role for /api/proactive-analyze.
function buildOutreachFallback(drugs, confirmedFindings, computedFindings, predictiveFindings, patientName, caseManagerName, planName, language) {
  const isEs = language === 'es';
  const bullets = [];

  confirmedFindings.forEach(f => {
    bullets.push(isEs
      ? `Vemos que usted está tomando esta combinación de medicamentos: ${f.finding}. Esto requiere supervisión cuidadosa. ${f.action}`
      : `We see that you are taking this combination: ${f.finding} — this requires careful monitoring. ${f.action}`);
  });

  computedFindings.forEach(f => {
    const patientReported = /patient confirms regular consumption of/i.test(f.finding);
    if (patientReported) {
      const item = f.finding.replace(/^Patient confirms regular consumption of /i, '');
      bullets.push(isEs
        ? `Debido a que usted consume regularmente ${item}, esto es importante: hable con su médico o farmacéutico. ${f.action}`
        : `Because you regularly consume ${item}, this is important: please discuss it with your doctor or pharmacist. ${f.action}`);
    } else {
      bullets.push(isEs
        ? `Nuestra revisión de medicamentos identificó lo siguiente: ${f.finding}. ${f.action}`
        : `Our medication review identified the following: ${f.finding}. ${f.action}`);
    }
  });

  predictiveFindings.slice(0, 5).forEach(f => {
    const name = f.finding.split(' (')[0];
    bullets.push(isEs
      ? `Según sus medicamentos, es posible que deba evitar ${name}. ${f.action}`
      : `Based on your medications, you may want to avoid ${name}. ${f.action}`);
  });

  if (bullets.length === 0) {
    bullets.push(isEs
      ? 'Hemos revisado sus medicamentos actuales; no se identificaron problemas urgentes en este momento.'
      : 'We reviewed your current medications; no urgent concerns were identified at this time.');
  }

  const closingLine = isEs
    ? `Por favor comuníquese con nosotros si tiene alguna pregunta. Atentamente, ${caseManagerName}`
    : `Please reach out to us with any questions. Warm regards, ${caseManagerName}`;

  const emailBody = [
    isEs ? `Estimado/a ${patientName},` : `Dear ${patientName},`,
    '',
    isEs
      ? 'Hemos completado una revisión de sus medicamentos actuales y queremos compartir información importante.'
      : "We've completed a review of your current medications and wanted to share some important information.",
    '',
    bullets.map(b => '- ' + b).join('\n'),
    '',
    isEs
      ? 'Estamos aquí para apoyar su salud. Si tiene alguna pregunta, no dude en comunicarse con nosotros.'
      : "We're here to support your health. If you have any questions, please don't hesitate to reach out.",
    '',
    closingLine
  ].join('\n');

  const smsBody = (
    (isEs ? `Hola ${patientName} – Revisamos sus medicamentos. ` : `Hi ${patientName} – We reviewed your medications. `) +
    (isEs ? 'Por favor comuníquese con nosotros si tiene preguntas.' : "Questions? We're here to help.")
  ).slice(0, 155);

  return {
    email: {
      subject: isEs ? `${patientName} – Revisión Importante de Medicamentos` : `${patientName} – Important Medication Review`,
      body: emailBody
    },
    sms: { body: smsBody },
    case_manager_script: {
      opening: isEs
        ? `Hola ${patientName}, le llamo de su equipo de farmacia en ${planName}.`
        : `Hi ${patientName}, I'm calling from your pharmacy team at ${planName}.`,
      key_points: bullets,
      closing: closingLine
    },
    confidence_summary: {
      confirmed_count: confirmedFindings.length,
      computed_count: computedFindings.length,
      predictive_count: predictiveFindings.length,
      highest_tier_used: confirmedFindings.length > 0 ? 'CONFIRMED' : computedFindings.length > 0 ? 'COMPUTED' : 'PREDICTIVE'
    },
    fallback: true
  };
}

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

    let result;
    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }] })
      });
      if (!claudeResp.ok) throw new Error('AI API error: ' + claudeResp.status);

      const claudeData = await claudeResp.json();
      const raw = claudeData.content?.[0]?.text || '';
      const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('No JSON in response');

      result = JSON.parse(m[0]);
    } catch (genErr) {
      console.error('[OUTREACH] AI generation failed, using fallback:', genErr.message);
      result = buildOutreachFallback(drugs, confirmedFindings, computedFindings, predictiveFindings, patientName, caseManagerName, planName, language);
    }

    // Step 2: Translate to Spanish if requested (English-first for clinical accuracy)
    // Skip for the fallback path — it's already localized directly in buildOutreachFallback.
    if (language === 'es' && result.email && result.sms && !result.fallback) {
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

// ════════════════════════════════════════════════════════════════════════════
// DAILY SCHEDULED TEST RUNNER
// ════════════════════════════════════════════════════════════════════════════
// The scheduler below previously called runScheduledTests(), which was never
// defined anywhere in the repository. Because an uncaught throw inside a
// setInterval callback terminates the Node process and there is no
// uncaughtException handler, the server crashed every night inside the
// 02:00-02:04 UTC window and was restarted by the platform — which is also why
// logs/latest.json was never written and /test-status always reported
// "No results yet".
//
// This implements the function the scheduler was always calling. Both suites
// are run as child processes; each one already writes an authoritative JSON
// artifact, so results are read from those files rather than scraped from
// stdout. Everything is defensive: runScheduledTests never rejects and never
// throws, so it cannot take the server down again.
// ════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');

const SCHEDULED_TEST_HOUR_UTC = Number(process.env.SCHEDULED_TEST_HOUR_UTC) || 2;
const SCHEDULED_TEST_TARGET = process.env.SCHEDULED_TEST_TARGET || 'https://www.intractmd.com';

// The 1,500-test suite legitimately runs for over an hour (the most recent
// recorded run took 5,692s), so its ceiling is deliberately high. The feature
// check normally finishes in about a minute.
const FEATURE_CHECK_TIMEOUT_MS = Number(process.env.FEATURE_CHECK_TIMEOUT_MS) || 15 * 60 * 1000;
const TEST_SUITE_TIMEOUT_MS = Number(process.env.TEST_SUITE_TIMEOUT_MS) || 3 * 60 * 60 * 1000;

// Either suite can be turned off without a deploy. The 1,500-test suite issues
// live API calls against the target, including billable AI endpoints, so being
// able to disable it independently matters.
const RUN_FEATURE_CHECK = process.env.SCHEDULED_FEATURE_CHECK !== 'false';
const RUN_TEST_SUITE = process.env.SCHEDULED_TEST_SUITE !== 'false';

const LOGS_DIR = path.join(__dirname, 'logs');

// Concurrency guard. A run can outlast the 5-minute scheduler tick, and the
// 02:00-02:04 window can be hit by more than one tick, so both a re-entry guard
// and a once-per-day guard are needed.
const scheduledTestState = { running: false, startedAt: null, lastCompletedDay: null };

// One definition of "green", shared by the persistence path and /test-status so
// the stored verdict and the rendered verdict can never disagree. A suite that
// was disabled or produced no artifact is not green.
function evaluateAllGreen(fc, ts) {
  const clean = function (x) { return x && x.status === 'complete' && Number(x.failed) === 0; };
  const considered = [fc, ts].filter(function (x) { return x && x.status !== 'disabled'; });
  return considered.length > 0 && considered.every(clean);
}

async function persistTestRun(summary) {
  if (!pool) return { persisted: false, reason: 'no database configured' };
  try {
    await pool.query(
      `INSERT INTO scheduled_test_runs
         (run_day, trigger, target, all_green, feature_check, test_suite,
          duration_seconds, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        summary.date.slice(0, 10),
        summary.trigger,
        summary.target,
        evaluateAllGreen(summary.feature_check, summary.test_suite),
        JSON.stringify(summary.feature_check || {}),
        JSON.stringify(summary.test_suite || {}),
        summary.duration_seconds || 0,
        summary.error || null,
        summary.date,
      ]
    );
    return { persisted: true };
  } catch (e) {
    // Never fatal: a database problem must not lose the run or crash the timer.
    console.error('[Scheduler] Could not persist run to Postgres:', e.message);
    return { persisted: false, reason: e.message };
  }
}

async function loadLatestTestRun() {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_test_runs ORDER BY finished_at DESC LIMIT 1`
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[Scheduler] Could not read run from Postgres:', e.message);
    return null;
  }
}

// Restart-proof once-per-day guard. The in-memory flag is lost whenever the
// process restarts, so a restart inside the 02:00-02:04 window could otherwise
// start a second run on top of the first.
async function scheduledRunCompletedToday(day) {
  if (!pool) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM scheduled_test_runs
        WHERE run_day = $1 AND trigger = 'scheduled' LIMIT 1`,
      [day]
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
}

// Runs one suite to completion. Resolves with an outcome — never rejects — so a
// failing suite degrades into a recorded status instead of an exception.
function runSuiteProcess(spec) {
  return new Promise(function (resolve) {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [spec.script].concat(spec.args || []), {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ status: 'error', error: e.message, elapsedSec: 0, tail: '' });
    }

    // Keep only the tail of the output. The 1,500-test suite prints a progress
    // dot per test plus a full report, which must not accumulate in memory.
    let tail = '';
    const TAIL_LIMIT = 8000;
    const collect = function (buf) {
      tail = (tail + buf.toString()).slice(-TAIL_LIMIT);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(function () {
      timedOut = true;
      console.error('[Scheduler] ' + spec.label + ' exceeded ' +
        formatDuration(spec.timeoutMs / 1000) + ' — terminating');
      try { child.kill('SIGTERM'); } catch (e) {}
      // Escalate if it ignores SIGTERM.
      killTimer = setTimeout(function () {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 10000);
    }, spec.timeoutMs);

    child.on('error', function (e) {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status: 'error', error: e.message, elapsedSec: Math.round((Date.now() - startedAt) / 1000), tail: tail });
    });

    child.on('close', function (code, signal) {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      resolve({
        status: timedOut ? 'timeout' : (code === 0 ? 'ok' : 'nonzero_exit'),
        exitCode: code,
        signal: signal,
        elapsedSec: elapsedSec,
        tail: tail,
        error: timedOut ? 'Timed out after ' + formatDuration(spec.timeoutMs / 1000)
             : (code === 0 ? null : 'Exited with code ' + code),
      });
    });
  });
}

// Locates the JSON artifact a suite wrote during this run. Matching on mtime
// rather than on a computed filename keeps this correct when a run crosses
// midnight UTC, which a 95-minute suite starting at 02:00 could plausibly do
// if the hour were reconfigured.
function findFreshArtifact(dir, prefix, sinceMs) {
  try {
    if (!fs.existsSync(dir)) return null;
    const candidates = fs.readdirSync(dir)
      .filter(function (f) { return f.startsWith(prefix) && f.endsWith('.json'); })
      .map(function (f) {
        const full = path.join(dir, f);
        try { return { full: full, mtime: fs.statSync(full).mtimeMs }; } catch (e) { return null; }
      })
      .filter(function (x) { return x && x.mtime >= sinceMs - 1000; })
      .sort(function (a, b) { return b.mtime - a.mtime; });
    if (!candidates.length) return null;
    return JSON.parse(fs.readFileSync(candidates[0].full, 'utf8'));
  } catch (e) {
    console.error('[Scheduler] Could not read artifact from ' + dir + ':', e.message);
    return null;
  }
}

async function runScheduledTests(trigger) {
  trigger = trigger || 'scheduled';
  const today = new Date().toISOString().slice(0, 10);

  if (scheduledTestState.running) {
    console.warn('[Scheduler] Skipped — a run started at ' +
      new Date(scheduledTestState.startedAt).toISOString() + ' is still in progress');
    return { skipped: true, reason: 'already running' };
  }
  if (trigger === 'scheduled' &&
      (scheduledTestState.lastCompletedDay === today || await scheduledRunCompletedToday(today))) {
    console.log('[Scheduler] Skipped — already completed a run today');
    return { skipped: true, reason: 'already ran today' };
  }

  scheduledTestState.running = true;
  scheduledTestState.startedAt = Date.now();
  const runStartedAt = Date.now();
  console.log('[Scheduler] Starting daily test run (trigger=' + trigger + ', target=' + SCHEDULED_TEST_TARGET + ')');

  const summary = {
    date: new Date().toISOString(),
    trigger: trigger,
    target: SCHEDULED_TEST_TARGET,
    feature_check: { status: 'disabled' },
    test_suite: { status: 'disabled' },
  };

  try {
    // ── Suite 1: feature health check ──────────────────────────────────────
    if (RUN_FEATURE_CHECK) {
      const startedAt = Date.now();
      const outcome = await runSuiteProcess({
        label: 'feature health check',
        script: path.join(__dirname, 'intractmd_feature_health_check.js'),
        args: ['--target=' + SCHEDULED_TEST_TARGET],
        timeoutMs: FEATURE_CHECK_TIMEOUT_MS,
      });
      // A non-zero exit is expected here: the suite exits 1 when any check
      // fails, which is a result to record, not an error to discard.
      const data = findFreshArtifact(path.join(__dirname, 'health-check'), 'data_', startedAt);
      summary.feature_check = data ? {
        status: outcome.status === 'timeout' ? 'timeout' : 'complete',
        total: data.total,
        passed: data.passed,
        failed: data.failed,
        warned: data.warned,
        runtime_seconds: data.runtime_seconds,
        runtime: formatDuration(data.runtime_seconds),
        error: outcome.status === 'timeout' ? outcome.error : null,
      } : {
        status: outcome.status === 'ok' ? 'no_artifact' : outcome.status,
        error: outcome.error || 'Suite produced no JSON artifact',
        runtime_seconds: outcome.elapsedSec,
        runtime: formatDuration(outcome.elapsedSec),
        tail: (outcome.tail || '').slice(-600),
      };
      console.log('[Scheduler] Feature check: ' + summary.feature_check.status +
        ' (' + (summary.feature_check.passed != null
          ? summary.feature_check.passed + '/' + summary.feature_check.total + ' passed' : 'no data') + ')');
    }

    // ── Suite 2: 1,500-test pressure suite ─────────────────────────────────
    if (RUN_TEST_SUITE) {
      const startedAt = Date.now();
      const outcome = await runSuiteProcess({
        label: '1500-test suite',
        script: path.join(__dirname, 'intractmd_test_suite_v2.js'),
        args: [],
        timeoutMs: TEST_SUITE_TIMEOUT_MS,
      });
      const data = findFreshArtifact(path.join(__dirname, 'test_results'), 'results_', startedAt);
      const s = data && data.summary;
      summary.test_suite = s ? {
        status: outcome.status === 'timeout' ? 'timeout' : 'complete',
        total: s.totalTests,
        passed: s.totalPassed,
        failed: s.totalTests - s.totalPassed,
        pass_rate: s.overall,
        avg_ms: s.avgMs,
        runtime_seconds: s.elapsedSec,
        runtime: formatDuration(s.elapsedSec),
        error: outcome.status === 'timeout' ? outcome.error : null,
      } : {
        status: outcome.status === 'ok' ? 'no_artifact' : outcome.status,
        error: outcome.error || 'Suite produced no JSON artifact',
        runtime_seconds: outcome.elapsedSec,
        runtime: formatDuration(outcome.elapsedSec),
        tail: (outcome.tail || '').slice(-600),
      };
      console.log('[Scheduler] Test suite: ' + summary.test_suite.status +
        ' (' + (summary.test_suite.passed != null
          ? summary.test_suite.passed + '/' + summary.test_suite.total + ' passed' : 'no data') + ')');
    }

    summary.duration_seconds = Math.round((Date.now() - runStartedAt) / 1000);
    summary.duration = formatDuration(summary.duration_seconds);

    // Postgres is the system of record — it is the only one of the two that
    // survives a deploy or restart.
    const stored = await persistTestRun(summary);
    summary.persisted = stored.persisted;

    // The files remain as a local mirror, and as the fallback /test-status uses
    // when no database is configured.
    try {
      if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOGS_DIR, 'latest.json'), JSON.stringify(summary, null, 2));
      fs.writeFileSync(
        path.join(LOGS_DIR, 'scheduled-run-' + today + '.json'),
        JSON.stringify(summary, null, 2)
      );
    } catch (e) {
      console.error('[Scheduler] Could not write log files:', e.message);
    }


    // Send nightly results email via Resend
    try {
      if (process.env.RESEND_API_KEY) {
        const fc = summary.feature_check || {};
        const ts = summary.test_suite || {};
        const allGreen = fc.failed === 0 && (ts.status === 'disabled' || ts.failed === 0);
        const emoji = allGreen ? '\u2705' : '\u274c';
        const totalPassed = (fc.passed || 0) + (ts.passed || 0);
        const totalTests = (fc.total || 0) + (ts.total || 0);
        const statusLine = allGreen ? 'ALL CHECKS PASSING' : 'FAILURES DETECTED';
        const runDate = new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
        const runTime = new Date().toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',timeZone:'UTC'}) + ' UTC';
        const fcColor = fc.failed > 0 ? '#A32D2D' : '#2E7D4F';
        const tsColor = ts.failed > 0 ? '#A32D2D' : '#2E7D4F';
        const borderColor = allGreen ? '#2E7D4F' : '#A32D2D';
        const fcPassed = (fc.passed || 0) + '/' + (fc.total || 0);
        const tsPassed = ts.status === 'disabled' ? 'disabled' : (ts.passed || 0) + '/' + (ts.total || 0);
        const tsFailed = ts.status === 'disabled' ? '-' : String(ts.failed || 0);
        const tsRuntime = ts.runtime || '-';
        const avgMs = (ts.avg_ms ? ts.avg_ms + 'ms' : '-');
        const trigger = summary.trigger || 'scheduled';
        const failureAlert = fc.failed > 0 ? '<div style="margin-top:16px;padding:12px;background:#FCEBEB;border-left:4px solid #A32D2D;border-radius:4px;font-size:13px;color:#A32D2D"><strong>Failed checks require attention.</strong> View full results at intractmd.com/test-status</div>' : '';

        const html = '<div style="font-family:Calibri,Arial,sans-serif;max-width:600px;margin:0 auto">'
          + '<div style="background:#0D3B6E;padding:24px 28px;border-radius:6px 6px 0 0">'
          + '<h1 style="color:#00B4D8;margin:0;font-size:22px">IntractMD\u2122 Nightly Test Results</h1>'
          + '<p style="color:#A8C8E8;margin:6px 0 0;font-size:14px">' + runDate + ' &nbsp;\u00b7&nbsp; Run completed at ' + runTime + '</p>'
          + '</div>'
          + '<div style="background:#f4f8fd;padding:24px 28px;border-left:4px solid ' + borderColor + '">'
          + '<h2 style="color:' + borderColor + ';margin:0 0 16px;font-size:20px">' + emoji + ' ' + statusLine + ' \u2014 ' + totalPassed + '/' + totalTests + '</h2>'
          + '<table style="width:100%;border-collapse:collapse;font-size:14px">'
          + '<tr style="background:#0D3B6E;color:#fff">'
          + '<th style="padding:8px 12px;text-align:left">Suite</th>'
          + '<th style="padding:8px 12px;text-align:center">Passed</th>'
          + '<th style="padding:8px 12px;text-align:center">Failed</th>'
          + '<th style="padding:8px 12px;text-align:right">Runtime</th>'
          + '</tr>'
          + '<tr style="background:#fff">'
          + '<td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">Feature Health Check</td>'
          + '<td style="padding:8px 12px;text-align:center;color:#2E7D4F;font-weight:700;border-bottom:1px solid #e5e5e5">' + fcPassed + '</td>'
          + '<td style="padding:8px 12px;text-align:center;color:' + fcColor + ';font-weight:700;border-bottom:1px solid #e5e5e5">' + String(fc.failed || 0) + '</td>'
          + '<td style="padding:8px 12px;text-align:right;color:#666;border-bottom:1px solid #e5e5e5">' + (fc.runtime_seconds ? fc.runtime_seconds + 's' : '-') + '</td>'
          + '</tr>'
          + '<tr style="background:#f4f8fd">'
          + '<td style="padding:8px 12px">1,500-Test Suite</td>'
          + '<td style="padding:8px 12px;text-align:center;color:#2E7D4F;font-weight:700">' + tsPassed + '</td>'
          + '<td style="padding:8px 12px;text-align:center;color:' + tsColor + ';font-weight:700">' + tsFailed + '</td>'
          + '<td style="padding:8px 12px;text-align:right;color:#666">' + tsRuntime + '</td>'
          + '</tr>'
          + '</table>'
          + failureAlert
          + '<p style="margin:16px 0 0;font-size:13px;color:#666">Average response time: ' + avgMs + ' &nbsp;\u00b7&nbsp; Trigger: ' + trigger + ' &nbsp;\u00b7&nbsp; Source: database</p>'
          + '</div>'
          + '<div style="background:#0D3B6E;padding:14px 28px;border-radius:0 0 6px 6px;text-align:center">'
          + '<a href="https://www.intractmd.com/test-status" style="color:#00B4D8;font-size:13px;text-decoration:none">View full results at intractmd.com/test-status</a>'
          + '<p style="color:#6688AA;font-size:11px;margin:6px 0 0">\u00a9 2026 Resolve Medical, LLC &nbsp;\u00b7&nbsp; IntractMD\u2122</p>'
          + '</div>'
          + '</div>';

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
          body: JSON.stringify({
            from: 'IntractMD Results <info@mail.resolve.med>',
            to: ['tom@resolve.med'],
            subject: emoji + ' IntractMD Nightly Tests \u2014 ' + totalPassed + '/' + totalTests + ' ' + statusLine + ' \u2014 ' + runDate,
            html: html
          })
        });
        const emailData = await emailRes.json();
        if (emailData.id) {
          console.log('[Scheduler] Results email sent to tom@resolve.med — id:', emailData.id);
        } else {
          console.error('[Scheduler] Email send failed:', JSON.stringify(emailData));
        }
      } else {
        console.log('[Scheduler] RESEND_API_KEY not set — skipping email notification');
      }
    } catch (emailErr) {
      console.error('[Scheduler] Email notification error:', emailErr.message);
    }

    scheduledTestState.lastCompletedDay = today;
    console.log('[Scheduler] Run complete in ' + summary.duration +
      ' — persisted=' + stored.persisted + (stored.reason ? ' (' + stored.reason + ')' : ''));
    return summary;
  } catch (e) {
    // Nothing here may propagate: this runs from a timer.
    console.error('[Scheduler] Run failed:', e.message);
    try {
      if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
      summary.error = e.message;
      summary.duration_seconds = Math.round((Date.now() - runStartedAt) / 1000);
      fs.writeFileSync(path.join(LOGS_DIR, 'latest.json'), JSON.stringify(summary, null, 2));
    } catch (writeErr) {
      console.error('[Scheduler] Could not write failure record:', writeErr.message);
    }
    return summary;
  } finally {
    scheduledTestState.running = false;
    scheduledTestState.startedAt = null;
  }
}

// Schedule: check every 5 minutes, run once inside the configured UTC hour.
setInterval(function () {
  const now = new Date();
  if (now.getUTCHours() !== SCHEDULED_TEST_HOUR_UTC || now.getUTCMinutes() >= 5) return;
  // runScheduledTests already swallows its own errors; this catch exists so a
  // future change to it can never again terminate the process from a timer.
  runScheduledTests('scheduled').catch(function (e) {
    console.error('[Scheduler] Unexpected scheduler error:', e && e.message);
  });
}, 300000); // check every 5 minutes

// Run once on startup after 60s delay (confirms scheduler is working)
setTimeout(function() {
  // Reflects the actual configuration rather than a hardcoded hour, so the
  // boot log cannot disagree with SCHEDULED_TEST_HOUR_UTC.
  console.log('[Scheduler] Initialized — daily tests run at ' +
    String(SCHEDULED_TEST_HOUR_UTC).padStart(2, '0') + ':00 UTC ' +
    '(feature check: ' + (RUN_FEATURE_CHECK ? 'on' : 'off') +
    ', 1500-test suite: ' + (RUN_TEST_SUITE ? 'on' : 'off') + ')');
  console.log('[Scheduler] Results persist to Postgres; check /test-status');
}, 60000);

// ── TEST STATUS ENDPOINT ──────────────────────────────────────────────────────
// Manual trigger. Returns immediately: a full run can exceed 90 minutes, far
// longer than any sensible HTTP timeout. Poll /test-status for the result.
app.post('/api/admin/run-tests', requireAdmin, function (req, res) {
  if (scheduledTestState.running) {
    return res.status(409).json({
      error: 'A test run is already in progress',
      started_at: new Date(scheduledTestState.startedAt).toISOString(),
    });
  }
  runScheduledTests('manual').catch(function (e) {
    console.error('[Scheduler] Manual run error:', e && e.message);
  });
  res.status(202).json({
    accepted: true,
    note: 'Run started in the background. Poll /test-status for results.',
    suites: {
      feature_check: RUN_FEATURE_CHECK ? 'enabled' : 'disabled',
      test_suite: RUN_TEST_SUITE ? 'enabled' : 'disabled',
    },
  });
});

app.get('/test-status', async function(req, res) {
  // Postgres first — it is the only store that survives a deploy or restart.
  const row = await loadLatestTestRun();
  const latestPath = require('path').join(__dirname, 'logs', 'latest.json');

  let data = null;
  let source = null;
  if (row) {
    data = {
      date: row.finished_at,
      trigger: row.trigger,
      target: row.target,
      duration: formatDuration(row.duration_seconds),
      feature_check: row.feature_check || {},
      test_suite: row.test_suite || {},
    };
    source = 'database';
  } else if (require('fs').existsSync(latestPath)) {
    try {
      data = JSON.parse(require('fs').readFileSync(latestPath, 'utf8'));
      source = 'file';
    } catch (e) {
      return res.status(500).json({ status: 'UNREADABLE', error: e.message });
    }
  }

  if (data) {
    const fc = data.feature_check || {};
    const ts = data.test_suite || {};
    const allGreen = evaluateAllGreen(fc, ts);

    res.json({
      source: source,
      status: allGreen ? 'ALL PASSING' : 'FAILURES DETECTED',
      last_run: data.date,
      trigger: data.trigger,
      target: data.target,
      duration: data.duration,
      feature_health_check: {
        status: fc.status,
        passed: fc.passed,
        failed: fc.failed,
        warned: fc.warned,
        total: fc.total,
        runtime_seconds: fc.runtime_seconds,
        error: fc.error || undefined
      },
      test_suite_1500: {
        status: ts.status,
        passed: ts.passed,
        failed: ts.failed,
        total: ts.total,
        pass_rate: ts.pass_rate,
        avg_ms: ts.avg_ms,
        runtime: ts.runtime,
        error: ts.error || undefined
      }
    });
  } else {
    res.json({
      status: 'No results yet — first run scheduled for ' +
        String(SCHEDULED_TEST_HOUR_UTC).padStart(2, '0') + ':00 UTC',
      note: 'Results will appear here after first scheduled run'
    });
  }
});

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

// ── Analytics report scheduler ────────────────────────────────────────────────
// Runs once daily at ANALYTICS_REPORT_HOUR_UTC (default 4 AM UTC, after test suite)
const ANALYTICS_REPORT_HOUR_UTC = Number(process.env.ANALYTICS_REPORT_HOUR_UTC) || 4;
let analyticsLastRun = null;

setInterval(function() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== ANALYTICS_REPORT_HOUR_UTC) return;
  if (now.getUTCMinutes() >= 5) return;
  if (analyticsLastRun === today) return;
  analyticsLastRun = today;

  console.log('[Analytics] Starting daily analytics report');
  const { execFile } = require('child_process');
  const path = require('path');
  const scriptPath = path.join(__dirname, 'scripts', 'analytics-report.js');
  execFile('node', [scriptPath], {
    env: process.env,
    timeout: 60000
  }, function(err, stdout, stderr) {
    if (err) {
      console.error('[Analytics] Report failed:', err.message);
    } else {
      console.log('[Analytics] Report completed');
    }
    if (stdout) console.log('[Analytics]', stdout.trim());
    if (stderr) console.error('[Analytics] stderr:', stderr.trim());
  });
}, 300000); // check every 5 minutes

console.log('[Analytics] Report scheduler active — runs at ' +
  String(ANALYTICS_REPORT_HOUR_UTC).padStart(2, '0') + ':00 UTC daily');

