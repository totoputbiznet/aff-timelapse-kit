# ปล่อยรุ่นใหม่ของปลั๊กอิน aff-timelapse
#
#   .\release.ps1 1.5.1 "สรุปสั้นๆ ว่าแก้อะไร"
#
# ทำให้ครบทั้งชุด: เลื่อนเลขเวอร์ชันสองที่ · ตรวจ path ที่ออกนอกโฟลเดอร์ปลั๊กอิน ·
# claude plugin validate · commit · tag · push
#
# ⚠️ ลืมเลื่อนเลขเวอร์ชัน = เพื่อนไม่ได้ของใหม่ และไม่มีใครรู้ตัว
#    เพราะ Claude Code เห็นว่าเวอร์ชันเดิมแล้วข้ามการอัปเดตไปเงียบๆ
#    สคริปต์นี้มีไว้กันข้อนั้นโดยเฉพาะ

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Message
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pluginDir = Join-Path $root 'plugins\aff-timelapse'
$pluginJson = Join-Path $pluginDir '.claude-plugin\plugin.json'
$marketJson = Join-Path $root '.claude-plugin\marketplace.json'

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "เวอร์ชันต้องเป็นรูปแบบ X.Y.Z เช่น 1.5.1 (ได้มา: $Version)"
}

# ── 1. ตรวจ path ที่ออกนอกโฟลเดอร์ปลั๊กอิน ────────────────────────────────
# ตอนเพื่อนติดตั้ง ปลั๊กอินถูกก๊อปเข้า cache ของมันเอง path ที่วิ่งออกไปข้างนอกจะพังทันที
# ฝั่งเราไม่เจอเพราะรันผ่าน junction ที่ยังเห็นไฟล์รอบข้าง — ต้องดักตรงนี้เท่านั้น
$escapes = Select-String -Path (Join-Path $pluginDir 'skills\*\SKILL.md'), (Join-Path $pluginDir 'references\*.md') `
  -Pattern '\.\./\.\./\.\.' -ErrorAction SilentlyContinue
if ($escapes) {
  Write-Host "`n✘ เจอ path ที่ออกนอกโฟลเดอร์ปลั๊กอิน — ปล่อยรุ่นไม่ได้:" -ForegroundColor Red
  $escapes | ForEach-Object { Write-Host "   $($_.Filename):$($_.LineNumber)  $($_.Line.Trim())" }
  throw 'แก้ให้ชี้อยู่ในโฟลเดอร์ปลั๊กอินก่อน แล้วค่อยปล่อยรุ่น'
}

# ── 2. เลื่อนเลขเวอร์ชันสองที่ให้ตรงกัน ──────────────────────────────────
foreach ($f in @($pluginJson, $marketJson)) {
  $raw = Get-Content $f -Raw -Encoding utf8
  $new = [regex]::Replace($raw, '"version":\s*"[^"]*"', """version"": ""$Version""", 1)
  if ($new -eq $raw) { throw "หาบรรทัด version ใน $f ไม่เจอ" }
  Set-Content -Path $f -Value $new -Encoding utf8 -NoNewline
}
Write-Host "✔ เลื่อนเวอร์ชันเป็น $Version แล้วทั้ง plugin.json และ marketplace.json" -ForegroundColor Green

# ── 3. ให้ Claude Code ตรวจไฟล์เอง ───────────────────────────────────────
claude plugin validate $pluginDir
if ($LASTEXITCODE -ne 0) { throw 'plugin validate ไม่ผ่าน' }
claude plugin validate $root
if ($LASTEXITCODE -ne 0) { throw 'marketplace validate ไม่ผ่าน' }

# ── 4. commit + tag + push ───────────────────────────────────────────────
git -C $root add -A
git -C $root commit -m "aff-timelapse $Version — $Message"
if ($LASTEXITCODE -ne 0) { throw 'commit ไม่สำเร็จ (ไม่มีอะไรเปลี่ยน?)' }
git -C $root tag "aff-timelapse--v$Version"
git -C $root push origin HEAD --tags
if ($LASTEXITCODE -ne 0) { throw 'push ไม่สำเร็จ' }

Write-Host "`n🎉 ปล่อยรุ่น $Version แล้ว" -ForegroundColor Green
Write-Host "   บอกเพื่อนให้สั่ง:  /plugin marketplace update homey-vibes" -ForegroundColor Cyan
Write-Host "                      /plugin update aff-timelapse" -ForegroundColor Cyan
