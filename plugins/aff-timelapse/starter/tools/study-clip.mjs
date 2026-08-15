#!/usr/bin/env node
// ถอดโครงคลิปของคนอื่นด้วยการวัด ไม่ใช่ด้วยตา
//
//   node tools/study-clip.mjs research/clips/<ไฟล์>.mp4 [--thresh 0.20]
//
// ตอบสี่คำถามที่ตาคนตอบไม่ได้แม่น:
//   1. คลิปมีกี่ช็อต ช็อตละกี่วินาที        → รอยคัตจาก scene score
//   2. แต่ละช็อตเป็นภาพกว้างหรือโคลสอัพ      → แถบภาพตัวแทนช็อต + ความหนาแน่นของลายเส้น
//   3. กล้องขยับ *ในช็อต* ไหม               → สเกลของลายเส้นระหว่างเฟรมติดกัน
//   4. มีเสียงจริงไหม ดังแค่ไหน
//
// ⚠️ ข้อ 2 กับข้อ 3 เป็นคนละเรื่องกัน และเคยสับสนกันมาแล้วในโปรเจคนี้
// **คัตไปโคลสอัพ** = ตัดต่อ ภาพเปลี่ยนทันทีข้ามเฟรมเดียว → เห็นที่ scene score
// **ซูม/ดอลลี่**   = เคลื่อนกล้อง ภาพค่อยๆ ใหญ่ขึ้นหลายเฟรม → เห็นที่สเกลของลายเส้น
// ทั้งสองอย่างทำให้ "ของในภาพใหญ่ขึ้น" เหมือนกัน แต่ทำในคลิป frame-to-frame ได้ไม่เท่ากันเลย
// อย่างแรกต้องแก้ที่ชั้นตัดต่อ อย่างหลังต้องแก้ที่พรอมต์วิดีโอ — ตัวนี้จึงต้องแยกให้ออก
//
// เรื่องสเกล: รายงาน r มาด้วยเสมอ — r ต่ำ = ลายเส้นเปลี่ยนไปมากจนวัดไม่ได้ ไม่ใช่แปลว่ากล้องนิ่ง

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const PW = 240, PH = 426;          // ย่อทุกเฟรมมาขนาดนี้ก่อนวัด จะได้เทียบข้ามคลิปได้
const FPS = 4;                     // ความถี่สุ่มเฟรม — 0.25 วิ ละเอียดพอเห็นจังหวะซูมสั้นๆ
const SCALES = [];                 // ผู้สมัคร scale ต่อ 1 ช่วงเฟรม (±6% ต่อ 0.25 วิ ครอบซูมเร็วสุดที่เจอจริง)
for (let s = 0.94; s <= 1.0601; s += 0.005) SCALES.push(+s.toFixed(3));

const file = process.argv[2];
// เกณฑ์คัตต่ำกว่าค่ามาตรฐานทั่วไป (0.3) ตั้งใจ — คัตจากภาพกว้างไปโคลสอัพ *ในฉากเดียวกัน*
// สี แสง และพื้นหลังยังเหมือนเดิมเกือบหมด scene score จึงต่ำกว่าคัตข้ามฉาก
// ปล่อยให้ผ่านเข้ามาเยอะไว้ก่อนแล้วอ่านคะแนนเอง ดีกว่าตั้งสูงแล้วมองไม่เห็นคัตที่มีจริง
const THRESH = process.argv.includes('--thresh')
  ? +process.argv[process.argv.indexOf('--thresh') + 1] : 0.20;

if (!file || !existsSync(file)) {
  console.error('ใช้: node tools/study-clip.mjs research/clips/<ไฟล์>.mp4 [--thresh 0.20]');
  process.exit(2);
}

const run = (cmd, args, binary = false) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 29, encoding: binary ? 'buffer' : 'utf8' });
  return { out: r.stdout, err: (binary ? r.stderr?.toString('utf8') : r.stderr) || '', code: r.status };
};

const f = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(d));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// ---------- 1. ข้อมูลไฟล์ ----------

const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).out || '{}');
const v = (probe.streams || []).find((s) => s.codec_type === 'video');
const a = (probe.streams || []).find((s) => s.codec_type === 'audio');
if (!v) { console.error('ไฟล์นี้ไม่มีสตรีมวิดีโอ'); process.exit(2); }

const dur = parseFloat(probe.format?.duration ?? v.duration ?? 0);
const fps = (() => { const [n, d] = (v.r_frame_rate || '0/1').split('/'); return d > 0 ? n / d : 0; })();

// ระดับเสียง — ไม่มีสตรีมเสียง กับ มีสตรีมแต่เงียบสนิท เป็นคนละเรื่อง ต้องแยกให้ออก
let vol = null;
if (a) {
  const { err } = run('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = err.match(/mean_volume:\s*(-?[\d.]+)/), max = err.match(/max_volume:\s*(-?[\d.]+)/);
  vol = { mean: mean ? +mean[1] : null, max: max ? +max[1] : null };
}

// ---------- 2. รอยคัต ----------

const sceneOut = run('ffmpeg', ['-v', 'error', '-i', file,
  '-vf', `select='gt(scene,${THRESH})',metadata=print:file=-`, '-an', '-f', 'null', '-']).out || '';

const cuts = [];
{
  let t = null;
  for (const line of sceneOut.split('\n')) {
    const pt = line.match(/pts_time:([\d.]+)/);
    if (pt) t = +pt[1];
    const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && t !== null) { cuts.push({ t, score: +sc[1] }); t = null; }
  }
}

// ช็อต = ช่วงระหว่างรอยคัต (นับต้นคลิปเป็นช็อตแรกเสมอ)
const bounds = [0, ...cuts.map((c) => c.t), dur];
const shots = [];
for (let i = 0; i < bounds.length - 1; i++) {
  const len = bounds[i + 1] - bounds[i];
  if (len > 0.15) shots.push({ from: bounds[i], to: bounds[i + 1], len });   // <0.15 วิ = คัตซ้อน ไม่ใช่ช็อต
}

// ---------- 3. จังหวะซูม ----------

// ดึงเฟรมเทาทั้งคลิปทีเดียว แล้ววัดในหน่วยความจำ — เรียก ffmpeg รอบเดียวเร็วกว่าดึงทีละใบมาก
const raw = run('ffmpeg', ['-v', 'error', '-i', file,
  '-vf', `fps=${FPS},scale=${PW}:${PH},format=gray`, '-f', 'rawvideo', '-'], true).out;

const frameCount = raw ? Math.floor(raw.length / (PW * PH)) : 0;

// แถบกลางเฟรม (แถว 40–60%) เฉลี่ยลงเป็นโปรไฟล์ 1 มิติ แล้วเอาความชัน
// ใช้แถบกลางเพราะเป็นที่ที่ของอยู่จริง ขอบบน-ล่างมักเป็นฟ้ากับพื้นเรียบ ให้ค่าศูนย์
const profileOf = (idx) => {
  const off = idx * PW * PH;
  const y0 = Math.floor(PH * 0.40), y1 = Math.floor(PH * 0.60);
  const p = new Float64Array(PW);
  for (let y = y0; y < y1; y++) for (let x = 0; x < PW; x++) p[x] += raw[off + y * PW + x];
  const n = y1 - y0;
  const g = new Float64Array(PW);
  for (let x = 2; x < PW - 2; x++) g[x] = Math.abs(p[x + 2] - p[x - 2]) / n;
  return g;
};

const corr = (u, w) => {
  let su = 0, sw = 0, n = 0;
  for (let i = 0; i < u.length; i++) { su += u[i]; sw += w[i]; n++; }
  const mu = su / n, mw = sw / n;
  let num = 0, du = 0, dw = 0;
  for (let i = 0; i < u.length; i++) { const x = u[i] - mu, y = w[i] - mw; num += x * y; du += x * x; dw += y * y; }
  return du > 0 && dw > 0 ? num / Math.sqrt(du * dw) : -2;
};

// ยืด/หดโปรไฟล์รอบจุดกึ่งกลางด้วย factor s แล้วอ่านค่าแบบ linear
const rescale = (g, s) => {
  const c = PW / 2, out = new Float64Array(PW);
  for (let x = 0; x < PW; x++) {
    const src = c + (x - c) / s;
    const i = Math.floor(src), fr = src - i;
    out[x] = (i >= 0 && i < PW - 1) ? g[i] * (1 - fr) + g[i + 1] * fr : 0;
  }
  return out;
};

// scale ของเฟรม i+1 เทียบเฟรม i — >1 คือภาพใหญ่ขึ้น (ซูมเข้า)
const steps = [];
for (let i = 0; i + 1 < frameCount; i++) {
  const t = (i + 1) / FPS;
  if (cuts.some((c) => Math.abs(c.t - t) < 1 / FPS)) { steps.push({ t, s: null, r: null, cut: true }); continue; }
  const ga = profileOf(i), gb = profileOf(i + 1);
  let best = { s: 1, r: -2 };
  for (const s of SCALES) { const r = corr(ga, rescale(gb, s)); if (r > best.r) best = { s, r }; }
  steps.push({ t, s: best.s, r: best.r, cut: false });
}

// รวมช่วงที่สเกลเบนจาก 1 ติดกัน = จังหวะซูม 1 ครั้ง
// เกณฑ์: เบนเกิน 1% ต่อช่วง และ r ≥ 0.5 (ต่ำกว่านี้แปลว่าลายเส้นเปลี่ยนไปมาก วัดสเกลไม่ได้)
const MOVES = [];
{
  let cur = null;
  for (const st of steps) {
    const moving = st.s !== null && st.r >= 0.5 && Math.abs(st.s - 1) >= 0.01;
    const dir = moving ? Math.sign(st.s - 1) : 0;
    if (dir !== 0 && cur && cur.dir === dir) { cur.to = st.t; cur.factor *= st.s; cur.rs.push(st.r); }
    else { if (cur) MOVES.push(cur); cur = dir === 0 ? null : { dir, from: st.t - 1 / FPS, to: st.t, factor: st.s, rs: [st.r] }; }
  }
  if (cur) MOVES.push(cur);
}
const zooms = MOVES.filter((m) => Math.abs(m.factor - 1) >= 0.06);   // ต่ำกว่า 6% ตาคนแทบไม่เห็น ไม่นับเป็นจังหวะ

// ---------- 4. ขนาดภาพต่อช็อต ----------

// ความหนาแน่นของลายเส้นทั้งเฟรม = ตัวแทนของ "ภาพกว้างแค่ไหน"
// ภาพกว้างของสวนมีใบไม้ อิฐ ราวบ้าน เต็มไปหมด → ลายเส้นถี่
// โคลสอัพมือวางหินมีผิวเรียบใหญ่ๆ ไม่กี่ชิ้น → ลายเส้นห่าง
// ⚠️ เป็นตัวแทน ไม่ใช่คำตอบ — ภาพกว้างของสนามหญ้าโล่งก็ลายเส้นห่างได้เหมือนกัน
// เลขนี้ใช้จัดอันดับช็อตในคลิปเดียวกัน ห้ามเอาไปเทียบข้ามคลิป และต้องยืนยันด้วยแถบภาพเสมอ
const detailAt = (idx) => {
  const off = idx * PW * PH;
  let sum = 0, n = 0;
  for (let y = 2; y < PH - 2; y += 2) for (let x = 2; x < PW - 2; x += 2) {
    sum += Math.abs(raw[off + y * PW + x + 2] - raw[off + y * PW + x - 2]); n++;
  }
  return n ? sum / n : null;
};

for (const s of shots) {
  const i0 = Math.ceil(s.from * FPS), i1 = Math.min(frameCount - 1, Math.floor(s.to * FPS));
  const vals = [];
  for (let i = i0; i <= i1; i++) if (i >= 0 && i < frameCount) vals.push(detailAt(i));
  s.detail = median(vals.filter((x) => x !== null));
  s.mid = s.from + s.len / 2;
}
const detailMed = median(shots.map((s) => s.detail).filter((x) => x !== null));

// แถบภาพตัวแทนช็อต — เอาเฟรมกลางของแต่ละช็อตมาต่อกัน ไว้ยืนยันด้วยตาว่าเลขข้างบนอ่านถูก
const strip = join(dirname(file), basename(file).replace(/\.[^.]+$/, '') + '-shots.png');
{
  const args = ['-v', 'error', '-y'];
  shots.forEach((s) => args.push('-ss', String(s.mid.toFixed(2)), '-i', file));
  const filt = shots.map((_, i) => `[${i}:v]scale=200:-1,setsar=1[v${i}]`).join(';')
    + ';' + shots.map((_, i) => `[v${i}]`).join('') + `hstack=inputs=${shots.length}[o]`;
  if (shots.length === 1) run('ffmpeg', [...args, '-vf', 'scale=200:-1', '-frames:v', '1', strip]);
  else run('ffmpeg', [...args, '-filter_complex', filt, '-map', '[o]', '-frames:v', '1', strip]);
}

// ---------- รายงาน ----------

const shotLens = shots.map((s) => s.len);
console.log(`\n=== ${basename(file)} ===`);
console.log(`ความยาว ${f(dur)} วิ · ${v.width}x${v.height} · ${f(fps, 1)} fps · ${v.codec_name}`);
console.log(`เสียง    ${a ? `${a.codec_name} ${a.channels}ch · mean ${f(vol?.mean, 1)} dB · max ${f(vol?.max, 1)} dB` : '⛔ ไม่มีสตรีมเสียง'}`);

console.log(`\n— ช็อต (เกณฑ์คัต ${THRESH}) —`);
console.log(`${shots.length} ช็อต · ช็อตละ ค่ากลาง ${f(median(shotLens))} วิ (สั้นสุด ${f(Math.min(...shotLens))} · ยาวสุด ${f(Math.max(...shotLens))})`);
console.log(`  #   ช่วงเวลา          ยาว     ลายเส้น   เทียบค่ากลาง`);
shots.forEach((s, i) => {
  const rel = s.detail && detailMed ? s.detail / detailMed : null;
  const tag = rel === null ? '' : rel < 0.80 ? '  ← ภาพแคบกว่าช็อตอื่น' : rel > 1.20 ? '  ← ภาพกว้างกว่าช็อตอื่น' : '';
  console.log(`  #${String(i + 1).padStart(2)}  ${f(s.from)}–${f(s.to)} วิ   ${f(s.len)} วิ   ${f(s.detail, 1).padStart(6)}   ${f(rel, 2)}×${tag}`);
});
if (!cuts.length) console.log('  ⚠️ ไม่พบรอยคัตเลย — เป็นช็อตเดียวยาว หรือคัตแบบ dissolve ที่ scene score จับไม่ได้');
else console.log(`  คะแนนรอยคัต: ${cuts.map((c) => f(c.t) + 'วิ(' + f(c.score) + ')').join(' · ')}`);
console.log(`  ⚠️ คอลัมน์ลายเส้นเป็นแค่ตัวชี้ ต้องเปิดแถบภาพยืนยันว่าช็อตไหนเป็นโคลสอัพจริง`);

console.log(`\n— กล้องขยับในช็อตไหม (สุ่ม ${FPS} เฟรม/วิ · ${frameCount} เฟรม) —`);
if (!zooms.length) console.log('  ไม่พบการเคลื่อนกล้องที่เกิน 6% — กล้องนิ่งอยู่กับที่ตลอดทุกช็อต');
zooms.forEach((m, i) => {
  const rMed = median(m.rs);
  console.log(`  #${i + 1} ${m.dir > 0 ? 'เข้าใกล้' : 'ถอยห่าง'} ${f(m.from)}–${f(m.to)} วิ · นาน ${f(m.to - m.from)} วิ · ${f(m.factor, 3)}× · r ${f(rMed)}${rMed < 0.5 ? ' ⚠️ เชื่อไม่ได้' : ''}`);
});
console.log(`  (การเปลี่ยนขนาดภาพแบบ *คัต* ไม่โผล่ตรงนี้ — ไปดูที่ตารางช็อตข้างบน)`);

console.log(`\nแถบภาพตัวแทนช็อต → ${strip}`);
console.log('');
