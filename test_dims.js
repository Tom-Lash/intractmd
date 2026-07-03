const path = require('path');
const fs = require('fs');
const DIR = path.join(__dirname, 'cache', 'proactive-profiles');
function slug(n){return n.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function load(drug){
  const fp=path.join(DIR,slug(drug)+'.json');
  if(fs.existsSync(fp))return JSON.parse(fs.readFileSync(fp,'utf8'));
  return null;
}
const drugs=['Warfarin','Aspirin'];
const profiles=drugs.map(d=>({drug:d,profile:load(d)}));
const found=profiles.filter(p=>p.profile);
console.log('found:', found.length);
const p=found[0].profile;
console.log('keys:', Object.keys(p));
console.log('avoid_supplements:', p.avoid_supplements.length);
const s=p.avoid_supplements[0];
console.log('first supp:', s.name, '|', s.severity, '|', s.mechanism.slice(0,60));
