#!/usr/bin/env node
// กวาดหา `static_band` ให้เอง แล้วพิมพ์ JSON ที่ก๊อปไปวางใน phase4.json ได้ทันที
//
//   node tools/probe-band.mjs scenes/<slug>
//   node tools/probe-band.mjs scenes/<slug> --rows 6 --cols 12 --depth 0.5 --boxes 3 --heatmap
//
// วิธีทำงาน — แบ่งครึ่งบนของเฟรมเป็นตาราง แล้ววัด SSIM ของ **ทุกช่อง** ตามคู่ในโซ่
// (`P1→P3` `P2→P3` `P3→P4`) ช่องที่ "นิ่งจริง" คือช่องที่ **ค่าทั้งสามคู่ห่างกันน้อย**
// ไม่ใช่ช่องที่ค่าสูง — เพราะค่าสูงอาจแค่เป็นพื้นที่เรียบไม่มีลายเส้น ส่วนค่าที่ห่างกันน้อย
// หมายถึงทุกเฟสเห็นของชิ้นเดียวกัน ซึ่งเป็นนิยามของโซนห้ามเปลี่ยน
//
// แล้วต่อช่องที่นิ่งเป็นสี่เหลี่ยมใหญ่สุดไม่เกิน --boxes กล่อง ซึ่งเข้ากับ `static_band`
// แบบ array ของ check-scene.mjs พอดี **ช่องที่ไม่นิ่งจะถูกเว้นออกเอง** ซึ่งคือกฎที่ว่า
// วัตถุที่ไม่ใช่ `fixed` แล้วโผล่เข้าโซน ต้องนับเป็นของฝั่งเปลี่ยนได้
//
// ⚠️ เครื่องนี้เสนอ ไม่ได้ตัดสิน — **ต้องดู `_contact-sheet.png` ยืนยันด้วยตาเสมอ**
// ว่ากล่องที่ได้ไม่ได้ไปตกบนของที่ควรเปลี่ยน · ค่าที่ได้เชื่อได้เฉพาะเมื่อมีภาพครบ 4 เฟส

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const sceneDir = argv.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

if (!sceneDir) {
  console.error('ใช้: node tools/probe-band.mjs scenes/<slug> [--rows 5] [--cols 10] [--depth 0.5] [--boxes 3] [--heatmap]');
  process.exit(2);
}

const ROWS = parseInt(flag('rows', '5'), 10);
const COLS = parseInt(flag('cols', '10'), 10);
const DEPTH = parseFloat(flag('depth', '0.5'));   // กวาดแค่ครึ่งบน — ครึ่งล่างคือที่ที่งานเกิด
const MAXBOX = parseInt(flag('boxes', '3'), 10);

const tmp = mkdtempSync(join(tmpdir(), 'probeband-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ปล่อย */ } });

const framePath = (n) => join(sceneDir, 'frames', `phase${n}.png`);
const missing = [1, 2, 3, 4].filter((n) => !existsSync(framePath(n)));
if (missing.length) {
  console.error(`⛔ ขาด phase${missing.join(', phase')}.png — เครื่องนี้ต้องมีครบ 4 เฟสถึงจะวัดได้`);
  console.error('   ตอนได้ P4 ใบเดียวให้ร่าง static_band จากบัญชีใน phase4.json ก่อน (เลี่ยง from_phase + ใบไม้)');
  console.error('   แล้วกลับมารันใบนี้ทับตอนได้ครบสี่ใบ');
  process.exit(1);
}

const run = (a) => spawnSync('ffmpeg', a, { encoding: 'utf8', maxBuffer: 1 << 26 });
const ssim = (A, B, box, t) => {
  const crop = `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y}`;
  const a = join(tmp, `a-${t}.png`), b = join(tmp, `b-${t}.png`);
  run(['-v', 'error', '-y', '-i', A, '-vf', crop, a]);
  run(['-v', 'error', '-y', '-i', B, '-vf', crop, b]);
  if (!existsSync(a) || !existsSync(b)) return null;
  const m = run(['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-']).stderr.match(/All:([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
};

const inv = existsSync(join(sceneDir, 'frames', 'phase4.json'))
  ? JSON.parse(readFileSync(join(sceneDir, 'frames', 'phase4.json'), 'utf8')) : {};
const chain = { 1: 3, 2: 3, 3: 4, ...(inv.chain ?? {}) };
const PAIRS = [1, 2, 3].map((n) => [n, Number(chain[n] ?? chain[String(n)])]);

// ── 1. วัดทีละช่อง ──
const cw = 1 / COLS, ch = DEPTH / ROWS;
const cell = [];
console.log(`กวาด ${sceneDir} · ตาราง ${COLS}x${ROWS} ในครึ่งบน ${DEPTH * 100}% · ${COLS * ROWS * 3} การวัด`);
for (let r = 0; r < ROWS; r++) {
  cell[r] = [];
  for (let c = 0; c < COLS; c++) {
    const box = { x: +(c * cw).toFixed(4), y: +(r * ch).toFixed(4), w: +cw.toFixed(4), h: +ch.toFixed(4) };
    const v = PAIRS.map(([a, s], i) => ssim(framePath(a), framePath(s), box, `${r}-${c}-${i}`));
    const ok = v.every((x) => x !== null);
    cell[r][c] = { box, v, spread: ok ? Math.max(...v) - Math.min(...v) : Infinity };
  }
  process.stdout.write('.');
}
console.log('');

// ── 2. ประกอบกล่องจากช่องที่นิ่ง ──
// ⚠️ **ห้ามเชื่อเส้นแบ่ง "นิ่ง" เส้นเดียว** — ค่าห่างของช่องเล็กๆ แปรปรวนกว่าค่าของพื้นที่รวมมาก
// (ครั้งแรกที่เขียนใบนี้ใช้ค่ากลางเป็นเส้นแบ่ง ได้ 0.229 ซึ่งหลวมจนรับช่องขยะเข้ามา
//  แล้วเสนอกล่องที่แย่กว่ากล่องที่เลือกด้วยมือ) → **ลองหลายเส้นแล้ววัดจริงทุกแบบ เลือกที่ชนะ**
const spreads = cell.flat().map((c) => c.spread).filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
const pct = (q) => spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * q))];

const assemble = (cut) => {
  const stable = cell.map((row) => row.map((c) => c.spread <= cut));
  const used = cell.map((row) => row.map(() => false));
  const free = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (!stable[r][c] || used[r][c]) return false;
    return true;
  };
  const out = [];
  for (let k = 0; k < MAXBOX; k++) {
    let best = null;
    for (let r0 = 0; r0 < ROWS; r0++) for (let r1 = r0; r1 < ROWS; r1++)
      for (let c0 = 0; c0 < COLS; c0++) for (let c1 = c0; c1 < COLS; c1++) {
        const area = (r1 - r0 + 1) * (c1 - c0 + 1);
        if (best && area <= best.area) continue;
        if (free(r0, c0, r1, c1)) best = { r0, c0, r1, c1, area };
      }
    if (!best || best.area < 2) break;         // กล่องช่องเดียวเล็กเกินไป ไม่เอา
    for (let r = best.r0; r <= best.r1; r++) for (let c = best.c0; c <= best.c1; c++) used[r][c] = true;
    out.push({
      x: +(best.c0 * cw).toFixed(3), y: +(best.r0 * ch).toFixed(3),
      w: +((best.c1 - best.c0 + 1) * cw).toFixed(3), h: +((best.r1 - best.r0 + 1) * ch).toFixed(3),
    });
  }
  return { cut, stable, boxes: out };
};

const measure = (bs) => {
  const vals = PAIRS.map(([a, s], i) => {
    let sum = 0, area = 0;
    bs.forEach((b, j) => { const v = ssim(framePath(a), framePath(s), b, `m${i}-${j}`); const w = b.w * b.h; sum += v * w; area += w; });
    return sum / area;
  });
  return { vals, spread: Math.max(...vals) - Math.min(...vals), area: bs.reduce((t, b) => t + b.w * b.h, 0) };
};

console.log('\nลองหลายเส้นแบ่งแล้ววัดจริง:');
const tried = [];
for (const q of [0.15, 0.25, 0.35, 0.5]) {
  const a = assemble(pct(q));
  if (!a.boxes.length) continue;
  if (tried.some((t) => JSON.stringify(t.boxes) === JSON.stringify(a.boxes))) continue;
  const m = measure(a.boxes);
  tried.push({ ...a, ...m, q });
  console.log(`  เส้น ${a.cut.toFixed(3)} (เปอร์เซ็นไทล์ ${q * 100}) → ${a.boxes.length} กล่อง `
    + `พื้นที่ ${(m.area * 100).toFixed(1)}%  ห่าง ${m.spread.toFixed(3)} `
    + `${m.spread > 0.15 ? 'FAIL' : m.spread > 0.10 ? 'WARN' : 'PASS'}`);
}

if (!tried.length) {
  console.error('\n⛔ ไม่เจอช่องนิ่งที่ต่อเป็นกล่องได้เลย — ฉากนี้แปรปรวนทั้งครึ่งบน');
  console.error('   ลอง --depth 0.25 ให้แคบลง หรือเปิด _contact-sheet.png ดูว่าเกิดอะไรขึ้น');
  process.exit(1);
}

// เลือกแบบที่ห่างน้อยสุด · เสมอกันในระดับ noise (0.01) ให้เอาแบบที่พื้นที่กว้างกว่า
// เพราะพื้นที่กว้าง = หลักฐานมากกว่า และดื้อต่อ noise มากกว่า
tried.sort((a, b) => (Math.abs(a.spread - b.spread) > 0.01 ? a.spread - b.spread : b.area - a.area));
const win = tried[0];
const boxes = win.boxes, got = win;

console.log(`\nแผนที่ความนิ่งของแบบที่ชนะ (· = นิ่ง ห่าง ≤ ${win.cut.toFixed(3)} · X = ไม่นิ่ง) — x=0 → 1`);
for (let r = 0; r < ROWS; r++) {
  console.log(`  y${(r * ch).toFixed(2)}  ${win.stable[r].map((s) => (s ? '·' : 'X')).join(' ')}   `
    + cell[r].map((c) => (Number.isFinite(c.spread) ? c.spread.toFixed(2) : ' na')).join(' '));
}
const stable = win.stable;
const line = (tag, r) => `${tag.padEnd(16)} ` + PAIRS.map(([a, s], i) => `P${a}→P${s} ${r.vals[i].toFixed(3)}`).join(' · ')
  + `  → ห่าง ${r.spread.toFixed(3)} ${r.spread > 0.15 ? 'FAIL' : r.spread > 0.10 ? 'WARN' : 'PASS'}`;

console.log('');
let keepCurrent = false;
if (inv.static_band) {
  const cur = Array.isArray(inv.static_band) ? inv.static_band : [inv.static_band];
  const mc = measure(cur);
  console.log(line(`ที่ตั้งอยู่ (${cur.length} กล่อง)`, mc));
  keepCurrent = mc.spread <= got.spread + 0.005;   // ของเดิมชนะหรือเสมอในระดับ noise
}
console.log(line(`ที่เสนอ (${boxes.length} กล่อง)`, got));

if (keepCurrent) {
  console.log('\n✋ **ของเดิมดีกว่าหรือเสมอ — อย่าเปลี่ยน** เครื่องนี้เสนอได้ไม่ดีกว่าที่คนเลือกไว้');
  console.log('   เกิดขึ้นได้ปกติกับฉากที่ส่วนบนเป็นใบไม้ เพราะตารางหยาบมองไม่เห็นขอบใบ');
} else {
  console.log('\nก๊อปไปวางใน frames/phase4.json:\n');
  console.log('  "static_band": ' + JSON.stringify(boxes) + ',\n');
}
console.log('⚠️ ยืนยันด้วยตาก่อนรับ — `node tools/contact-sheet.mjs ' + sceneDir + '`');
console.log('   กล่องที่ได้ต้องไม่ตกบนของกลุ่ม styling/product/คนงาน และไม่ตกบนใบไม้หรือเงาใบไม้');

// ── 5. แผนที่ความร้อน (ถ้าขอ) — ดูง่ายกว่าตัวเลขเวลาฉากซับซ้อน ──
if (has('heatmap')) {
  const out = join(sceneDir, 'frames', '_band-probe.png');
  const draw = cell.flatMap((row, r) => row.map((c, i) =>
    `drawbox=x=iw*${c.box.x}:y=ih*${c.box.y}:w=iw*${c.box.w}:h=ih*${c.box.h}:t=fill:` +
    `color=${stable[r][i] ? '#2ecc71' : '#e74c3c'}@0.35`)).join(',');
  const frame = draw + ',' + boxes.map((b) =>
    `drawbox=x=iw*${b.x}:y=ih*${b.y}:w=iw*${b.w}:h=ih*${b.h}:color=white@0.95:t=4`).join(',');
  const r = run(['-v', 'error', '-y', '-i', framePath(4), '-vf', `scale=760:-1,${frame}`, out]);
  if (r.status === 0) console.log(`\n🗺️  ${out} — เขียว = ช่องนิ่ง · แดง = ไม่นิ่ง · กรอบขาว = กล่องที่เสนอ`);
}
