const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1pHMBMpMpxEByKmVYJxoKAVynTPNSqSTWLrMhVnvZDLo';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

console.log('Томи Telegram запущен');

const conversations = {};

async function getSheetData(range) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
    });
    return response.data.values || [];
  } catch (e) {
    console.error('Sheets error:', e.message);
    return [];
  }
}

async function saveShift(data) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Смены!A:Z',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [data] },
    });
    return true;
  } catch (e) {
    console.error('Save shift error:', e.message);
    return false;
  }
}

async function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const SYSTEM_PROMPT = `Ты — Томи, умный ИИ-управляющий магазина одежды NANÉ PARIS в Алматы.

Твои задачи:
1. Открытие и закрытие смены продавцов
2. Учёт предоплат (создание, просмотр, закрытие)
3. Сверка кассы по каналам оплаты (Kaspi, Halyk, наличные, личная карта)
4. Уведомление руководителя
5. Фиксация расходов из кассы

При закрытии смены:
- Запроси продажи по каждому каналу: Kaspi, Halyk, наличные, личная карта
- Запроси расходы и инкассацию
- Посчитай сверку и покажи итог
- Когда продавец подтверждает — скажи SHIFT_COMPLETE: и в следующей строке данные в формате JSON

Когда получаешь фото — опиши что видишь на фото и извлеки все суммы и данные.

Когда смена закрыта и подтверждена, выведи строку:
SHIFT_COMPLETE:
{"seller":"имя","date":"дата","kaspi":0,"halyk":0,"cash":0,"card":0,"expenses":0,"total":0}

Будь дружелюбным и чётким. Отвечай кратко. Используй эмодзи умеренно.`;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;

  if (!text && !photo) return;

  console.log('Сообщение от', chatId, photo ? '[фото]' : text);

  try {
    if (!conversations[chatId]) conversations[chatId] = [];

    let userContent;

    if (photo) {
      // Обработка фото через Claude Vision
      const fileId = photo[photo.length - 1].file_id;
      const fileUrl = await bot.getFileLink(fileId);
      const imageBuffer = await downloadFile(fileUrl);
      const base64Image = imageBuffer.toString('base64');

      userContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: 'Это фото из магазина. Прочитай все данные и суммы с этого документа/отчёта.',
        },
      ];
    } else {
      userContent = text;
    }

    conversations[chatId].push({ role: 'user', content: userContent });

    if (conversations[chatId].length > 20) {
      conversations[chatId] = conversations[chatId].slice(-20);
    }

    bot.sendChatAction(chatId, 'typing');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: reply });

    // Проверяем завершение смены
    if (reply.includes('SHIFT_COMPLETE:')) {
      const lines = reply.split('\n');
      const jsonLine = lines.find(l => l.trim().startsWith('{'));
      
      let shiftData = null;
      if (jsonLine) {
        try {
          shiftData = JSON.parse(jsonLine);
        } catch(e) {}
      }

      // Отправляем отчёт руководителю
      if (OWNER_CHAT_ID) {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        let report = '📊 *Отчёт закрытия смены*\n\n';
        if (shiftData) {
          report += `👤 Продавец: ${shiftData.seller || '—'}\n`;
          report += `📅 Дата: ${now}\n\n`;
          report += `💳 Kaspi: ${shiftData.kaspi || 0} ₸\n`;
          report += `🏦 Halyk: ${shiftData.halyk || 0} ₸\n`;
          report += `💵 Наличные: ${shiftData.cash || 0} ₸\n`;
          report += `💳 Личная карта: ${shiftData.card || 0} ₸\n\n`;
          report += `➖ Расходы: ${shiftData.expenses || 0} ₸\n`;
          report += `💰 Итого продаж: ${shiftData.total || 0} ₸`;
          
          // Сохраняем в Google Sheets
          const now2 = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
          await saveShift([
            now2,
            shiftData.seller || '',
            shiftData.kaspi || 0,
            shiftData.halyk || 0,
            shiftData.cash || 0,
            shiftData.card || 0,
            shiftData.expenses || 0,
            shiftData.total || 0,
          ]);
        } else {
          report += 'Смена закрыта продавцом из магазина.';
        }

        try {
          await bot.sendMessage(OWNER_CHAT_ID, report, { parse_mode: 'Markdown' });
          console.log('Отчёт отправлен руководителю');
        } catch(e) {
          console.error('Ошибка отправки отчёта:', e.message);
        }
      }

      // Убираем техническую строку из ответа продавцу
      const cleanReply = reply.replace(/SHIFT_COMPLETE:[\s\S]*/, '').trim() || 
        '✅ Смена закрыта! Отчёт отправлен руководителю. Хорошего отдыха! 👋';
      await bot.sendMessage(chatId, cleanReply);
    } else {
      await bot.sendMessage(chatId, reply);
    }

    console.log('Ответил:', reply.substring(0, 60));

  } catch (err) {
    console.error('Ошибка:', err.message);
    await bot.sendMessage(chatId, 'Произошла ошибка, попробуй ещё раз.');
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Бот слушает сообщения...');
