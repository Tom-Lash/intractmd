#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD — PAIR CACHE BATCH PRE-COMPUTATION SCRIPT (v2 — fixed)
// ════════════════════════════════════════════════════════════════════════════
// Fixes from v1:
//   1. Strips ```json code fences before parsing
//   2. Smaller batch size (18 pairs instead of 30) to avoid truncation
//   3. Higher max_tokens (8192) for headroom
//   4. Detects truncated responses (stop_reason === 'max_tokens') and
//      automatically retries that batch at a smaller size
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PAIR_CACHE_DIR = path.join(__dirname, 'cache', 'drug-pairs');
if (!fs.existsSync(PAIR_CACHE_DIR)) fs.mkdirSync(PAIR_CACHE_DIR, { recursive: true });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY environment variable before running.');
  process.exit(1);
}
console.log('API key OK, length:', ANTHROPIC_API_KEY.length);

const BATCH_SIZE = 18;        // reduced from 30 to avoid truncation
const CONCURRENCY = 5;
const MAX_TOKENS = 8192;      // raised from 4096
const RESUME_MODE = true;

const drugList = JSON.parse(fs.readFileSync(path.join(__dirname, 'top_150_drugs.json'), 'utf8'));
console.log(`Loaded ${drugList.length} drugs.`);

function slugify(name) {
  return name.toLowerCase()
    .replace(/\s+(calcium|sodium|hydrochloride|hcl|sulfate|bisulfate|maleate|tartrate|oxalate|mesylate|besylate|succinate|fumarate|phosphate|acetate|chloride|bromide|potassium|magnesium|zinc|citrate|gluconate|tannate|pamoate|stearate|valerate|benzoate|propionate)\b.*/i, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function pairKey(a, b) {
  const sa = slugify(a), sb = slugify(b);
  return sa < sb ? `${sa}__${sb}` : `${sb}__${sa}`;
}
function isCached(a, b) {
  return fs.existsSync(path.join(PAIR_CACHE_DIR, pairKey(a, b) + '.json'));
}
function writePairCache(drugA, drugB, data) {
  fs.writeFileSync(path.join(PAIR_CACHE_DIR, pairKey(drugA, drugB) + '.json'), JSON.stringify(data), 'utf8');
}
function allPairs(list) {
  const pairs = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      pairs.push([list[i], list[j]]);
  return pairs;
}

let pairs = allPairs(drugList);
console.log(`Total possible pairs: ${pairs.length}`);
if (RESUME_MODE) {
  const before = pairs.length;
  pairs = pairs.filter(([a, b]) => !isCached(a, b));
  console.log(`Resume mode: ${before - pairs.length} already cached, ${pairs.length} remaining.`);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
let batches = chunk(pairs, BATCH_SIZE);
console.log(`Split into ${batches.length} batches of up to ${BATCH_SIZE} pairs each.`);

// ── STRIP MARKDOWN CODE FENCES BEFORE PARSING ────────────────────────────────
function stripCodeFences(text) {
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function buildPrompt(batch) {
  const pairList = batch.map(([a, b]) => `${a} + ${b}`).join('\n');
  return `You are a clinical pharmacologist conducting a systematic drug interaction review. For EACH of the following drug pairs, determine if a clinically significant interaction exists based on established pharmacological knowledge.

Drug pairs to analyze:
${pairList}

Return ONLY a raw JSON array with one object per pair, IN THE SAME ORDER as listed above. Do not skip any pairs. Do NOT wrap the output in markdown code fences or backticks — return ONLY the raw JSON array starting with [ and ending with ].

Keep "mechanism" and "action" fields concise — one short sentence each, maximum 25 words per field — to ensure the full response fits within the output limit.

[
  {
    "drugA": "<exact first drug name as given>",
    "drugB": "<exact second drug name as given>",
    "hasInteraction": <true|false>,
    "severity": "<Minimal|Low|Moderate|High|Critical>",
    "mechanism": "<concise clinical mechanism, max 25 words, empty string if no interaction>",
    "action": "<concise patient/clinical guidance, max 25 words, empty string if no interaction>",
    "dimensions": {
      "Bleeding Risk": <integer 0-100>,
      "Cardiac Risk": <integer 0-100>,
      "Serotonin Risk": <integer 0-100>,
      "NTI Conflict": <integer 0-100>,
      "CNS Risk": <integer 0-100>,
      "CYP450 Risk": <integer 0-100>,
      "Renal/Hepatic": <integer 0-100>,
      "Pharmacodynamic": <integer 0-100>
    }
  }
]

If a pair has no clinically meaningful interaction, set hasInteraction to false, severity to "Minimal", mechanism and action to empty strings, and all dimension scores to 0.`;
}

async function callClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || '';
  const stopReason = data.stop_reason;

  return { raw, stopReason };
}

async function processBatch(batch, batchNum, totalBatches, depth = 0) {
  const prompt = buildPrompt(batch);
  const { raw, stopReason } = await callClaude(prompt);

  const cleaned = stripCodeFences(raw);

  // Detect truncation
  if (stopReason === 'max_tokens') {
    if (batch.length > 4 && depth < 3) {
      // Split this batch in half and retry each half
      const mid = Math.ceil(batch.length / 2);
      console.log(`  Batch ${batchNum}: TRUNCATED (${batch.length} pairs) — splitting into 2 sub-batches of ~${mid}`);
      const half1 = batch.slice(0, mid);
      const half2 = batch.slice(mid);
      const r1 = await processBatch(half1, `${batchNum}a`, totalBatches, depth + 1);
      const r2 = await processBatch(half2, `${batchNum}b`, totalBatches, depth + 1);
      return r1 + r2;
    } else {
      throw new Error(`Batch ${batchNum} truncated even at minimum size (${batch.length} pairs) — token limit may need further investigation`);
    }
  }

  let results;
  try {
    results = JSON.parse(cleaned);
  } catch (e) {
    // Try to extract array even if there's stray text around it
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error(`  Batch ${batchNum}: PARSE FAILED. First 200 chars of cleaned text:`);
      console.error('  ' + cleaned.slice(0, 200));
      throw new Error('Could not parse JSON array from response');
    }
    results = JSON.parse(match[0]);
  }

  if (!Array.isArray(results)) throw new Error('Parsed result is not an array');

  for (const r of results) {
    if (!r.drugA || !r.drugB) continue;
    writePairCache(r.drugA, r.drugB, {
      ...r,
      computedAt: new Date().toISOString(),
      source: 'precomputed-batch-v2'
    });
  }

  console.log(`  Batch ${batchNum}/${totalBatches}: cached ${results.length} pairs`);
  return results.length;
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  let completed = 0;
  let failed = 0;
  let totalCached = 0;

  async function next() {
    if (index >= items.length) return;
    const i = index++;
    try {
      const n = await worker(items[i], i + 1, items.length);
      totalCached += n;
      completed++;
    } catch (e) {
      failed++;
      console.error(`  Batch ${i + 1} FAILED: ${e.message}`);
    }
    await next();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return { completed, failed, totalCached };
}

(async () => {
  if (batches.length === 0) {
    console.log('Nothing to do — all pairs already cached.');
    return;
  }

  const startTime = Date.now();
  console.log(`\nStarting pre-computation with concurrency=${CONCURRENCY}, batch size=${BATCH_SIZE}...\n`);

  const { completed, failed, totalCached } = await runWithConcurrency(batches, CONCURRENCY, processBatch);

  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n════════════════════════════════════════`);
  console.log(`DONE in ${elapsedMin} minutes`);
  console.log(`Batches completed: ${completed}/${batches.length}`);
  console.log(`Batches failed: ${failed}`);
  console.log(`Total pairs cached this run: ${totalCached}`);
  console.log(`Re-run this script to retry any failed batches (resume mode is on).`);
  console.log(`════════════════════════════════════════\n`);
})();
