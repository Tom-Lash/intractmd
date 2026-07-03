// ════════════════════════════════════════════════════════════════════════════
// INTRACTMD STEP 6 — INSTALLER
// Adds the /clinical route and /api/generate-outreach endpoint to server.js
// Copies the clinical UI to the correct directory
// Run from ~/Documents/ddi-checker/
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ── 1. Add clinical route to server.js ───────────────────────────────────
let server = fs.readFileSync('server.js', 'utf8');
const routeTarget = 'const port = process.env.PORT || 3000;';

const clinicalRoute = `
// ── CLINICAL WORKFLOW ROUTE ───────────────────────────────────────────────
app.get('/clinical', (req, res) => {
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

    const prompt = \`You are a clinical pharmacist generating a patient outreach message for \${planName}.

PATIENT: \${patientName}
MEDICATIONS: \${drugs.join(', ')}
OVERALL RISK: \${ddiResults.risk_tier || 'Unknown'}

CONFIRMED FINDINGS (declarative language — reference the record):
\${confirmedFindings.length ? confirmedFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\\n') : 'None identified.'}

COMPUTED FINDINGS (system-identified patterns):
\${computedFindings.length ? computedFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\\n') : 'None selected.'}

PREDICTIVE FINDINGS (conditional language ONLY — inferred, not confirmed):
\${predictiveFindings.length ? predictiveFindings.map(f => '- ' + f.finding + ': ' + f.action).join('\\n') : 'None identified.'}

COPY RULES — follow exactly:
- CONFIRMED: Declarative. "Your records show [finding]..." or "We see that..."
- COMPUTED: Pattern framing. "Our medication review identified..." or "Based on your current regimen..."
- PREDICTIVE: Conditional ONLY. "Based on your medications, you may want to ask your pharmacist about..." NEVER say the patient IS taking a supplement. NEVER use declarative voice for predictive findings.
- No raw lab values, no risk score numbers, no terms like eGFR, LFT, PCPRS, polypharmacy, frail, non-adherent
- Always end with warm call to action referencing \${caseManagerName} and phone/portal contact
- Keep the message hopeful and action-oriented, not alarming

\${langInstr}

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
    "confirmed_count": \${confirmedFindings.length},
    "computed_count": \${computedFindings.length},
    "predictive_count": \${predictiveFindings.length},
    "highest_tier_used": "\${confirmedFindings.length > 0 ? 'CONFIRMED' : computedFindings.length > 0 ? 'COMPUTED' : 'PREDICTIVE'}"
  }
}\`;

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
    const clean = raw.replace(/\`\`\`json\\s*/g, '').replace(/\`\`\`\\s*/g, '').trim();
    const m = clean.match(/\\{[\\s\\S]*\\}/);
    if (!m) throw new Error('No JSON in response');

    const result = JSON.parse(m[0]);
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

`;

if (server.includes('app.get(\'/clinical\'')) {
  console.log('Clinical route already exists — skipping');
} else if (server.includes(routeTarget)) {
  server = server.replace(routeTarget, clinicalRoute + routeTarget);
  fs.writeFileSync('server.js', server);
  console.log('✓ Server routes added');
} else {
  console.log('✗ Route target not found in server.js');
}

// ── 2. Create clinical directory and copy UI ──────────────────────────────
const clinicalDir = path.join(__dirname, 'clinical');
if (!fs.existsSync(clinicalDir)) {
  fs.mkdirSync(clinicalDir);
  console.log('✓ Created clinical/ directory');
}

// Copy the HTML file
const htmlSrc = path.join(__dirname, 'step6_clinical.html');
const htmlDst = path.join(clinicalDir, 'index.html');
if (fs.existsSync(htmlSrc)) {
  fs.copyFileSync(htmlSrc, htmlDst);
  console.log('✓ Copied step6_clinical.html → clinical/index.html');
} else {
  console.log('✗ step6_clinical.html not found — copy it to this directory first');
}

console.log('\nInstallation complete!');
console.log('Next: node --check server.js && git add server.js clinical/ && git commit -m "Add Step 6 clinical workflow — patient outreach generator" && git push');
