// index.js
require('dotenv').config(); // โหลดไฟล์ .env ทันทีตั้งแต่บรรทัดแรก
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// 1. ดึงค่าจากไฟล์ .env อย่างปลอดภัยตามปกติ
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || ""
};

// 2. สร้าง client จากเวอร์ชันใหม่
const client = new line.messagingApi.MessagingApiClient(config);

app.use('/webhook', line.middleware(config));

// รับ webhook
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch((err) => {
      console.error("Webhook Error เกิดข้อผิดพลาด:", err);
      res.status(500).end();
    });
});

// ตอบกลับข้อความ
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // ✅ แก้ไขให้เป็นรูปแบบการส่งข้อความของเวอร์ชันใหม่เรียบร้อยแล้ว
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `คุณพิมพ์ว่า: ${event.message.text}`
      }
    ]
  });
}

// เพิ่ม GET Method สำหรับเช็คหน้าเว็บหน้าแรก
app.get('/', (req, res) => {
  res.send('hello world, Teerarak Jirapanan');
});

const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});