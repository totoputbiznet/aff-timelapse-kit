# แม่แบบ Product Reference Sheet

ช่องที่ขึ้นต้นด้วย `<<` `>>` คือช่องที่ต้องเติมก่อนส่ง
ตัวพรอมต์เป็นภาษาอังกฤษเสมอ เพราะโมเดลสร้างภาพอ่านอังกฤษแม่นกว่าไทยมาก

---

Create a professional product reference sheet showing the same product from multiple angles for consistent AI image generation.

**Product:** <<PRODUCT>>

**Layout:** Display the same product in four clean studio views on a plain neutral grey background:

- **<<VIEW_1_NAME>>:** <<VIEW_1_DESC>>
- **<<VIEW_2_NAME>>:** <<VIEW_2_DESC>>
- **<<VIEW_3_NAME>>:** <<VIEW_3_DESC>>
- **<<VIEW_4_NAME>>:** <<VIEW_4_DESC>>

**Style & Consistency:**

- Keep the product design, proportions, colors, materials, and details identical across all views.
- Show realistic textures and accurate reflections based on the product material.
- Use clean studio lighting with soft shadows and balanced highlights.
- Present the product with sharp, high-quality detail suitable for a professional design reference.
- <<MATERIAL_NOTE>>

**Requirements:**

- Neutral grey background only.
- No text, labels, logos, watermarks, hands, props, packaging, or extra objects.<<LABEL_EXCEPTION>>
- Clean, symmetrical layout with even spacing between each view.
- Aspect ratio 16:9.

**Visual Style:** <<VISUAL_STYLE>>

---

## คำอธิบายแต่ละช่อง

| ช่อง | เติมอะไร |
|---|---|
| `<<PRODUCT>>` | คำบรรยายกายภาพเป็นภาษาอังกฤษ **1 ย่อหน้า** — รูปทรง สัดส่วน จำนวนชิ้นส่วน วัสดุ สี พื้นผิว กลไก จุดที่ต่างจากรุ่นทั่วไป **ห้ามใส่ชื่อแบรนด์หรือชื่อรุ่น** |
| `<<VIEW_n_NAME>>` `<<VIEW_n_DESC>>` | ชื่อมุมกับสิ่งที่ต้องเห็นในมุมนั้น เลือกให้เข้ากับตัวสินค้า (ดูตารางในสกิล) |
| `<<MATERIAL_NOTE>>` | บรรทัดเตือนเรื่องวัสดุที่โมเดลทำพังง่าย เช่น ตาข่ายถี่ พลาสติกใส โลหะเงา ลายพิมพ์ซ้ำ |
| `<<LABEL_EXCEPTION>>` | ว่างไว้ถ้าสินค้าไม่มีฉลากพิมพ์บนตัว · ถ้ามี ให้ใส่ประโยคยกเว้นที่เขียนไว้ในสกิล |
| `<<VISUAL_STYLE>>` | สไตล์ภาพที่เลือกตามหมวดสินค้า (ดูตารางในสกิล) |
