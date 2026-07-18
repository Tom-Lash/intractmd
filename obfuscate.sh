#!/bin/bash
echo "IntractMD Obfuscator"
echo "Source:  public/index.html → Output: public/index.prod.html"
cp public/index.prod.html public/index.prod.html.bak 2>/dev/null || true
node -e "
const fs = require('fs');
const JavaScriptObfuscator = require('javascript-obfuscator');
const html = fs.readFileSync('public/index.html', 'utf8');
const obfuscated = html.replace(/<script>([\s\S]*?)<\/script>/g, (match, js) => {
  if (js.trim().length < 100) return match;
  try {
    const result = JavaScriptObfuscator.obfuscate(js, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      selfDefending: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      unicodeEscapeSequence: false
    });
    return '<script>' + result.getObfuscatedCode() + '</script>';
  } catch(e) {
    console.warn('Warning: skipped a block, keeping original');
    return match;
  }
});
fs.writeFileSync('public/index.prod.html', obfuscated);
const srcKB = Math.round(fs.statSync('public/index.html').size/1024);
const outKB = Math.round(fs.statSync('public/index.prod.html').size/1024);
console.log('Done — ' + srcKB + 'KB → ' + outKB + 'KB');
"
