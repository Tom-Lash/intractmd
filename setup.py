open('server.js','w').write(open('server.js').read() if False else """const express=require('express'),fetch=require('node-fetch'),path=require('path'),app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.post('/api/analyze',async(req,res)=>{
  const k=req.headers['x-api-key'];
  const{drugs,patient}=req.body;
  const ptL=[];
  if(patient){
    if(patient.age)ptL.push('Age: '+patient.age);
    if(patient.weight)ptL.push('Weight: '+patient.weight+'kg');
    if(patient.elderly)ptL.push('Elderly');
    if(patient.pregnant)ptL.push('Pregnant');
    if(patient.pediatric)ptL.push('Pediatric');
    if(patient.conditions)ptL.push('Conditions: '+patient.conditions);
  }
  const pairs=[];
  for(let i=0;i<drugs.length;i++)for(let j=i+1;j<drugs.length;j++)pairs.push(drugs[i]+' + '+drugs[j]);
  const prompt='You are a senior clinical pharmacist. Analyze ALL drug interactions for this regimen.\\n\\nMEDICATIONS: '+drugs.join(', ')+'\\n'+(ptL.length?'PATIENT: '+ptL.join(', '):'No patient profile.')+'\\n\\nALL PAIRS TO CHECK: '+pairs.join(', ')+'\\n\\nFor every pair provide a full clinical analysis. Return ONLY valid JSON with no markdown:\\n{"overall_risk":"HIGH","risk_score":75,"summary":"overview","pairs":[{"drugs":"drug1 + drug2","severity":"major","mechanism":"text","clinical_effect":"text","onset":"rapid","monitoring":"text","action":"text","patient_specific":null}],"polypharmacy_note":"text","key_concern":"text","contraindicate
cd ~/Downloads/ddi-checker && cat > setup.py << 'EOF'
open('server.js','w').write(open('server.js').read() if False else """const express=require('express'),fetch=require('node-fetch'),path=require('path'),app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.post('/api/analyze',async(req,res)=>{
  const k=req.headers['x-api-key'];
  const{drugs,patient}=req.body;
  const ptL=[];
  if(patient){
    if(patient.age)ptL.push('Age: '+patient.age);
    if(patient.weight)ptL.push('Weight: '+patient.weight+'kg');
    if(patient.elderly)ptL.push('Elderly');
    if(patient.pregnant)ptL.push('Pregnant');
    if(patient.pediatric)ptL.push('Pediatric');
    if(patient.conditions)ptL.push('Conditions: '+patient.conditions);
  }
  const pairs=[];
  for(let i=0;i<drugs.length;i++)for(let j=i+1;j<drugs.length;j++)pairs.push(drugs[i]+' + '+drugs[j]);
  const prompt='You are a senior clinical pharmacist. Analyze ALL drug interactions for this regimen.\\n\\nMEDICATIONS: '+drugs.join(', ')+'\\n'+(ptL.length?'PATIENT: '+ptL.join(', '):'No patient profile.')+'\\n\\nALL PAIRS TO CHECK: '+pairs.join(', ')+'\\n\\nFor every pair provide a full clinical analysis. Return ONLY valid JSON with no markdown:\\n{"overall_risk":"HIGH","risk_score":75,"summary":"overview","pairs":[{"drugs":"drug1 + drug2","severity":"major","mechanism":"text","clinical_effect":"text","onset":"rapid","monitoring":"text","action":"text","patient_specific":null}],"polypharmacy_note":"text","key_concern":"text","contraindicated":false}';
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:4000,system:'Clinical pharmacology expert. Valid JSON only. No markdown.',messages:[{role:'user',content:prompt}]})
    });
    const d=await r.json();
    const raw=(d.content&&d.content[0]&&d.content[0].text)||'{}';
    try{res.json(JSON.parse(raw.replace(/`+'`'*3+`json|`+'`'*3+`/g,'').trim()));}
    catch(e){res.status(500).json({error:'Parse error'});}
  }catch(e){res.status(502).json({error:e.message});}
});
app.listen(3000,()=>console.log('DDI Checker running at http://localhost:3000'));
""")
print('server.js written, size:',len(open('server.js').read()))
