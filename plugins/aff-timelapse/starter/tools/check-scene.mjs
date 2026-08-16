#!/usr/bin/env node
// ตรวจฉากทั้งฉากด้วยการวัด ไม่ใช่ด้วยตา
//
//   node tools/check-scene.mjs scenes/<scene-slug> [--stage frames|prompts|clips|reel|caption]
//
// ทุกด่านคืน PASS / FAIL / WARN / SKIP · exit 1 ถ้ามี FAIL สักข้อ
// เจตนา: ให้แต่ละงานมีจุดตรวจที่ "วัดได้เอง" แล้วแก้ให้เขียวก่อนไปงานถัดไป
// ห้ามข้ามด่านที่แดงไปทำงานถัดไป เพราะทุกด่านที่แดงจะไปโผล่เป็นงานยิงใหม่ที่แพงกว่าเสมอ

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const W = 720, H = 1280;                 // ทุกอย่างถูกย่อมาที่ขนาดนี้ก่อนวัด จะได้เทียบ % กันได้
const PHASES = [1, 2, 3, 4];
const SEGS = [1, 2, 3];
const DEFAULT_PIN_TOL = 2.0;             // % ของความสูงเฟรม
const MIN_PIN_CONTRAST = 25;             // ต่ำกว่านี้ถือว่า noise วัดไม่ได้ ไม่ใช่ว่าไม่ผ่าน
const DUR_MIN = 7.5, DUR_MAX = 8.6;
const VOL_MIN = -35, VOL_MAX = -15;
const BRIGHT_SPREAD_WARN = 45;
const SAT_MIN = 18;                      // ความอิ่มสีขั้นต่ำของภาพจบ — ต่ำกว่านี้ภาพดูซีด
// ห่างจากใบที่ดีสุดของฉากเท่าไหร่ถึงเรียกว่าองค์ประกอบเพี้ยน — วัดมาจากของจริง:
// ฉากที่รับไปแล้วห่างกันเอง 0.08-0.13 · ใบที่ตาเห็นว่าวาดใหม่ห่าง 0.21 · ใบสองอ้างอิงห่าง 0.34
// ช่วง 0.10-0.15 จึงเป็นเขตคาบเกี่ยว = WARN ให้ไปเปิดดู ไม่ใช่ตัดสินว่าตก
const SSIM_WARN = 0.10;
const SSIM_FAIL = 0.15;
const STATIC_BAND = { x: 0, y: 0, w: 1, h: 0.4 };  // โซนที่ห้ามเปลี่ยน (สัดส่วน) — ทับได้ที่ phase4.json
const CUT_THRESH = 0.20;                 // เกณฑ์ scene score ที่นับว่าเป็นคัต
const CUT_MAX = 5;                       // สั่งไป 2-3 ครั้ง เกิน 5 = ตัดมั่ว
const CUT_TAIL_GUARD = 1.0;              // ห้ามมีคัตใน N วินาทีสุดท้าย — รอยต่อ F2F จะขาด

const sceneDir = process.argv[2];
const stageArg = (process.argv.includes('--stage')
  ? process.argv[process.argv.indexOf('--stage') + 1] : null);

if (!sceneDir || !existsSync(sceneDir)) {
  console.error('ใช้: node tools/check-scene.mjs scenes/<scene-slug> [--stage frames|prompts|clips|reel|caption]');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'scenechk-'));
const results = [];

// ยกเว้นข้อที่ "รู้แล้วและตัดสินใจไม่แก้" — ต้องเขียนเหตุผลไว้ที่ scenes/<scene>/qa-accepted.json
//   { "prompts/phase2.md": "เหตุผลว่าทำไมถึงปล่อยไว้ ..." }
// เหตุผลต้องยาวอย่างน้อย 30 ตัวอักษร ไม่งั้นยังนับเป็น FAIL อยู่
// เจตนา: ห้ามมีข้อไหนค้างแดงเงียบๆ — ต้องแก้ให้เขียว หรือเขียนเหตุผลกำกับว่าทำไมถึงยอมรับ
const waiverPath = join(sceneDir ?? '.', 'qa-accepted.json');
const waivers = existsSync(waiverPath) ? JSON.parse(readFileSync(waiverPath, 'utf8')) : {};
const usedWaivers = new Set();

const rec = (stage, name, status, detail) => {
  if (status === 'FAIL') {
    const key = `${stage}/${name}`;
    const why = waivers[key];
    if (typeof why === 'string' && why.trim().length >= 30) {
      usedWaivers.add(key);
      results.push({ stage, name, status: 'ACCEPTED', detail: `${detail}\n      ↳ ยอมรับไว้: ${why}` });
      return;
    }
    if (why !== undefined) {
      results.push({ stage, name, status: 'FAIL', detail: `${detail} — (qa-accepted.json มีคีย์นี้แต่เหตุผลสั้นเกิน 30 ตัวอักษร)` });
      return;
    }
  }
  results.push({ stage, name, status, detail });
};

// ---------- เครื่องมือวัด ----------

const run = (cmd, args, binary = false) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28, encoding: binary ? 'buffer' : 'utf8' });
  return { out: r.stdout, err: (binary ? r.stderr?.toString('utf8') : r.stderr) || '', code: r.status };
};

// คอลัมน์แนวตั้งกว้าง 12px ที่ x → ย่อเหลือ 1px → ค่าเทา 1280 ค่า
const grayColumn = (img, xFrac) => {
  const x = Math.round(W * xFrac);
  const vf = `scale=${W}:${H},crop=12:${H}:${Math.min(x, W - 12)}:0,scale=1:${H},format=gray`;
  const { out } = run('ffmpeg', ['-v', 'error', '-i', img, '-vf', vf, '-f', 'rawvideo', '-'], true);
  return out && out.length >= H ? out.subarray(0, H) : null;
};

// หาแถวที่ค่าเทากระโดดแรงที่สุดในช่วงที่กำหนด = ขอบของหมุด
const findPin = (col, from, to) => {
  if (!col) return null;
  let best = { contrast: 0, y: null };
  for (let y = Math.max(2, Math.floor(from * H)); y < Math.min(H - 3, Math.ceil(to * H)); y++) {
    const d = Math.abs(col[y + 2] - col[y - 2]);
    if (d > best.contrast) best = { contrast: d, y };
  }
  return best.y === null ? null : { pct: (best.y / H) * 100, contrast: best.contrast };
};

const measurePin = (img, pin) => findPin(grayColumn(img, pin.x), pin.from, pin.to);

// เลื่อนแนวตั้งจริงระหว่างสองภาพ วัดด้วย cross-correlation ของ "ความชัน" ทั้งคอลัมน์
//
// ⚠️ ทำไมไม่ใช้หมุดเดี่ยวกับเฟรมวิดีโอ: หมุดเดี่ยวคือ "ขอบที่แรงที่สุดในช่วงนี้"
// เฟรมวิดีโอมีคอนทราสต์กับ noise ต่างจากภาพนิ่ง ขอบที่แรงที่สุดจึงสลับตัวได้
// เคยอ่านได้ว่าเลื่อน 11.6% ทั้งที่ correlation บอกว่าเลื่อนจริงแค่ 6px = 0.5%
// (ฉากหน้าบ้าน seg1 · ยืนยันด้วยตาแล้วว่าเฟรมตรงกัน) — **หมุดเดี่ยวใช้กับภาพนิ่งเท่านั้น**
const shiftBetween = (imgA, imgB, x) => {
  const a = grayColumn(imgA, x), b = grayColumn(imgB, x);
  if (!a || !b) return null;
  const grad = (c) => Array.from(c, (_, i) => (i > 1 && i < H - 2 ? Math.abs(c[i + 2] - c[i - 2]) : 0));
  const ga = grad(a), gb = grad(b);
  let best = { s: 0, r: -2 };
  for (let s = -80; s <= 80; s++) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 100; i < H - 100; i++) {
      const p = ga[i], q = gb[i + s];
      if (q === undefined) continue;
      n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
    }
    const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
    const r = den ? (n * sab - sa * sb) / den : -2;
    if (r > best.r) best = { s, r };
  }
  return { pct: Math.abs(best.s) / H * 100, r: best.r };
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const brightness = (img) => {
  const { out } = run('ffmpeg', ['-v', 'error', '-i', img,
    '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], true);
  if (!out || !out.length) return null;
  let s = 0;
  for (const v of out) s += v;
  return s / out.length;
};

// "เฟรมนี้เป็นเฟสไหน" วัดด้วย correlation ของ **ลายเส้น** (gradient) ทั้งเฟรม
//
// ⚠️ วิธีที่ลองแล้วใช้ไม่ได้ ทั้งคู่ตัดสินผิดกับฉากจริงในโปรเจคนี้:
//   1. PSNR ทั้งเฟรม — เฉลี่ยกำลังสอง คนหนึ่งคนที่กินพื้นที่ 20% ของภาพนิ่งดันคะแนนลง
//      จนภาพผิดใบชนะ (balcony-wpc-walnut seg1 อ่านว่าจบที่ P1 ทั้งที่เหมือน P2 ทุกชิ้น)
//   2. ค่ากลางของผลต่างรายพิกเซล — ทนคนได้ แต่ถูกพื้น/ฝ้า/ผนังเรียบซึ่งเหมือนกันทุกเฟส
//      กลบจนแยกเฟสไม่ออก (livingroom-tv-wall-oak seg1 กับ seg2 อ่านว่าจบที่ P1 ทั้งคู่)
// ลายเส้นแก้ทั้งสองข้อ เพราะพื้นที่เรียบให้ค่าศูนย์ ไม่มีน้ำหนัก
// ส่วนที่ต่างกันจริงระหว่างเฟส (ระแนง ศาลา ชิงช้า ของกอง) ล้วนเป็นลายเส้นทั้งนั้น
// ทดสอบกับ 4 เคสจริงที่รู้คำตอบแล้ว ตอบถูกทั้งหมดโดยมีระยะห่างชัดเจน
const SW = 180, SH = 320;
const gradient = (img) => {
  const { out } = run('ffmpeg', ['-v', 'error', '-i', img,
    '-vf', `scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-'], true);
  if (!out || out.length < SW * SH) return null;
  const g = new Float64Array(SW * SH);
  for (let y = 1; y < SH - 1; y++) {
    for (let x = 1; x < SW - 1; x++) {
      const i = y * SW + x;
      g[i] = Math.abs(out[i + 1] - out[i - 1]) + Math.abs(out[i + SW] - out[i - SW]);
    }
  }
  return g;
};
const gradCorr = (a, b) => {
  if (!a || !b) return null;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den ? (n * sab - sa * sb) / den : null;
};

const probe = (file, entries) => run('ffprobe',
  ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1:nk=1', file]).out.trim().split('\n');

const meanVolume = (file) => {
  const { err } = run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = err.match(/mean_volume:\s*(-?[0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
};

// ความอิ่มสีของ **กลางเฟรม** — signalstats พิมพ์ที่ stderr ระดับ info ต้องไม่ใช้ -v error
//
// ⚠️ ทำไมไม่วัดทั้งเฟรม: วัดมาแล้วแล้วมันตัดสินผิด
// ยิงภาพเทียบกันสองใบด้วยพรอมต์เดียวกันต่างกันแค่การจัดฉาก ใบที่**สวยกว่าชัดเจน**
// (ไฟติด หมอนลาย ต้นไม้หลายกระถาง) กลับได้คะแนน 8.6 ส่วนใบที่จืดกว่าได้ 12.9
// เพราะใบสวยถ่ายลอดประตู ได้ขอบประตูเทาๆ ฟ้าโอเวอร์ขาว และพื้นระเบียงกินเฟรมเกือบครึ่ง
// พิกเซลจืดพวกนั้นเจือค่าเฉลี่ยลงจนกลบส่วนที่มีสีจริง
// → ตัดเหลือกลาง 60%x50% ซึ่งเป็นที่ที่ของจริงอยู่ ท้องฟ้ากับขอบเฟรมไม่เข้ามาปน
const saturation = (file) => {
  const { err } = run('ffmpeg', ['-hide_banner', '-i', file,
    '-vf', 'crop=iw*0.6:ih*0.5:iw*0.2:ih*0.28,signalstats,metadata=print', '-f', 'null', '-']);
  const m = err.match(/SATAVG=([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
};

// SSIM ของ "โซนที่ห้ามเปลี่ยน" — วัดว่าองค์ประกอบยังเป็นฉากเดียวกันกับภาพหมุดหรือเปล่า
//
// **นิยามของคำว่าผ่านในโปรเจคนี้คือ "องค์ประกอบเหมือน P4 ที่ถอยเวลากลับมา"** ไม่ใช่ตัวเลขผ่าน
// หมุด 3-4 คอลัมน์เป็นสายสะดุดราคาถูก แต่มันมองไม่เห็นว่าที่เหลือของเฟรมถูกวาดใหม่หรือเปล่า
//
// ⛔ เคสจริงที่ทำให้ต้องมีด่านนี้: ใบ P2 ที่ยิงด้วย "สองอ้างอิง" ได้ SSIM โซนบนแค่ 0.312
// (แย่สุดในสี่ใบที่เทียบ) **แต่ผ่านหมุดทั้งสามเส้น** เพราะคอลัมน์ที่เลือกบังเอิญตกบนขอบที่ตรงกัน
// ส่วนผนังกับรั้วที่เหลือถูกวาดใหม่หมด — ถ้าเชื่อหมุดอย่างเดียวจะปล่อยใบนั้นผ่านไปทำวิดีโอ
//
// ⚠️ ค่าที่ได้ไม่เคยใกล้ 1.0 (ของจริงอยู่ราว 0.55-0.60) เพราะทุกใบเป็น generative edit
// ที่เรนเดอร์ใหม่ทั้งภาพ ไม่ใช่ inpaint ที่แปะเฉพาะโซน
// → ตัดสินด้วย **ห่างจากใบที่ดีที่สุดของฉากเท่าไหร่** ไม่ใช่ค่าสัมบูรณ์
const ssimBand = (fileA, fileB, band, tag) => {
  const crop = `crop=iw*${band.w}:ih*${band.h}:iw*${band.x}:ih*${band.y}`;
  const a = join(tmp, `ssim-a-${tag}.png`), b = join(tmp, `ssim-b-${tag}.png`);
  run('ffmpeg', ['-v', 'error', '-y', '-i', fileA, '-vf', crop, a]);
  run('ffmpeg', ['-v', 'error', '-y', '-i', fileB, '-vf', crop, b]);
  if (!existsSync(a) || !existsSync(b)) return null;
  const { err } = run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-']);
  const m = err.match(/All:([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
};

// รอยคัตในคลิป — ใช้ scene score เหมือน tools/study-clip.mjs
// เกณฑ์ต่ำกว่าค่ามาตรฐาน (0.3) ตั้งใจ เพราะคัตจากภาพกว้างไปโคลสอัพในฉากเดียวกัน
// สี แสง พื้นหลังยังเหมือนเดิมเกือบหมด คะแนนจึงต่ำกว่าคัตข้ามฉาก
const cutsIn = (video) => {
  const { out } = run('ffmpeg', ['-v', 'error', '-i', video,
    '-vf', `select='gt(scene,${CUT_THRESH})',metadata=print:file=-`, '-an', '-f', 'null', '-']);
  const ts = [];
  let t = null;
  for (const line of (out || '').split('\n')) {
    const pt = line.match(/pts_time:([0-9.]+)/);
    if (pt) t = +pt[1];
    if (/lavfi\.scene_score=/.test(line) && t !== null) { ts.push(t); t = null; }
  }
  return ts;
};

const frameAt = (video, which, tag) => {
  const outPng = join(tmp, `${tag}.png`);
  const args = which === 'first'
    ? ['-v', 'error', '-y', '-i', video, '-frames:v', '1', outPng]
    : ['-v', 'error', '-y', '-sseof', '-0.09', '-i', video, '-update', '1', '-frames:v', '1', outPng];
  run('ffmpeg', args);
  return existsSync(outPng) ? outPng : null;
};

const f = (n, d = 1) => (n === null || n === undefined ? '—' : n.toFixed(d));

// ---------- ด่านที่ 1 · frames ----------

const framePath = (n) => join(sceneDir, 'frames', `phase${n}.png`);

// โหลดหมุดตั้งแต่ต้น ไม่ใช่ตอนรันด่าน frames — ไม่งั้นสั่ง --stage clips เดี่ยวๆ แล้วหมุดหาย
const invPathTop = join(sceneDir, 'frames', 'phase4.json');
const pins = existsSync(invPathTop) ? (JSON.parse(readFileSync(invPathTop, 'utf8')).pins ?? []) : [];

function stageFrames() {
  const missing = PHASES.filter((n) => !existsSync(framePath(n)));
  if (missing.length) {
    rec('frames', 'ภาพครบ 4 เฟส', 'FAIL', `ขาด phase${missing.join(', phase')}.png`);
    return false;
  }
  rec('frames', 'ภาพครบ 4 เฟส', 'PASS', '');

  const dims = PHASES.map((n) => probe(framePath(n), 'stream=width,height').join('x'));
  rec('frames', 'ขนาดภาพเท่ากันทุกเฟส',
    new Set(dims).size === 1 ? 'PASS' : 'FAIL', dims.join(' · '));

  const invPath = join(sceneDir, 'frames', 'phase4.json');
  if (!existsSync(invPath)) {
    rec('frames', 'มี phase4.json', 'FAIL', 'ไม่มีบัญชีของในภาพหมุด — พรอมต์เฟสอื่นตรวจไม่ได้');
    return false;
  }
  const inv = JSON.parse(readFileSync(invPath, 'utf8'));
  rec('frames', 'มี phase4.json', 'PASS',
    `fixed ${inv.fixed?.length ?? 0} · product ${inv.product?.length ?? 0} · styling ${inv.styling?.length ?? 0}`);

  if (!pins.length) {
    rec('frames', 'หมุดล็อกกล้อง', 'SKIP',
      'phase4.json ไม่มีคีย์ "pins" — เติม [{id,x,from,to,tol}] แล้วด่านนี้กับด่านคลิปจะวัดให้เอง');
  } else {
    for (const pin of pins) {
      const tol = pin.tol ?? DEFAULT_PIN_TOL;
      const vals = PHASES.map((n) => measurePin(framePath(n), pin));
      const good = vals.filter((v) => v && v.contrast >= MIN_PIN_CONTRAST);
      if (good.length < PHASES.length) {
        rec('frames', `หมุด ${pin.id}`, good.length >= 2 ? 'WARN' : 'SKIP',
          `คอนทราสต์ต่ำกว่า ${MIN_PIN_CONTRAST} ใน ${PHASES.length - good.length} เฟส = วัดไม่ได้ ไม่ใช่ไม่ผ่าน`);
        if (good.length < 2) continue;
      }
      const spread = Math.max(...good.map((v) => v.pct)) - Math.min(...good.map((v) => v.pct));
      const detail = `${vals.map((v, i) => `P${i + 1} ${f(v?.pct)}%`).join(' · ')} → กว้าง ${f(spread, 2)}% (เกณฑ์ ${tol}%)`;
      if (spread <= tol) { rec('frames', `หมุด ${pin.id} · ช่วงกว้างสุด`, 'PASS', detail); continue; }

      // หมุดเกินเกณฑ์ยังสรุปไม่ได้ว่ากล้องเลื่อน — ต้องถามคอลัมน์เดิมด้วย cross-correlation ก่อน
      // เพราะ "ขอบที่แรงที่สุดในช่วงนี้" สลับตัวได้เมื่อของในคอลัมน์นั้นเปลี่ยนไปตามเฟส
      // ซึ่งเกิดขึ้นเป็นปกติกับคอลัมน์ที่สินค้าไปตั้งอยู่ (เคสจริง: หมุดขอบปูนอ่านได้ 5.55%
      // ทั้งที่คอลัมน์เดียวกัน correlation ให้ r=0.99 เลื่อน 0.00% = ไม่ขยับเลย)
      const shifts = PHASES.slice(1).map((n) => shiftBetween(framePath(n), framePath(1), pin.x))
        .filter((s) => s && s.r >= 0.5);
      if (shifts.length >= 2 && shifts.every((s) => s.pct <= tol)) {
        rec('frames', `หมุด ${pin.id} · ช่วงกว้างสุด`, 'WARN',
          `${detail} — แต่ correlation ของคอลัมน์เดียวกันบอกว่าเลื่อน ` +
          `${shifts.map((s) => f(s.pct, 2) + '%').join('/')} (r ${shifts.map((s) => f(s.r, 2)).join('/')}) ` +
          `= กล้องไม่ได้ขยับ หมุดไปเกาะขอบคนละเส้นเพราะของในคอลัมน์นี้เปลี่ยนตามเฟส`);
      } else {
        rec('frames', `หมุด ${pin.id} · ช่วงกว้างสุด`, 'FAIL',
          `${detail} — correlation ยืนยันด้วยว่าเลื่อนจริง หรือเชื่อถือไม่ได้ (r ต่ำ)`);
      }
    }
  }

  const br = PHASES.map((n) => brightness(framePath(n)));
  const brSpread = Math.max(...br) - Math.min(...br);
  rec('frames', 'ความสว่างไม่กระโดด', brSpread <= BRIGHT_SPREAD_WARN ? 'PASS' : 'WARN',
    `${br.map((b, i) => `P${i + 1} ${f(b)}`).join(' · ')} → ต่าง ${f(brSpread)}`);

  // ภาพจบซีดไหม — ภาพที่คนดูค้างอยู่นานที่สุดคือช็อตท้าย ถ้ามันซีดคือเสียของทั้งคลิป
  // เกณฑ์ 18 มาจากการวัดรีลจริง: ของเพจอ้างอิง 4/5 ใบผ่าน · ของเราตอนตั้งเกณฑ์ 1/6 ใบผ่าน
  // ⚠️ SATAVG เป็นตัวชี้ ไม่ใช่ความสวย — ภาพอิ่มสีจัดแต่รกก็ได้คะแนนสูง จึงเป็น WARN ไม่ใช่ FAIL
  const sat = saturation(framePath(4));
  rec('frames', 'ภาพจบไม่ซีด (P4)',
    sat === null ? 'SKIP' : sat >= SAT_MIN ? 'PASS' : 'WARN',
    sat === null ? 'วัดไม่ได้'
      : `SATAVG ${f(sat, 1)} (เกณฑ์ ${SAT_MIN})`
        + (sat < SAT_MIN ? ' — เปิดไฟดวงจริงในเฟรม · เพิ่มของแต่งเป็นชั้น · ใส่ผ้ามีลายมีสี 1 ชิ้น' : ''));

  // องค์ประกอบของโซนที่ห้ามเปลี่ยน — **นี่คือด่านที่ตรงกับนิยามของคำว่า "ผ่าน"**
  // ผ่าน = องค์ประกอบเหมือน P4 ที่ถอยเวลากลับมา ไม่ใช่หมุดตรงหรือ SATAVG ถึงเกณฑ์
  //
  // ตั้งโซนเองได้ที่ phase4.json คีย์ "static_band": {"x":0,"y":0,"w":1,"h":0.4}
  // ควรครอบเฉพาะส่วนที่ **ไม่มีงานเกิดขึ้นเลยทั้งสี่เฟส** (ผนัง รั้ว ฝ้า ต้นไม้ใหญ่)
  //
  // ⚠️ **เทียบกับ "ใบต้นทางในโซ่" ไม่ใช่เทียบกับ P4 ทุกใบ** — ทุกใบเป็น generative edit
  // ที่กินคุณภาพไปหนึ่งทอดต่อการยิงหนึ่งครั้ง ถ้าเอา P1 (ห่าง P4 สองทอด) ไปเทียบกับ
  // P3 (ห่างทอดเดียว) บนไม้บรรทัดเดียวกัน P1 จะแพ้ตลอดทั้งที่ไม่ได้ผิดอะไร
  // โซ่ปกติคือ P4 → P3 → P1 → P2 ทับได้ที่คีย์ "chain": {"1":3,"2":3,"3":4}
  const band = { ...STATIC_BAND, ...(inv.static_band ?? {}) };
  const chain = { 1: 3, 2: 3, 3: 4, ...(inv.chain ?? {}) };
  const ss = [1, 2, 3].map((n) => {
    const src = Number(chain[n] ?? chain[String(n)]);
    return { n, src, v: ssimBand(framePath(n), framePath(src), band, `p${n}`) };
  });
  const okv = ss.filter((o) => o.v !== null);
  const bandTxt = `โซน x${band.x} y${band.y} w${band.w} h${band.h}`;
  if (okv.length < 2) {
    rec('frames', 'องค์ประกอบโซนที่ห้ามเปลี่ยน', 'SKIP', `วัด SSIM ไม่ได้ (${bandTxt})`);
  } else {
    const best = Math.max(...okv.map((o) => o.v));
    const worst = Math.min(...okv.map((o) => o.v));
    const lag = okv.filter((o) => best - o.v > SSIM_WARN)
      .map((o) => `P${o.n} ห่าง ${f(best - o.v, 3)}`);
    const detail = ss.map((o) => `P${o.n}→P${o.src} ${o.v === null ? 'n/a' : f(o.v, 3)}`).join(' · ')
      + ` (${bandTxt} · ห่างจากใบดีสุดได้ไม่เกิน ${SSIM_WARN})`;
    rec('frames', 'องค์ประกอบโซนที่ห้ามเปลี่ยน',
      best - worst > SSIM_FAIL ? 'FAIL' : lag.length ? 'WARN' : 'PASS',
      lag.length
        ? `${detail} — ${lag.join(' · ')} · เปิดดูสองอย่าง `
          + '(1) โซนที่วัดมีของกลุ่ม styling/product หรือคนงานโผล่เข้ามาไหม ถ้ามีให้แคบ "static_band" '
          + 'ให้เหลือแต่ผนัง/รั้ว/ฝ้าที่นิ่งทั้งสี่เฟส (2) ถ้าโซนนิ่งจริงแต่ยังห่าง = ใบนั้นถูกวาดใหม่ '
          + 'ยิงซ้ำโดยแก้จากใบต้นทางในโซ่ **ใบเดียว** ห้ามใส่สองอ้างอิง'
        : `${detail} — ค่าราว 0.55-0.60 เป็นเพดานปกติของ generative edit ไม่ต้องไล่ให้ถึง 1.0`);
  }
  return true;
}

// ---------- ด่านที่ 2 · prompts ----------

function stagePrompts() {
  const checker = join('tools', 'check-phase-prompt.mjs');
  if (!existsSync(checker)) { rec('prompts', 'เครื่องตรวจพรอมต์', 'SKIP', 'ไม่มี tools/check-phase-prompt.mjs'); return; }
  // เครื่องตรวจพรอมต์อ่านจาก phase4.json ถ้าไม่มีบัญชี มันตรวจอะไรไม่ได้เลย
  // ต้องรายงานว่า "ตรวจไม่ได้เพราะขาดบัญชี" ไม่ใช่ "อ่านผลไม่ออก" ซึ่งชี้ไปผิดที่
  if (!existsSync(join(sceneDir, 'frames', 'phase4.json'))) {
    rec('prompts', 'พรอมต์ P1-P3', 'SKIP', 'ตรวจไม่ได้เพราะฉากนี้ไม่มี frames/phase4.json (ฉากเก่าก่อนมีกฎบัญชี)');
    return;
  }
  for (const n of [1, 2, 3]) {
    const rel = join('prompts', `phase${n}.md`);
    if (!existsSync(join(sceneDir, rel))) { rec('prompts', `phase${n}.md`, 'FAIL', 'ไม่มีไฟล์'); continue; }
    const r = run('node', [checker, sceneDir, rel]);
    const text = (r.out || '') + (r.err || '');
    // อ่านตัวเลขจากบรรทัดสรุป ไม่ใช่นับคำ — บรรทัดสรุปมีคำว่า ERROR กับ styling-leak อยู่แล้วเสมอ
    const num = (label) => {
      const m = text.match(new RegExp(`${label}\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) : null;
    };
    const errors = num('ERROR'), leaks = num('styling-leak'), warns = num('WARN');
    if (errors === null || leaks === null) {
      rec('prompts', `phase${n}.md`, 'FAIL', 'อ่านผลจากเครื่องตรวจไม่ออก — รูปแบบบรรทัดสรุปเปลี่ยนไป?');
      continue;
    }
    rec('prompts', `phase${n}.md`, errors || leaks ? 'FAIL' : 'PASS',
      `ERROR ${errors} · styling-leak ${leaks}${warns ? ` · WARN ${warns}` : ''}`);
  }
}

// ---------- ด่านที่ 3 · clips ----------

const clipPath = (n) => join(sceneDir, 'clips', `seg${n}.mp4`);

function stageClips() {
  const present = SEGS.filter((n) => existsSync(clipPath(n)));
  if (!present.length) { rec('clips', 'มีคลิป', 'SKIP', 'ยังไม่ได้ยิงวิดีโอ'); return; }
  if (present.length < SEGS.length) {
    rec('clips', 'มีคลิปครบ 3 ใบ', 'FAIL', `มีแค่ seg${present.join(', seg')}`);
  } else {
    rec('clips', 'มีคลิปครบ 3 ใบ', 'PASS', '');
  }

  const shapes = [];
  for (const n of present) {
    const file = clipPath(n);
    const dur = parseFloat(probe(file, 'format=duration')[0]);
    rec('clips', `seg${n} · ความยาว`, dur >= DUR_MIN && dur <= DUR_MAX ? 'PASS' : 'FAIL',
      `${f(dur, 3)} วิ (เกณฑ์ ${DUR_MIN}-${DUR_MAX})`);

    const types = probe(file, 'stream=codec_type');
    rec('clips', `seg${n} · สตรีมเสียง`, types.includes('audio') ? 'PASS' : 'FAIL',
      types.includes('audio') ? '' : 'ไม่มีเสียง = ลืมเปิดสวิตช์ Sound ตอนยิง ต้องยิงใหม่ทั้งคลิป');

    const vol = meanVolume(file);
    rec('clips', `seg${n} · ระดับเสียง`,
      vol !== null && vol >= VOL_MIN && vol <= VOL_MAX ? 'PASS' : 'FAIL',
      `mean ${f(vol)} dB (เกณฑ์ ${VOL_MIN} ถึง ${VOL_MAX} · −91 = เงียบสนิท)`);

    shapes.push(probe(file, 'stream=width,height,r_frame_rate').join('/'));

    const first = frameAt(file, 'first', `s${n}-first`);
    const last = frameAt(file, 'last', `s${n}-last`);

    // คู่เฟรมถูกใบไหม — เฟรมสุดท้ายต้องใกล้ phase(n+1) มากที่สุดในบรรดาสี่เฟส
    if (last) {
      const g = gradient(last);
      const scores = PHASES.map((p) => ({ p, v: gradCorr(g, gradient(framePath(p))) })).filter((s) => s.v !== null);
      if (scores.length === PHASES.length) {
        const sorted = [...scores].sort((a, b) => b.v - a.v);
        const want = n + 1;
        const mine = scores.find((s) => s.p === want);
        const gap = mine.v - sorted.find((s) => s.p !== want).v;   // ห่างจากคู่แข่งที่ใกล้ที่สุด
        const detail = `ลายเส้นตรงกัน ${scores.map((s) => `P${s.p} ${s.v.toFixed(3)}`).join(' · ')} (มาก=ใช่)`;
        if (sorted[0].p !== want) {
          rec('clips', `seg${n} · จบที่ P${want}`, 'FAIL',
            `ใกล้ P${sorted[0].p} มากกว่า P${want} → น่าจะเลือก end frame ผิดใบตอนยิง — ${detail}`);
        } else if (gap < 0.03) {
          rec('clips', `seg${n} · จบที่ P${want}`, 'WARN',
            `ชนะแค่ ${gap.toFixed(3)} ห่างไม่พอจะฟันธง ให้เทียบด้วยตาอีกที — ${detail}`);
        } else {
          rec('clips', `seg${n} · จบที่ P${want}`, 'PASS', detail);
        }
      }
    }

    // กล้องเลื่อนระหว่างคลิปไหม + ตรงกับภาพนิ่งไหม — วัดหลายคอลัมน์แล้วเอาค่ากลาง
    //
    // เอา median ไม่ใช่ค่าสูงสุด เพราะคนหรือของที่เดินผ่านหน้าเลนส์บังได้ทีละคอลัมน์
    // กล้องเลื่อนจริงจะทำให้ทุกคอลัมน์เลื่อนพร้อมกัน ค่ากลางจึงขยับตาม แต่ของบังตัวเดียวขยับค่ากลางไม่ได้
    // กวาดสี่คอลัมน์ที่กระจายทั่วเฟรมเสมอ แล้วเติมคอลัมน์ของหมุดเข้าไปด้วยถ้ามี
    // ยิ่งหลายคอลัมน์ยิ่งกัน "ของบังคอลัมน์เดียว" ได้ดี เพราะเราตัดสินด้วยค่ากลาง
    const cols = [...new Set([0.10, 0.35, 0.65, 0.90, ...pins.map((p) => p.x)])].sort((a, b) => a - b);
    const tol = pins[0]?.tol ?? DEFAULT_PIN_TOL;

    const shiftCheck = (label, imgA, imgB) => {
      if (!imgA || !imgB) { rec('clips', `seg${n} · ${label}`, 'SKIP', 'ดึงเฟรมไม่ได้'); return; }
      const rows = cols.map((x) => ({ x, ...(shiftBetween(imgA, imgB, x) ?? { pct: null, r: -2 }) }))
        .filter((r) => r.pct !== null);
      const usable = rows.filter((r) => r.r >= 0.25);
      if (usable.length < 2) { rec('clips', `seg${n} · ${label}`, 'SKIP', 'correlation ต่ำเกินจะเชื่อ'); return; }
      const mid = median(usable.map((r) => r.pct));
      const detail = rows.map((r) => `x${r.x} ${f(r.pct, 2)}%${r.r < 0.25 ? '(r ต่ำ)' : ''}`).join(' · ')
        + ` → ค่ากลาง ${f(mid, 2)}% (เกณฑ์ ${tol}%)`;
      rec('clips', `seg${n} · ${label}`, mid <= tol ? 'PASS' : 'FAIL', detail);
    };

    shiftCheck('กล้องเลื่อนในคลิป', first, last);
    shiftCheck(`เฟรมจบตรงกับ P${n + 1}`, last, framePath(n + 1));

    // คัตไปโคลสอัพแล้วกลับมุมหลัก — สั่งใน Camera: ของสตอรีบอร์ด
    // shiftCheck ข้างบนเทียบแค่เฟรมแรกกับเฟรมสุดท้าย คัตกลางคลิปจึงไม่โผล่ตรงนั้น ต้องนับแยก
    const cuts = cutsIn(file);
    const tail = cuts.filter((t) => dur - t <= CUT_TAIL_GUARD);
    const list = cuts.length ? cuts.map((t) => f(t, 2) + 'วิ').join(' · ') : 'ไม่มี';

    if (tail.length) {
      // อันตรายจริงข้อเดียวของการคัต — เฟรมจบจะเป็นภาพคนละมุมกับภาพนิ่งเฟสถัดไป
      rec('clips', `seg${n} · คัตท้ายคลิป`, 'FAIL',
        `มีคัตใน ${CUT_TAIL_GUARD} วิสุดท้ายที่ ${tail.map((t) => f(t, 2) + 'วิ').join(' · ')} — รอยต่อ F2F ขาด ต้องยิงใหม่`);
    } else if (cuts.length > CUT_MAX) {
      rec('clips', `seg${n} · จำนวนคัต`, 'FAIL', `${cuts.length} คัต (เกิน ${CUT_MAX}) — ตัดมั่ว · ${list}`);
    } else if (!cuts.length) {
      // ไม่ใช่คลิปเสีย แค่ไม่ได้ของที่ขอ — ถ้าใบนั้นไม่ได้สั่งคัตไว้ก็ถือว่าปกติ
      rec('clips', `seg${n} · จำนวนคัต`, 'WARN',
        'ไม่พบคัตเลย — ถ้าสั่งคัตไว้ใน Camera: แปลว่าโมเดลไม่ทำตาม (ถ้าไม่ได้สั่งก็ข้ามข้อนี้ได้)');
    } else {
      rec('clips', `seg${n} · จำนวนคัต`, 'PASS', `${cuts.length} คัต · ${list}`);
    }
  }

  rec('clips', 'ขนาด/fps เท่ากันทุกใบ', new Set(shapes).size === 1 ? 'PASS' : 'FAIL', shapes.join(' · '));
}

// ---------- ด่านที่ 4 · reel ----------

function stageReel() {
  const reel = join(sceneDir, 'final', 'reel.mp4');
  if (!existsSync(reel)) { rec('reel', 'มี final/reel.mp4', 'SKIP', 'ยังไม่ได้ต่อ'); return; }

  const present = SEGS.filter((n) => existsSync(clipPath(n)));
  const sum = present.reduce((s, n) => s + parseFloat(probe(clipPath(n), 'format=duration')[0]), 0);
  const dur = parseFloat(probe(reel, 'format=duration')[0]);
  const want = sum + 2;   // ค้างเฟรมจบ 2 วิ
  rec('reel', 'ความยาว = ผลรวมคลิป + ค้างจบ 2 วิ', Math.abs(dur - want) <= 0.25 ? 'PASS' : 'FAIL',
    `${f(dur, 2)} วิ (คาด ${f(want, 2)})`);

  const types = probe(reel, 'stream=codec_type');
  rec('reel', 'มีสตรีมเสียง', types.includes('audio') ? 'PASS' : 'FAIL', '');
  rec('reel', 'ไม่มีสตรีมซับ/ตัวหนังสือ', types.includes('subtitle') ? 'FAIL' : 'PASS',
    'reel ต้องเป็นภาพกับเสียงล้วน ผู้ใช้จัดชั้นตัวหนังสือเอง');

  const shape = probe(reel, 'stream=width,height').join('x');
  const clipShape = present.length ? probe(clipPath(present[0]), 'stream=width,height').join('x') : shape;
  rec('reel', 'ขนาดตรงกับคลิปต้นทาง', shape === clipShape ? 'PASS' : 'FAIL', `${shape} vs ${clipShape}`);

  const vol = meanVolume(reel);
  rec('reel', 'ระดับเสียง', vol !== null && vol >= VOL_MIN && vol <= VOL_MAX ? 'PASS' : 'FAIL',
    `mean ${f(vol)} dB`);
}

// ---------- ด่านที่ 5 · caption ----------

function stageCaption() {
  const cap = join(sceneDir, 'final', 'caption.md');
  if (!existsSync(cap)) { rec('caption', 'มี final/caption.md', 'SKIP', 'ยังไม่ได้เขียน'); return; }
  // \r?\n เพราะไฟล์ที่เขียนด้วยเครื่องมือคนละตัวบน Windows ได้ CRLF มา
  // เคยอ่านได้ 0 บล็อกทั้งที่ไฟล์มีแคปชันครบ 3 แบบ เพราะ regex ผูกกับ \n ตัวเดียว
  const blocks = [...readFileSync(cap, 'utf8').matchAll(/```\r?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  rec('caption', 'มีแคปชันอย่างน้อย 3 แบบ', blocks.length >= 3 ? 'PASS' : 'FAIL', `เจอ ${blocks.length} บล็อก`);

  blocks.forEach((b, i) => {
    const link = /https?:\/\/|shopee\.co\.th|s\.shopee/i.test(b);
    rec('caption', `แบบที่ ${i + 1} · ไม่มีลิงก์ในบอดี้`, link ? 'FAIL' : 'PASS',
      link ? 'ลิงก์ต้องไปอยู่คอมเมนต์แรก' : '');
    const price = /(฿\s*[\d,]|[\d,]{3,}\s*บาท)/.test(b);
    rec('caption', `แบบที่ ${i + 1} · ไม่มีราคา`, price ? 'FAIL' : 'PASS',
      price ? 'ราคาบน Shopee เปลี่ยนตลอด คลิปอยู่ยาวกว่าราคา' : '');
  });
}

// ---------- โหมดหาหมุด · node tools/check-scene.mjs <scene> --probe ----------
//
// ไม่ต้องเดาว่าจะใช้อะไรเป็นหมุด — กวาดทั้งเฟรมแล้วให้ตัวเลขบอกว่าคอลัมน์ไหนคมและนิ่งที่สุด
// แล้วก๊อปบรรทัดที่ได้ไปวางใน frames/phase4.json คีย์ "pins"

function probeMode() {
  if (!existsSync(framePath(4))) {
    console.error('ต้องมี frames/phase4.png ก่อนถึงจะหาหมุดได้'); process.exit(2);
  }
  // ปกติหาหมุดตอนมีครบ 4 เฟส จะได้วัด spread ด้วย
  // แต่ตอนเพิ่งได้ภาพหมุดใบเดียวก็ต้องหาหมุดให้ได้ เพราะต้องเอาไปเขียนลง phase4.json
  // ก่อนจะยิง P1-P3 — โหมดใบเดียวจึงจัดอันดับด้วยความคมของขอบแทน
  const avail = PHASES.filter((n) => existsSync(framePath(n)));
  const soloMode = avail.length < PHASES.length;
  if (soloMode) {
    console.log(`\n⚠️  มีภาพแค่ ${avail.length} เฟส (${avail.map((n) => 'P' + n).join(' ')})` +
      ' — จัดอันดับด้วยความคมของขอบอย่างเดียว ยังวัด spread ไม่ได้\n' +
      '    พอได้ครบ 4 เฟสแล้วให้รัน --probe ซ้ำเพื่อยืนยันว่าหมุดที่เลือกนิ่งจริง');
  }
  const bands = [[0.02, 0.25], [0.22, 0.50], [0.45, 0.75], [0.72, 0.98]];
  const cands = [];
  for (let x = 0.05; x <= 0.96; x += 0.05) {
    const cols = avail.map((n) => grayColumn(framePath(n), x));
    for (const [from, to] of bands) {
      const vals = cols.map((c) => findPin(c, from, to));
      if (vals.some((v) => !v || v.contrast < MIN_PIN_CONTRAST)) continue;
      const spread = Math.max(...vals.map((v) => v.pct)) - Math.min(...vals.map((v) => v.pct));
      cands.push({
        x: +x.toFixed(2), from, to, spread,
        contrast: Math.min(...vals.map((v) => v.contrast)),
        pcts: vals.map((v) => v.pct),
      });
    }
  }
  cands.sort(soloMode
    ? (a, b) => b.contrast - a.contrast
    : (a, b) => (a.spread - b.spread) || (b.contrast - a.contrast));
  console.log(soloMode
    ? '\nขอบที่คมที่สุด 12 อันดับแรก (contrast สูง = ขอบคม เชื่อถือได้)\n'
    : '\nคอลัมน์ที่นิ่งที่สุด 12 อันดับแรก (spread ต่ำ = ล็อกดี · contrast สูง = ขอบคม)\n');
  for (const c of cands.slice(0, 12)) {
    console.log(`  x=${c.x}  ช่วง ${c.from}-${c.to}  spread ${f(c.spread, 2)}%  contrast ${c.contrast}` +
      `   [${c.pcts.map((p) => f(p)).join(' · ')}]`);
    console.log(`    { "id": "pin-x${String(c.x).replace('.', '')}", "x": ${c.x}, "from": ${c.from}, "to": ${c.to}, "tol": 2.0 },`);
  }
  console.log('\nเลือก 2-3 อันที่อยู่คนละส่วนของเฟรม (บน/กลาง/ล่าง หรือ ซ้าย/ขวา)');
  console.log('อย่าเลือกสองอันที่อยู่คอลัมน์ติดกัน เพราะของชิ้นเดียวบังได้พร้อมกันทั้งคู่\n');
}

// ---------- รัน ----------

if (process.argv.includes('--probe')) { probeMode(); rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

const stages = {
  frames: stageFrames, prompts: stagePrompts, clips: stageClips, reel: stageReel, caption: stageCaption,
};
const order = stageArg ? [stageArg] : Object.keys(stages);
if (stageArg && !stages[stageArg]) { console.error(`ไม่รู้จักด่าน "${stageArg}"`); process.exit(2); }

console.log(`\n▶ ตรวจฉาก ${basename(sceneDir)}\n`);
for (const s of order) stages[s]();
rmSync(tmp, { recursive: true, force: true });

const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', SKIP: '⏭️ ', ACCEPTED: '🟡' };
let cur = null;
for (const r of results) {
  if (r.stage !== cur) { cur = r.stage; console.log(`\n── ${cur} ──`); }
  console.log(`${icon[r.status]} ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`);
}

// คีย์ที่เขียนยกเว้นไว้แต่ไม่มีข้อไหนแดงแล้ว = ยกเว้นค้าง ต้องลบทิ้ง ไม่งั้นมันจะกลบของจริงในอนาคต
const stale = Object.keys(waivers).filter((k) => !k.startsWith('_') && !usedWaivers.has(k));
if (stale.length) console.log(`\n⚠️  qa-accepted.json มีคีย์ที่ไม่ได้ใช้แล้ว ลบออกได้: ${stale.join(', ')}`);

const n = (s) => results.filter((r) => r.status === s).length;
console.log(`\nสรุป: ✅ ${n('PASS')} · ❌ ${n('FAIL')} · 🟡 ${n('ACCEPTED')} · ⚠️ ${n('WARN')} · ⏭️ ${n('SKIP')}\n`);
process.exit(n('FAIL') ? 1 : 0);
