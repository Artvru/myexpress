const line = require('@line/bot-sdk');
const express = require('express');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
// เรียกใช้ตัวใหม่ตามแพ็กเกจ @google/genai
const { GoogleGenAI } = require('@google/genai');

// โหลดค่าความลับจากไฟล์ .env
dotenv.config();

const app = express();

// 1. ตั้งค่า Supabase และ LINE
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  // process.env.SUPABASE_KEY || ''
  process.env.SUPABASE_SERVICE_ROLE_KEY || '' 
);

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

// Client สำหรับส่งข้อความตอบกลับ
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

// เพิ่ม Blob Client สำหรับดึงไฟล์รูปภาพจากเซิร์ฟเวอร์ของ LINE
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken
});

// 2. เริ่มต้นใช้งาน Gemini SDK ตัวใหม่ (@google/genai)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// 3. สร้างเส้นทาง Webhook สำหรับ LINE
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('[Webhook Error]:', err);
      res.status(500).end();
    });
});

// 4. ฟังก์ชันประมวลผลหลัก
async function handleEvent(event) {
  // ปรับเงื่อนไขให้รองรับทั้งข้อความ (text) และรูปภาพ (image)
  if (event.type !== 'message' || (event.message.type !== 'text' && event.message.type !== 'image')) {
    return null;
  }

  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken;
  const messageId = event.message.id;
  const messageType = event.message.type;

  let botReplyText = '';
  let dbContent = '';

  try {
    // =============================================================
    // ทางเลือกที่ 1: หากผู้ใช้ส่งข้อความ TEXT
    // =============================================================
    if (messageType === 'text') {
      const userText = event.message.text;
      dbContent = userText; // สิ่งที่จะบันทึกลงช่อง content ใน DB
      
      console.log(`[User Request] User ID ${userId} asked text: ${userText}`);
      console.log('[Gemini] Generating text response using @google/genai...');
      
      try {
        const prompt = `ตอบคำถามต่อไปนี้ด้วยภาษาที่เป็นธรรมชาติ กระชับ และสร้างสรรค์ เหมาะสำหรับการอ่านบนแอปแชท LINE: ${userText}`;
        
        // ปรับโครงสร้างให้อยู่ในรูปของ Content Object เต็มรูปแบบเพื่อความชัวร์
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash-lite',
          contents: [{ role: 'user', parts: [{ text: prompt }] }], 
        });
        
        botReplyText = response.text || 'ไม่สามารถประมวลผลคำตอบได้ในขณะนี้';
      } catch (geminiTextError) {
        console.error('[Gemini Text Error]:', geminiTextError);
        // พ่น Error ออกมาให้เห็นบนหน้าจอ LINE ทันทีเพื่อการ Debug
        botReplyText = `❌ [Gemini Error]: ${geminiTextError.message || geminiTextError.toString()}`;
      }
    } 
    
    // =============================================================
    // ทางเลือกที่ 2: หากผู้ใช้ส่งรูปภาพ IMAGE (โจทย์ Quiz #3 จำแนกรูปสัตว์)
    // =============================================================
    else if (messageType === 'image') {
      console.log(`[User Request] User ID ${userId} sent an image.`);
      
      // 1. ดาวน์โหลดรูปภาพจาก LINE ออกมาเป็น Buffer
      console.log('[LINE] Downloading image stream...');
      const imageStream = await blobClient.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of imageStream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);
      
      // 2. ตั้งชื่อไฟล์รูปภาพและอัปโหลดขึ้น Supabase Storage (Bucket: uploads)
      const fileName = `animal_${Date.now()}.jpg`;
      console.log(`[Supabase Storage] Uploading ${fileName} to 'uploads' bucket...`);
      
      const { data: storageData, error: storageError } = await supabase
        .storage
        .from('uploads')
        .upload(fileName, imageBuffer, {
          contentType: 'image/jpeg',
          upsert: true
        });

      if (storageError) {
        console.error('[Supabase Storage Error] Upload failed:', storageError.message);
        dbContent = `[Image Upload Failed]: ${fileName}`;
      } else {
        console.log('[Supabase Storage Success] Image uploaded successfully.');
        // ดึง Public URL ของรูปภาพเพื่อนำไปบันทึกลงฐานข้อมูลข้อมูล
        const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
        dbContent = urlData.publicUrl;
      }

      // 3. ส่งรูปภาพคู่กับคำสั่งไปให้ Gemini วิเคราะห์หาชนิดสัตว์
      try {
        console.log('[Gemini] Analyzing animal image using @google/genai...');
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash-lite',
          contents: [
            'วิเคราะห์รูปภาพนี้แล้วบอกว่าเป็นสัตว์ชนิดใด ให้ตอบเฉพาะชื่อสัตว์อย่างเดียวสั้นๆ กระชับ เช่น แมว, สุนัข, สิงโต, นกแก้ว เป็นต้น (ถ้าไม่ใช่รูปสัตว์ให้ตอบว่า ไม่พบรูปภาพสัตว์ในระบบ)',
            {
              inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
              }
            }
          ],
        });
        
        botReplyText = response.text || 'ไม่สามารถวิเคราะห์รูปภาพได้';
      } catch (geminiImgError) {
        console.error('[Gemini Image Error]:', geminiImgError);
        botReplyText = `❌ [Gemini Image Error]: ${geminiImgError.message || geminiImgError.toString()}`;
      }
    }
    
    console.log('[Gemini Success] Response generated:', botReplyText);

    // -------------------------------------------------------------
    // ขั้นตอนที่ 2: บันทึกข้อมูลลงฐานข้อมูล Supabase
    // -------------------------------------------------------------
    console.log('[Supabase] Start saving message to database...');
    
    const { error } = await supabase
      .from('messages')
      .insert([
        {
          user_id: userId,
          message_id: messageId,
          type: messageType,
          content: dbContent, 
          reply_token: replyToken,
          reply_content: botReplyText
        }
      ]);

    if (error) {
      console.error('[Supabase Error] Database insert failed:', error.message);
    } else {
      console.log('[Supabase Success] Database insert successfully');
    }

    // -------------------------------------------------------------
    // ขั้นตอนที่ 3: ตอบกลับข้อความทาง LINE
    // -------------------------------------------------------------
    console.log('[LINE] Sending reply message to user...');
    
    const replyResult = await client.replyMessage({
      replyToken: replyToken,
      messages: [
        {
          type: 'text',
          text: botReplyText
        }
      ]
    });
    
    console.log('[LINE Success] Reply message sent successfully\n-----------------------');
    return replyResult;

  } catch (error) {
    console.error('[System Error] Processing failed:', error);
    try {
      await client.replyMessage({
        replyToken: replyToken,
        messages: [{ type: 'text', text: `❌ [System Error]: ${error.message || error.toString()}` }]
      });
    } catch (replyErr) {
      console.error('[Reply Error in Catch]:', replyErr);
    }
  }
}

// 5. เปิดเซิร์ฟเวอร์
const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} with New Gemini SDK`);
});