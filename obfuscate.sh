#!/bin/bash
echo "IntractMD Obfuscator"
echo "Source:  public/index.src.html"
echo "Output:  public/index.prod.html"
cp public/index.prod.html public/index.prod.html.bak 2>/dev/null || true
node -e "
const fs = require('fs');
const JavaScriptObfuscator = require('javascript-obfuscator');
const html = fs.readFileSync('public/index.src.html', 'utf8');
let blockNum = 0;
let obfCount = 0;
let skipCount = 0;

const obfuscated = html.replace(/<script>([\s\S]*?)<\/script>/g, (match, js) => {
  blockNum++;
  const trimmed = js.trim();
  if (trimmed.length < 100) {
    console.log('  Block ' + blockNum + ': skipped (too small, ' + trimmed.length + ' chars)');
    skipCount++;
    return match;
  }
  try {
    // Try with strict parser first, fall back to loose parsing
    let result;
    try {
      result = JavaScriptObfuscator.obfuscate(js, {
        compact: false,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        selfDefending: false,
        stringArray: false,
        unicodeEscapeSequence: false,
        transformObjectKeys: false,
        splitStrings: false,
        target: 'browser'
      });
    } catch(e1) {
      // If standard parse fails, try wrapping in async function context
      try {
        const wrapped = '(async function(){' + js + '})();';
        const wrappedResult = JavaScriptObfuscator.obfuscate(wrapped, {
          compact: false,
          controlFlowFlattening: false,
          deadCodeInjection: false,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          selfDefending: false,
          stringArray: false,
          unicodeEscapeSequence: false,
          target: 'browser'
        });
        // Unwrap — remove the outer async wrapper
        let code = wrappedResult.getObfuscatedCode();
        code = code.replace(/^\(async function\(\)\{/,'').replace(/\}\)\(\);?$/,'');
        return '<script>' + code + '</script>';
      } catch(e2) {
        throw e1; // re-throw original error
      }
    }
    const code = result.getObfuscatedCode();
    console.log('  Block ' + blockNum + ': obfuscated (' + Math.round(trimmed.length/1024) + 'KB → ' + Math.round(code.length/1024) + 'KB)');
    obfCount++;
    return '<script>' + code + '</script>';
  } catch(e) {
    console.warn('  Block ' + blockNum + ': FAILED (' + e.message.slice(0,80) + ') — keeping original');
    skipCount++;
    return match;
  }
});

fs.writeFileSync('public/index.prod.html', obfuscated);
console.log('');
console.log('Obfuscated: ' + obfCount + ' blocks');
console.log('Skipped:    ' + skipCount + ' blocks');
const srcKB = Math.round(fs.statSync('public/index.src.html').size/1024);
const outKB = Math.round(fs.statSync('public/index.prod.html').size/1024);
console.log('Size: ' + srcKB + 'KB → ' + outKB + 'KB');
"
