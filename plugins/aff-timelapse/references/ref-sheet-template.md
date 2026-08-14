# แม่แบบ Product Reference Sheet

ช่องที่ขึ้นต้นด้วย `<<` `>>` คือช่องที่ต้องเติมก่อนส่ง
**ค่าในทุกคีย์เป็นภาษาอังกฤษเสมอ** เพราะโมเดลสร้างภาพอ่านอังกฤษแม่นกว่าไทยมาก
หัวข้อกับคำอธิบายรอบๆ เป็นไทยได้ตามปกติ

พรอมต์ภาพของโปรเจคนี้**เขียนเป็น JSON ทุกใบ** ชีทอ้างอิงก็ใบหนึ่งเหมือนกัน

---

```json
{
  "reference": "Create a professional product reference sheet showing the same product from multiple angles for consistent AI image generation. Match the attached product photos exactly.",
  "camera": "Four clean studio views arranged in a symmetrical grid with even spacing, plain neutral grey background, aspect ratio 16:9.",
  "scene": "<<VIEW_1_NAME>>: <<VIEW_1_DESC>>. <<VIEW_2_NAME>>: <<VIEW_2_DESC>>. <<VIEW_3_NAME>>: <<VIEW_3_DESC>>. <<VIEW_4_NAME>>: <<VIEW_4_DESC>>.",
  "subject": "One single product shown four times from different angles. Neutral grey background only, nothing else in frame.",
  "product": "<<PRODUCT>>",
  "critical": "Keep the product design, proportions, colours, materials and details identical across all four views. <<MATERIAL_NOTE>>",
  "palette": "Neutral studio grey background with the product's own colours unchanged.",
  "lighting": "Clean studio lighting with soft shadows and balanced highlights, realistic textures and accurate reflections for the product material.",
  "style": "<<VISUAL_STYLE>> Sharp high-quality detail suitable for a professional design reference.",
  "negative": "no text, no labels, no logos, no watermarks, no hands, no props, no packaging, no extra objects, no brand name, no model number<<LABEL_EXCEPTION>>"
}
```

---

## คำอธิบายแต่ละช่อง

| ช่อง | เติมอะไร |
|---|---|
| `<<PRODUCT>>` | คำบรรยายกายภาพเป็นภาษาอังกฤษ **1 ย่อหน้า** — รูปทรง สัดส่วน จำนวนชิ้นส่วน วัสดุ สี พื้นผิว กลไก จุดที่ต่างจากรุ่นทั่วไป **ห้ามใส่ชื่อแบรนด์หรือชื่อรุ่น** |
| `<<VIEW_n_NAME>>` `<<VIEW_n_DESC>>` | ชื่อมุมกับสิ่งที่ต้องเห็นในมุมนั้น เลือกให้เข้ากับตัวสินค้า (ดูตารางในสกิล) |
| `<<MATERIAL_NOTE>>` | บรรทัดเตือนเรื่องวัสดุที่โมเดลทำพังง่าย เช่น ตาข่ายถี่ พลาสติกใส โลหะเงา ลายพิมพ์ซ้ำ (อยู่ในคีย์ `critical`) |
| `<<LABEL_EXCEPTION>>` | ว่างไว้ถ้าสินค้าไม่มีฉลากพิมพ์บนตัว · ถ้ามีฉลาก ให้ตัดคำห้ามเรื่องตัวหนังสือออกจากคีย์ `negative` แล้วย้ายประโยคยกเว้นที่เขียนไว้ในสกิลไปไว้ในคีย์ `product` แทน |
| `<<VISUAL_STYLE>>` | สไตล์ภาพที่เลือกตามหมวดสินค้า (ดูตารางในสกิล) |
