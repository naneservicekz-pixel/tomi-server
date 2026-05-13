const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1pHMBMpMpxEByKmVYJxoKAVynTPNSqSTWLrMhVnvZDLo';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

console.log('Томи Telegram запущен');
console.log('TOKEN:', TELEGRAM_TOKEN ? TELEGRAM_TOKEN.substring(0, 10) + '...' : 'НЕТ ТОКЕНА');

// История диалогов
const conversations = {};

// Получить данные из Google Sheets
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

// Сохранить смену в Google Sheets
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

// Системный промпт Томи
const SYSTEM_PROMPT = `Ты — Томи, умный ИИ-управляющий магазина одежды NANÉ PARIS в Алматы.

Твои задачи:
1. Открытие и закрытие смены продавцов
2. Учёт предоплат (создание, просмотр, закрытие)
3. Сверка кассы по каналам оплаты (Kaspi, Halyk, наличные, личная карта)
4. Уведомление руководителя (Ермек, ID: ${OWNER_CHAT_ID})
5. Фиксация расходов из кассы

При закрытии смены обязательно запроси:
- Продажи по каждому каналу: Kaspi, Halyk, наличные, личная карта продавца
- Расходы из кассы
- Инкассацию
- Сверку: итог продаж - расходы - инкассация = остаток в кассе

Будь дружелюбным, чётким, профессиональным. Отвечай кратко и по делу. Используй эмодзи умеренно.
Ты работаешь в Telegram.`;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (!text) return;
  
  console.log('Сообщение от', chatId, ':', text);
  
  try {
    // Инициализация истории
    if (!conversations[chatId]) {
      conversations[chatId] = [];
    }
    
    // Добавляем сообщение пользователя
    conversations[chatId].push({ role: 'user', content: text });
    
    // Ограничиваем историю последними 20 сообщениями
    if (conversations[chatId].length > 20) {
      conversations[chatId] = conversations[chatId].slice(-20);
    }
    
    // Отправляем "печатает..."
    bot.sendChatAction(chatId, 'typing');
    
    // Запрос к Claude
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });
    
    const reply = response.content[0].text;
    
    // Добавляем ответ в историю
    conversations[chatId].push({ role: 'assistant', content: reply });
    
    // Отправляем ответ
    await bot.sendMessage(chatId, reply);
    
    console.log('Ответил:', reply.substring(0, 50) + '...');
    
  } catch (err) {
    console.error('Ошибка:', err.message);
    await bot.sendMessage(chatId, 'Произошла ошибка, попробуй ещё раз.');
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Бот слушает сообщения...');
