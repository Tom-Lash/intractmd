#!/usr/bin/env node
// Run manually: node scripts/prewarm-cache.js
// Resume-safe: skips drugs whose cache files already exist.
// Requires ANTHROPIC_API_KEY env var.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRUG_INFO_CACHE_DIR = path.join(ROOT, 'cache', 'drug-info');
const IFU_CACHE_DIR = path.join(ROOT, 'cache', 'ifu');
const ERROR_LOG = path.join(__dirname, 'prewarm-errors.log');
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY env var is required.'); process.exit(1); }

[DRUG_INFO_CACHE_DIR, IFU_CACHE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const SALT_RE = /\s+(calcium|sodium|hydrochloride|hcl|sulfate|bisulfate|maleate|tartrate|oxalate|mesylate|besylate|succinate|fumarate|phosphate|acetate|chloride|bromide|potassium|magnesium|zinc|citrate|gluconate|tannate|pamoate|stearate|valerate|benzoate|propionate)\b.*/i;

function slugify(name) {
  return name.toLowerCase().replace(SALT_RE, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stripSalts(name) {
  return name.replace(SALT_RE, '').trim();
}

function tryParseJSON(raw) {
  const strip = s => s.replace(/^```json\s*/gm, '').replace(/^```\s*/gm, '').replace(/```\s*$/gm, '').trim();
  for (const s of [raw, strip(raw)]) {
    try { return JSON.parse(s); } catch (e) {}
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {} }
  }
  return null;
}

async function callClaude(prompt, system, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return ((data.content && data.content[0] && data.content[0].text) || '').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function logError(drugName, type, msg) {
  const line = `[${new Date().toISOString()}] ${type} | ${drugName} | ${msg}\n`;
  fs.appendFileSync(ERROR_LOG, line, 'utf8');
}

// Returns 'cached' | 'written' | 'error'
async function cacheDrugInfo(drugName, slug) {
  const f = path.join(DRUG_INFO_CACHE_DIR, slug + '.json');
  if (fs.existsSync(f)) return 'cached';
  try {
    const prompt = 'You are a pharmacist explaining a medication to a patient in clear, simple, friendly language. Describe ' + drugName + '.\n\n'
      + 'Return ONLY raw valid JSON (no markdown, no backticks, start with { end with }).\n'
      + 'Structure:\n{"generic_name":"<generic name>","brand_names":["<brand1>","<brand2>"],"drug_class":"<drug class>",'
      + '"purpose":"<what it is used for — 2-3 sentences, plain language>","how_it_works":"<mechanism explained simply — 2-3 sentences a patient can understand>",'
      + '"common_side_effects":"<common side effects in plain language>","warnings":"<important warnings in simple language>","typical_dosing":"<typical dosing in simple language>"}\n\nUse plain patient language.';
    const system = 'You are a senior clinical pharmacist. Respond with raw valid JSON ONLY. No markdown, no prose. Start with { end with }.';
    const raw = await callClaude(prompt, system, 1500);
    const parsed = tryParseJSON(raw);
    if (!parsed) throw new Error('JSON parse failed: ' + raw.slice(0, 150));
    fs.writeFileSync(f, JSON.stringify(parsed), 'utf8');
    return 'written';
  } catch (e) {
    logError(drugName, 'drug-info', e.message);
    return 'error';
  }
}

// Returns 'cached' | 'written' | 'error'
async function cacheIFU(drugName, slug) {
  const f = path.join(IFU_CACHE_DIR, slug + '.json');
  if (fs.existsSync(f)) return 'cached';
  try {
    const userPrompt = `Create patient-friendly Instructions for Use for ${drugName}. Return a JSON object with exactly these fields: drug_name (string), brand_names (array of strings), what_its_for (string), how_to_take (string), dosing (string), missed_dose (string), storage (string), what_to_avoid (string), when_to_call_doctor (string), when_it_works (string), special_populations (string or null). Use simple patient-friendly language.`;
    const system = 'You are a clinical pharmacist. Respond with ONLY valid JSON. Do not include any markdown code fences, explanatory text, or commentary before or after the JSON object.';
    const raw = await callClaude(userPrompt, system, 2000);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = tryParseJSON(cleaned);
    if (!parsed) throw new Error('JSON parse failed: ' + cleaned.slice(0, 150));
    fs.writeFileSync(f, JSON.stringify(parsed), 'utf8');
    return 'written';
  } catch (e) {
    logError(drugName, 'ifu', e.message);
    return 'error';
  }
}

async function main() {
  const drugList = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'drug-list.json'), 'utf8'));
  const total = drugList.length;
  const startTime = Date.now();

  // Clear error log for this run
  fs.writeFileSync(ERROR_LOG, `=== Prewarm run started ${new Date().toISOString()} | ${total} drugs ===\n`, 'utf8');

  console.log(`\nPre-warming cache for ALL ${total} drugs in drug-list.json`);
  console.log(`Resume-safe: already-cached drugs will be skipped.\n`);

  let newlyCached = 0, skipped = 0, errors = 0;
  let lastDrugName = '';

  // Deduplicate by slug — no point calling Claude twice for same base name
  const seen = new Set();

  for (let i = 0; i < total; i++) {
    const entry = drugList[i];
    const genericFull = entry.generic || entry.brand || '';
    const displayName = stripSalts(genericFull);
    const slug = slugify(genericFull);

    if (!slug || seen.has(slug)) { skipped++; continue; }
    seen.add(slug);

    // Check if both cache files exist — if so, skip without any Claude calls
    const diExists = fs.existsSync(path.join(DRUG_INFO_CACHE_DIR, slug + '.json'));
    const ifuExists = fs.existsSync(path.join(IFU_CACHE_DIR, slug + '.json'));
    if (diExists && ifuExists) { skipped++; continue; }

    // Drug Info
    const diResult = await cacheDrugInfo(displayName, slug);
    if (diResult === 'written') newlyCached++;
    else if (diResult === 'error') errors++;
    await sleep(1000);

    // IFU
    const ifuResult = await cacheIFU(displayName, slug);
    if (ifuResult === 'written') newlyCached++;
    else if (ifuResult === 'error') errors++;

    lastDrugName = displayName;

    // Progress log every 10 drugs (and always on the last one)
    const processed = i + 1;
    if (processed % 10 === 0 || processed === total) {
      const pct = Math.round((processed / total) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = processed / elapsed; // drugs/sec
      const remaining = Math.round((total - processed) / rate);
      console.log(`Progress: ${processed}/${total} (${pct}%) | +${newlyCached} cached | ${skipped} skipped | ${errors} errors | ~${Math.ceil(remaining / 60)}min left | last: ${lastDrugName}`);
    }

    // 1-second delay between drugs (already have 1s after drug-info, so IFU → next drug is the gap)
    if (i < total - 1) await sleep(1000);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60), secs = elapsed % 60;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done! Elapsed: ${mins}m ${secs}s`);
  console.log(`  Total drugs in list : ${total}`);
  console.log(`  Newly cached        : ${newlyCached} files`);
  console.log(`  Skipped (existed)   : ${skipped}`);
  console.log(`  Errors              : ${errors}`);
  console.log(`${'─'.repeat(60)}`);
  if (errors > 0) console.log(`\nFailed drugs logged to: scripts/prewarm-errors.log`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
