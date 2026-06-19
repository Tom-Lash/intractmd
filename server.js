#!/usr/bin/env node

console.log('[STARTUP] Process started');

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();

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
        const r = await safeFetch(`https://api.fda.gov/drug/label.json?search=openfda.generic_name:${fdaEnc}&limit=1`);
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

async function callClaude(k, prompt, maxTok = 4096) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTok,
      system: 'You are a senior clinical pharmacist and pharmacologist with deep expertise in drug interactions, pharmacokinetics, and patient safety. Respond with raw valid JSON ONLY. Do NOT use markdown code blocks, backticks, or any prose. Your entire response must begin with { and end with }.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || '{}';
}

app.post('/api/analyze', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!k) return res.status(401).json({ error: 'No API key' });

  const { drugs = [], patient, supplements = [], foods = [] } = req.body;
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
      [raw, rawF] = await Promise.all([callClaude(k, mainPrompt, 4096), callClaude(k, foodOnlyPrompt, 2048)]);
    } else {
      raw = await callClaude(k, mainPrompt, 4096);
    }

    let result = tryParseJSON(raw);
    if (!result) {
      const retryPrompt = 'IMPORTANT: Return raw JSON only, starting with { ending with }. No markdown, no backticks.\n\nDrug interactions for: ' + drugs.join(',') + (supplements.length ? ', supps:' + supplements.join(',') : '') + (includeFoodInMain && foods.length ? ', foods:' + foods.join(',') : '') + '.\n\n' + mainPrompt;
      raw = await callClaude(k, retryPrompt, 4096);
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
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const { drugs = [], supplements = [], foods = [], patient = {} } = req.body;
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
    const raw = await callClaude(apiKey, prompt, 2000);
    const parsed = tryParseJSON(raw);
    if (!parsed) return res.status(502).json({ error: 'Failed to parse AI response' });
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/drug-info', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const { drugName } = req.body;
  if (!drugName) return res.status(400).json({ error: 'drugName required' });

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
    const raw = await callClaude(apiKey, prompt, 1500);
    const parsed = tryParseJSON(raw);
    if (!parsed) return res.status(502).json({ error: 'Failed to parse AI response' });
    res.json(parsed);
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
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const { drugName, dosage, frequency, indication } = req.body;
  if (!drugName) return res.status(400).json({ error: 'drugName required' });

  const userPrompt = `Create a clear, patient-friendly "Instructions for Use" summary for ${drugName}${dosage ? ' (' + dosage + ')' : ''}${frequency ? ', ' + frequency : ''}${indication ? ' for ' + indication : ''}. Include: 1) How to take it, 2) When to take it, 3) What to do if you miss a dose, 4) Important precautions, 5) When to call your doctor. Use simple language. Keep it concise.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: 'You are a clinical pharmacist creating a clear, patient-friendly Instructions for Use summary. Use simple language a patient can understand. Avoid medical jargon. Be specific and practical.',
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const data = await r.json();
    const raw = ((data.content && data.content[0] && data.content[0].text) || '').trim();
    const parsed = tryParseJSON(raw);
    if (!parsed) return res.status(502).json({ error: 'Failed to parse AI response' });
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

console.log('[STARTUP] All routes configured');

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

