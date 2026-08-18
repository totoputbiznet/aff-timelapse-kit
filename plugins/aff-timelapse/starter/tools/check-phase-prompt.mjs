#!/usr/bin/env node
// ตรวจพรอมต์เฟสหนึ่งใบกับบัญชีของภาพหมุด (frames/phase4.json)
//
//   node tools/check-phase-prompt.mjs <scene-dir> <prompts/phaseN.md>
//
// กฎ:
//   product  → ต้องถูกเอ่ยถึงทุกใบ ไม่ในฐานะของที่คงไว้ ก็ในฐานะของที่สั่งให้หาย
//              ไม่เอ่ยเลย = ERROR (โมเดลถือว่าเอาออกได้ — เคยเกิดกับม้านั่งใน P2 มาแล้ว)
//              ยกเว้นชิ้นที่ยัง "ไม่เกิด" ในเฟสนั้น เช่น ม้านั่งที่ยังอยู่ในกล่องตอน P2
//              ใส่ "from_phase": 3 ให้ชิ้นนั้นใน phase4.json แล้วใบ P1/P2 จะลดเป็น WARN
//              (ยังเตือนอยู่ เพราะเขียนว่า "ยังอยู่ในกล่อง" ชัดกว่าไม่พูดถึงเลย)
//   fixed    → ควรอยู่ในคีย์ camera  ไม่เจอ = WARN
//   styling  → ควรถูกเอ่ยถึงหรือครอบด้วยประโยครวม  ไม่เจอ = WARN
//
// exit 1 เมื่อเจอ ERROR

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [sceneDir, promptPath] = process.argv.slice(2);
if (!sceneDir || !promptPath) {
  console.error('ใช้: node tools/check-phase-prompt.mjs <scene-dir> <prompts/phaseN.md>');
  process.exit(2);
}

const inv = JSON.parse(readFileSync(join(sceneDir, 'frames/phase4.json'), 'utf8'));
const raw = readFileSync(join(sceneDir, promptPath), 'utf8');

// ดึงเฉพาะบล็อกโค้ด json ก้อนแรก = พรอมต์ที่ยิงจริง
const m = raw.match(/```json\s*\n([\s\S]*?)```/);
if (!m) { console.error('ไม่พบบล็อก ```json ในไฟล์พรอมต์'); process.exit(2); }

let prompt;
try { prompt = JSON.parse(m[1]); }
catch (e) { console.error('JSON ในไฟล์พรอมต์ไม่ถูกต้อง: ' + e.message); process.exit(2); }

const haystack = Object.values(prompt).join(' \n ').toLowerCase();
const has = (kws) => (kws || []).some(k => haystack.includes(k.toLowerCase()));

// คำครอบใช้ได้เฉพาะตอน "ปฏิเสธตัวแม่" เท่านั้น
//   "there is no pavilion at all"  → ครอบ benches/table/roof/curtains ได้จริง
//   "the pavilion is up"           → ไม่ครอบ ต้องบอกเป็นชิ้นๆ ว่าม้านั่งอยู่หรือไม่อยู่
// นี่คือจุดที่บั๊กม้านั่งใน P2 เกิด ถ้าปล่อยให้ครอบแบบไม่ดูการปฏิเสธ เครื่องมือจะจับไม่ได้
const NEG = ['no ', 'not ', 'without ', 'never '];

// ช่วง "คำสั่งให้ลบ" — ตั้งแต่กริยาลบไปจนจบประโยคนั้น
//
// ⚠️ ทำไมต้องมี: พรอมต์แบบ "บอกเฉพาะส่วนต่าง" (วัดแล้วชนะพรอมต์เต็มใบ · 1.15.0) เขียนว่า
//   "Remove the following from this stage: the rug, the cushions, the throw, the tray, ..."
// ชื่อของชิ้นท้ายๆ อยู่ห่างจากคำว่า Remove เป็นร้อยตัวอักษร **เกินหน้าต่างมองย้อนหลัง 24 ตัว**
// ตัวตรวจจึงอ่านว่าของพวกนั้น "อยู่ในเฟรมแล้ว" → ขึ้น styling-leak ปลอมทั้งชุด
// (เจอจริงกับฉาก canalside 18 ส.ค. — leak ปลอม 9 รายการทั้งที่พรอมต์สั่งลบทุกชิ้น)
//
// ขยายหน้าต่างเฉยๆ ไม่ได้ เพราะจะไปคาบประโยคข้างเคียงแล้วเกิด false negative แทน
// จึงจับเป็น **ช่วง** ตั้งแต่กริยาลบถึงจุดจบประโยค
const REMOVE_VERBS = ['remove the following', 'remove ', 'take out ', 'clear away ', 'strip out ', 'delete '];
const removalSpans = (() => {
  const spans = [];
  for (const v of REMOVE_VERBS) {
    let i = haystack.indexOf(v);
    while (i !== -1) {
      const end = haystack.indexOf('.', i);
      spans.push([i, end === -1 ? haystack.length : end]);
      i = haystack.indexOf(v, i + 1);
    }
  }
  return spans;
})();
const insideRemoval = (i) => removalSpans.some(([a, b]) => i >= a && i < b);

const coveredByNegation = (kws) => (kws || []).some(k => {
  const t = k.toLowerCase();
  let i = haystack.indexOf(t);
  while (i !== -1) {
    if (insideRemoval(i)) return true;
    const before = haystack.slice(Math.max(0, i - 24), i);
    if (NEG.some(n => before.includes(n))) return true;
    i = haystack.indexOf(t, i + 1);
  }
  return false;
});

const status = (item) => has(item.keywords) ? 'ok' : coveredByNegation(item.covered_by) ? 'covered' : null;

// เฟสของพรอมต์ใบนี้ อ่านจากชื่อไฟล์ — ใช้ตัดสินว่าชิ้นส่วนสินค้าชิ้นนั้น "เกิดแล้วหรือยัง"
const phaseNum = parseInt(promptPath.match(/phase(\d)/)?.[1] ?? '4', 10);

const rows = [];
const check = (group, sev) => (inv[group] || []).forEach(item => {
  const notYet = group === 'product' && item.from_phase && phaseNum < item.from_phase;
  rows.push({
    sev: status(item) || item.severity || (notYet ? 'WARN' : sev),
    group: notYet ? `${group}·ยังไม่เกิด` : group, id: item.id, name: item.name,
  });
});
check('product', 'ERROR');
check('fixed', 'WARN');
check('styling', 'WARN');

// styling-leak: ของในกลุ่ม styling ถูกติดตั้งใน seg3 เท่านั้น
// ถ้ามันโผล่ในพรอมต์ P1/P2/P3 แบบ "ไม่ถูกปฏิเสธ" แปลว่ามันไปกองอยู่ในเฟรมก่อนเวลา
// ผลคือ seg2 ต้องเข็นออก แล้ว seg3 ต้องเข็นกลับเข้ามา = ลำดับที่ขัดสามัญสำนึกคนดู
// เกิดขึ้นจริงแล้วทั้งสองฉากของสินค้าศาลา
const leaks = (inv.styling || []).filter(item =>
  has(item.keywords) && !coveredByNegation(item.keywords) && !coveredByNegation(item.covered_by)
);
rows.push({
  sev: has(inv.lighting.keywords) ? 'ok' : 'WARN',
  group: 'lighting', id: 'lighting', name: inv.lighting.sun,
});

const errors  = rows.filter(r => r.sev === 'ERROR');
const warns   = rows.filter(r => r.sev === 'WARN');
const covered = rows.filter(r => r.sev === 'covered');

console.log(`\nพรอมต์: ${promptPath}`);
console.log(`คีย์ที่มี: ${Object.keys(prompt).join(', ')}`);
console.log(`ความยาว: ${m[1].trim().length} ตัวอักษร\n`);

if (errors.length) {
  console.log('✕ ERROR — ของในกลุ่ม product ที่พรอมต์ไม่ได้เอ่ยถึงเลย');
  console.log('  โมเดลจะถือว่าเอาออกได้ ต้องเขียนว่าคงไว้หรือสั่งให้หายอย่างใดอย่างหนึ่ง');
  errors.forEach(e => console.log(`    - ${e.id.padEnd(10)} ${e.name}`));
  console.log('');
}
if (leaks.length) {
  console.log('⚠ styling-leak — ของที่ควรมาถึงตอน seg3 ดันอยู่ในเฟรมแล้ว');
  console.log('  จะทำให้ seg2 ต้องเข็นออก แล้ว seg3 ต้องเข็นกลับเข้ามา — ลำดับที่คนดูอ่านว่าผิด');
  console.log('  แก้โดยเอาออกจากพรอมต์ใบนี้ ไม่ใช่เอาไปใส่ P3');
  leaks.forEach(l => console.log(`    - ${l.id.padEnd(16)} ${l.name}`));
  console.log('');
}
if (warns.length) {
  console.log('△ WARN — ไม่ได้เอ่ยถึง แต่ไม่ถึงกับพัง');
  warns.forEach(w => console.log(`    - [${w.group}] ${w.id.padEnd(14)} ${w.name}`));
  console.log('');
}
const okCount = rows.filter(r => r.sev === 'ok').length;
console.log(`สรุป: เอ่ยถึงตรงตัว ${okCount} · ครอบด้วยคำกว้าง ${covered.length} · WARN ${warns.length} · styling-leak ${leaks.length} · ERROR ${errors.length}  (จาก ${rows.length})`);
process.exit(errors.length ? 1 : 0);
