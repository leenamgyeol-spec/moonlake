// src/index.html(읽을 수 있는 원본)의 게임 스크립트를 난독화해서 배포용 index.html을 만든다.
// 원본 src/는 .gitignore로 깃허브에 올라가지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import JavaScriptObfuscator from 'javascript-obfuscator';

const src = readFileSync('src/index.html', 'utf8');
const open = src.lastIndexOf('<script>');
const close = src.lastIndexOf('</script>');
if (open < 0 || close < open) throw new Error('src/index.html에서 <script>를 찾지 못했어요');
const code = src.slice(open + 8, close);

const out = JavaScriptObfuscator.obfuscate(code, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.15,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.8,
  splitStrings: true,
  splitStringsChunkLength: 8,
  unicodeEscapeSequence: false,
  selfDefending: true,
  domainLock: ['leenamgyeol-spec.github.io', 'localhost', '127.0.0.1'],
  domainLockRedirectUrl: 'https://leenamgyeol-spec.github.io/moonlake/',
  target: 'browser',
}).getObfuscatedCode();

const banner = '/* 달빛 저수지 © 2026 남결 (leenamgyeol-spec). All rights reserved. 무단 복제·수정·재배포 금지. */\n';
const html = src.slice(0, open + 8) + '\n' + banner + out + '\n' + src.slice(close);
writeFileSync('index.html', html);
console.log(`index.html 생성: 원본 ${code.length.toLocaleString()}자 → 난독화 ${out.length.toLocaleString()}자`);
