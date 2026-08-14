// ดาวน์โหลดรูปสินค้า Shopee ลงเครื่องตรงๆ ได้ไฟล์ต้นฉบับเต็มความละเอียด
// ใช้: node fetch-images.mjs <โฟลเดอร์ปลายทาง> <url1> <url2> ...
//
// ต้องส่ง Referer เป็น shopee.co.th ไปด้วย ไม่งั้น CDN อาจปฏิเสธ
// ไฟล์ตั้งชื่อเรียงเป็น 01, 02, 03 ... นามสกุลดูจาก content-type ที่ตอบกลับมา

import { mkdir, writeFile } from 'node:fs/promises';

const [outDir, ...urls] = process.argv.slice(2);

if (!outDir || urls.length === 0) {
  console.error('ใช้: node fetch-images.mjs <โฟลเดอร์ปลายทาง> <url...>');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
let ok = 0;

for (const [i, url] of urls.entries()) {
  const n = String(i + 1).padStart(2, '0');
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://shopee.co.th/',
      },
    });

    if (!res.ok) {
      console.error(`${n} ไม่สำเร็จ (HTTP ${res.status})`);
      continue;
    }

    const type = (res.headers.get('content-type') || '').split(';')[0];
    const bytes = Buffer.from(await res.arrayBuffer());

    // ไฟล์เล็กผิดปกติมักเป็นรูป placeholder ที่ยังโหลดไม่เสร็จ ไม่ใช่รูปสินค้าจริง
    if (bytes.length < 5000) {
      console.error(`${n} ข้าม — ไฟล์เล็กผิดปกติ (${bytes.length} ไบต์)`);
      continue;
    }

    const file = `${outDir}/${n}.${EXT[type] ?? 'jpg'}`;
    await writeFile(file, bytes);
    console.log(`${n} ${Math.round(bytes.length / 1024)} KB -> ${file}`);
    ok++;
  } catch (err) {
    console.error(`${n} ผิดพลาด: ${err.message}`);
  }
}

console.log(`\nได้รูปทั้งหมด ${ok} จาก ${urls.length} รูป`);
