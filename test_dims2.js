const path = require('path');
const fs = require('fs');
const DIR = path.join(__dirname, 'cache', 'proactive-profiles');
function slug(n){return n.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function load(drug){
  const fp=path.join(DIR,slug(drug)+'.json');
  if(fs.existsSync(fp))return JSON.parse(fs.readFileSync(fp,'utf8'));
  return null;
}
const found=['Warfarin','Aspirin'].map(d=>({drug:d,profile:load(d)})).filter(p=>p.profile);
console.log('Found:', found.length, 'profiles');

const ntiDrugs=['warfarin','digoxin','lithium','levothyroxine'];
const dims={'Bleeding Risk':0,'Cardiac Risk':0,'Serotonin Risk':0,'NTI Conflict':0,'CNS Risk':0,'CYP450 Risk':0,'Renal/Hepatic':0,'Pharmacodynamic':0};

found.forEach(({profile}) => {
  if(!profile) return;
  const pathways=(profile.key_pathways||[]).map(p=>p.toUpperCase());
  console.log(profile.drug, 'pathways:', pathways);
  if(pathways.some(p=>p.includes('CYP'))) dims['CYP450 Risk']=Math.min(100,dims['CYP450 Risk']+30);
  if(ntiDrugs.some(d=>profile.drug&&profile.drug.toLowerCase().includes(d))) dims['NTI Conflict']=Math.min(100,dims['NTI Conflict']+60);
  const allItems=[...(profile.avoid_supplements||[]),...(profile.avoid_foods||[])];
  console.log(profile.drug, 'items to check:', allItems.length);
  allItems.forEach(item => {
    const n=(item.name||'').toLowerCase(), m=(item.mechanism||'').toLowerCase();
    const sv=item.severity==='Critical'?30:item.severity==='High'?18:7;
    if(m.includes('bleed')||m.includes('anticoag')||m.includes('platelet')) {
      dims['Bleeding Risk']=Math.min(100,dims['Bleeding Risk']+sv);
    }
    if(m.includes('cyp')||m.includes('enzyme')) {
      dims['CYP450 Risk']=Math.min(100,dims['CYP450 Risk']+sv);
    }
  });
});

console.log('Dimensions:', JSON.stringify(dims, null, 2));
