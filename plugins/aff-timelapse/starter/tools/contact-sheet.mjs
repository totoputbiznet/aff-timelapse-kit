#!/usr/bin/env node
// แผ่นเทียบ 4 เฟสของฉากหนึ่ง — เรียงตามเวลาเดินเรื่อง พร้อมกรอบโซนที่ด่าน SSIM วัด
//
//   node tools/contact-sheet.mjs scenes/<slug>
//   node tools/contact-sheet.mjs scenes/<slug> --out somewhere.png --width 430
//
// ทำไมต้องมี — `check-scene.mjs` ตอบว่าผ่านหรือไม่ผ่านเป็นตัวเลข แต่ตอบไม่ได้ว่า
// **โซนที่มันวัดครอบอะไรอยู่บ้าง** ซึ่งเป็นตัวแปรที่ทำให้ตัวเลขเชื่อถือได้หรือไม่ได้
// ใบนี้วาดกรอบโซนทับลงบนภาพจริงทั้งสี่ใบ ให้เห็นด้วยตาว่ามีของกลุ่ม styling/product
// หรือคนงานหลุดเข้าไปในโซนไหม แล้วพิมพ์ค่า SSIM ของแต่ละใบกำกับไว้ในแผ่นเดียวกัน
//
// ⚠️ แผ่นนี้เป็นของใช้ตรวจงาน **ไม่ใช่ของส่งออก** — `final/reel.mp4` ยังห้ามมีตัวหนังสือเหมือนเดิม

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const sceneDir = argv.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (!sceneDir) {
  console.error('ใช้: node tools/contact-sheet.mjs scenes/<slug> [--out ไฟล์.png] [--width 430]');
  process.exit(2);
}

const W = parseInt(flag('width', '430'), 10);
const BAR = 104;                                  // แถบชื่อด้านบนของแต่ละใบ
const HEAD = 56;                                  // แถบหัวเรื่องของทั้งแผ่น
const out = flag('out', join(sceneDir, 'frames', '_contact-sheet.png'));
const tmp = mkdtempSync(join(tmpdir(), 'sheet-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ปล่อย */ } });

const framePath = (n) => join(sceneDir, 'frames', `phase${n}.png`);
const missing = [1, 2, 3, 4].filter((n) => !existsSync(framePath(n)));
if (missing.length) { console.error(`⛔ ขาด phase${missing.join(', phase')}.png`); process.exit(1); }

const run = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });

// ── โซนที่วัด + โซ่ อ่านจาก phase4.json ให้ตรงกับที่ check-scene.mjs ใช้ ──
const invPath = join(sceneDir, 'frames', 'phase4.json');
const inv = existsSync(invPath) ? JSON.parse(readFileSync(invPath, 'utf8')) : {};
// `static_band` เป็นกล่องเดียวหรือ array หลายกล่องก็ได้ — ต้องอ่านเหมือน check-scene.mjs เป๊ะ
// ไม่งั้นแผ่นนี้จะวาดคนละโซนกับที่ด่านจริงวัด ซึ่งแย่กว่าไม่มีแผ่นเลย
const DEFAULT_BOX = { x: 0, y: 0, w: 1, h: 0.4 };
const boxes = Array.isArray(inv.static_band)
  ? inv.static_band.map((b) => ({ ...DEFAULT_BOX, ...b }))
  : [{ ...DEFAULT_BOX, ...(inv.static_band ?? {}) }];
const chain = { 1: 3, 2: 3, 3: 4, ...(inv.chain ?? {}) };

const ssimBand = (A, B, tag) => {
  let sum = 0, area = 0;
  for (const [i, box] of boxes.entries()) {
    const crop = `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y}`;
    const a = join(tmp, `a-${tag}-${i}.png`), b = join(tmp, `b-${tag}-${i}.png`);
    run(['-v', 'error', '-y', '-i', A, '-vf', crop, a]);
    run(['-v', 'error', '-y', '-i', B, '-vf', crop, b]);
    if (!existsSync(a) || !existsSync(b)) return null;
    const m = run(['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-']).stderr.match(/All:([0-9.]+)/);
    if (!m) return null;
    const wt = box.w * box.h;
    sum += parseFloat(m[1]) * wt; area += wt;
  }
  return area > 0 ? sum / area : null;
};

const dims = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', framePath(4)], { encoding: 'utf8' })
  .stdout.trim().split(',').map(Number);
const H = Math.round(dims[1] / dims[0] * W);

const NAMES = ['ว่างเปล่า / ก่อนทำ', 'ระหว่างทำ', 'งานเสร็จ ยังไม่จัดของ', 'จัดของเสร็จ = ภาพหมุด'];
const scores = [1, 2, 3].map((n) => ({ n, src: Number(chain[n] ?? chain[String(n)]), v: ssimBand(framePath(n), framePath(Number(chain[n] ?? chain[String(n)])), `p${n}`) }));
const okv = scores.filter((s) => s.v !== null).map((s) => s.v);
const spread = okv.length >= 2 ? Math.max(...okv) - Math.min(...okv) : null;

// ── ฟอนต์ไทย · ถ้าไม่มีก็ยังทำแผ่นได้ แค่ไม่มีตัวหนังสือ ──
const fontFile = ['assets/fonts/Prompt-SemiBold.ttf', 'assets/fonts/Sarabun-SemiBold.ttf']
  .find((p) => existsSync(p));
if (!fontFile) console.error('⚠️ ไม่เจอฟอนต์ใน assets/fonts — ทำแผ่นเปล่าไม่มีตัวหนังสือให้แทน');
const FF = fontFile ? fontFile.replace(/([:\\])/g, '\\$1') : null;
const esc = (s) => s.replace(/(['%:\\])/g, '\\$1');
const text = (s, opt) => FF ? `,drawtext=fontfile='${FF}':text='${esc(s)}':${opt}` : '';

const inputs = [], filters = [];
for (let i = 0; i < 4; i++) {
  const n = i + 1;
  const sc = scores.find((s) => s.n === n);
  const note = sc ? (sc.v === null ? 'วัดไม่ได้' : `SSIM ${sc.v.toFixed(3)} ← แก้จาก P${sc.src}`) : 'ต้นทางของทั้งโซ่';
  inputs.push('-i', framePath(n));
  // วาดทุกกล่อง · ป้ายกำกับติดที่กล่องแรกกล่องเดียว ไม่งั้นรกจนอ่านภาพไม่ออก
  const drawn = boxes.map((box, bi) => {
    const bx = Math.round(W * box.x), bw = Math.round(W * box.w);
    const by = Math.round(H * box.y), bh = Math.round(H * box.h);
    return `,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=#ff3b30@0.9:t=3`
      + (bi === 0
        ? text('โซนที่ห้ามเปลี่ยน', `fontcolor=white:fontsize=17:box=1:boxcolor=#ff3b30@0.85:boxborderw=6:x=${bx + 8}:y=${by + bh - 30}`)
        : '');
  }).join('');
  filters.push(
    `[${i}:v]scale=${W}:${H}` + drawn +
    `,pad=${W}:${H + BAR}:0:${BAR}:color=#14161a` +
    text(`P${n}`, 'fontcolor=#ffd166:fontsize=30:x=12:y=10') +
    text(NAMES[i], 'fontcolor=white:fontsize=19:x=58:y=16') +
    text(note, `fontcolor=${sc && sc.v === null ? '#ff9f43' : '#8fd3a6'}:fontsize=17:x=12:y=52`) +
    `[v${i}]`
  );
}

// หัวเรื่องต้องสั้นพอที่จะไม่ล้นขอบขวา — กว้างรวม = W*4 ที่ fontsize 21 ได้ราว 150 ตัวอักษร
const head = `${sceneDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()}`
  + ` · โซ่ P4 → P3 → P1 → P2 แก้จากภาพเดียวทุกใบ`
  + ` · กรอบแดง = โซนที่ SSIM วัด`
  + (boxes.length === 1 ? '' : ` (${boxes.length} กล่อง เว้นของที่ไม่ใช่ fixed ออก)`)
  + (spread === null ? '' : ` · ห่างกันมากสุด ${spread.toFixed(3)} / 0.10`);

// pad ต้องระบุ y=HEAD ด้วย ไม่งั้นที่ว่างไปโผล่ข้างล่างแล้วหัวเรื่องทับป้ายของแต่ละใบ
filters.push(`[v0][v1][v2][v3]hstack=inputs=4,pad=iw:ih+${HEAD}:0:${HEAD}:color=#14161a`
  + text(head, 'fontcolor=white:fontsize=21:x=14:y=17') + `[out]`);

const r = run(['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', out]);
if (r.status !== 0) { console.error(r.stderr.slice(0, 1500)); process.exit(1); }

console.log(`✅ ${out}`);
console.log(`   ${scores.map((s) => `P${s.n}→P${s.src} ${s.v === null ? 'n/a' : s.v.toFixed(3)}`).join(' · ')}`
  + (spread === null ? '' : `  → ห่าง ${spread.toFixed(3)}`));
