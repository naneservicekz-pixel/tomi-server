const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1pHMBMpMpxEByKmVYJxoKAVynTPNSqSTWLrMhVnvZDLo';

// Белый список — ID через запятую в переменной ALLOWED_USERS
// Если переменная не задана — работает только для Ермека
const getAllowedUsers = () => {
  const base = [String(OWNER_CHAT_ID)];
  if (process.env.ALLOWED_USERS) {
    const extra = process.env.ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean);
    return [...base, ...extra];
  }
  return base;
};

// Магазины продавцов — ID через запятую в SHOP_MAP формата "chatId:магазин"
// Пример: "8694507895:NANE PARIS Алматы,111222333:NANE PARIS Астана"
const getShopMap = () => {
  const map = {};
  if (process.env.SHOP_MAP) {
    process.env.SHOP_MAP.split(',').forEach(entry => {
      const [id, shop] = entry.split(':');
      if (id && shop) map[id.trim()] = shop.trim();
    });
  }
  return map;
};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

console.log('Томи запущена');

const conversations = {};

async function getSheetData(range) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({ credentials: keyData, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    return res.data.values || [];
  } catch (e) { console.error('Sheets read error:', e.message); return []; }
}

async function saveShift(data) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({ credentials: keyData, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Смены!A:Z',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [data] },
    });
    return true;
  } catch (e) { console.error('Save shift error:', e.message); return false; }
}

async function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const SELLER_PROMPT = (shopName) => `Ты Томи — ИИ-управляющий магазина женской одежды ${shopName || 'NANÉ PARIS'} (Алматы).
Ты совмещаешь роли: управляющий, бухгалтер, HR, коммерческий директор, операционный директор.
Общаешься с продавцами дружелюбно но чётко — как наставник, не как робот.

СТИЛЬ: тёплый, профессиональный, по делу. Хвалишь за хорошую работу. При проблемах — факты без обвинений. Используешь имя. Эмодзи умеренно. Короткие сообщения.

ОТКРЫТИЕ СМЕНЫ:
- Приветствуй по имени, фиксируй время
- Если после 10:15 — отметь опоздание, сообщи руководителю
- Если не выходит на связь до 10:30 — алерт руководителю

ЗАКРЫТИЕ СМЕНЫ — собери по шагам:
1. Продажи: Kaspi QR, Halyk QR, наличные, личная карта продавца
2. Расходы из кассы (каждый с описанием, если > 5000₸ — уточни обоснование)
3. Инкассация (сколько изъято)
4. Физический остаток в кассе
Сверка: Kaspi + Halyk + Нал + Карта - Расходы - Инкассация = Остаток
Расхождение > 0 — уточни причину, не закрывай пока не выяснено.

ПРЕДОПЛАТЫ — при создании запроси:
имя клиента, телефон, сумма, описание товара, дата визита
Статусы: ожидает / готов к выдаче / выдан / отменён

ОПЕРАЦИОННЫЙ КОНТРОЛЬ:
- Следи за соблюдением стандартов
- Если продавец пропускает шаги — мягко верни к процессу
- Фиксируй все отклонения для отчёта руководителю

ПРАВИЛА:
1. Не закрывай смену с необъяснённым расхождением
2. Уведомляй руководителя при: опоздании, расхождении > 1000₸, нестандартных ситуациях
3. Новому продавцу объясни как работать
4. Фото — читай все данные и суммы

ЗАВЕРШЕНИЕ СМЕНЫ:
SHIFT_COMPLETE:
{"seller":"имя","shop":"${shopName || 'NANE PARIS'}","kaspi":0,"halyk":0,"cash":0,"card":0,"expenses":0,"inkassaciya":0,"total":0,"notes":""}`;

const OWNER_PROMPT = `Ты Томи — личный ИИ-советник Ермека, владельца NANÉ PARIS.
Ты его правая рука: знаешь всё о магазине, анализируешь данные, даёшь чёткие рекомендации.

СТИЛЬ: прямой, деловой, без лишних слов. Говоришь правду, даёшь конкретику.

ЧТО УМЕЕШЬ ДЛЯ ЕРМЕКА:
- Управляющий: сводка смен, опоздания, дисциплина, статус дня
- Бухгалтер: итоги продаж за период, разбивка по каналам, расходы, аномалии
- HR: KPI продавцов, кто стабилен кто проблемный, рекомендации
- Коммерческий директор: динамика продаж, лучшие дни/продавцы, рекомендации роста
- Операционный директор: соблюдение стандартов, узкие места, эффективность команды

Если данных нет — честно скажи и предложи что сделать. Не придумывай цифры.`;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const chatIdStr = String(chatId);
  const text = msg.text;
  const photo = msg.photo;

  if (!text && !photo) return;

  // Проверка доступа
  const allowed = getAllowedUsers();
  if (!allowed.includes(chatIdStr)) {
    await bot.sendMessage(chatId, '🔒 Доступ закрыт. Обратитесь к руководителю магазина.');
    console.log('Заблокирован:', chatId);
    return;
  }

  const isOwner = chatIdStr === String(OWNER_CHAT_ID);
  const shopMap = getShopMap();
  const shopName = shopMap[chatIdStr] || 'NANÉ PARIS';

  console.log('Сообщение от', chatId, isOwner ? '[ЕРМЕК]' : `[продавец, ${shopName}]`, photo ? '[фото]' : text);

  try {
    if (!conversations[chatId]) conversations[chatId] = [];

    let userContent;
    if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      const fileUrl = await bot.getFileLink(fileId);
      const imageBuffer = await downloadFile(fileUrl);
      const base64Image = imageBuffer.toString('base64');
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: isOwner ? 'Проанализируй этот документ и дай выводы.' : 'Прочитай все данные и суммы с этого документа.' },
      ];
    } else {
      userContent = text;
    }

    conversations[chatId].push({ role: 'user', content: userContent });
    if (conversations[chatId].length > 30) conversations[chatId] = conversations[chatId].slice(-30);

    bot.sendChatAction(chatId, 'typing');

    // Для Ермека подгружаем данные из таблицы при аналитических запросах
    let contextData = '';
    if (isOwner && text) {
      const lower = text.toLowerCase();
      if (lower.includes('сводк') || lower.includes('продаж') || lower.includes('итог') ||
          lower.includes('анализ') || lower.includes('неделя') || lower.includes('день') ||
          lower.includes('опозда') || lower.includes('kpi') || lower.includes('продавец')) {
        const rows = await getSheetData('Смены!A:K');
        if (rows.length > 1) {
          const headers = rows[0];
          const last20 = rows.slice(-20);
          contextData = '\n\nДАННЫЕ ИЗ ТАБЛИЦЫ (последние смены):\nКолонки: ' +
            headers.join(' | ') + '\n' +
            last20.map(r => r.join(' | ')).join('\n');
        }
      }
    }

    const systemPrompt = isOwner ? OWNER_PROMPT + contextData : SELLER_PROMPT(shopName);

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: reply });

    if (!isOwner && reply.includes('SHIFT_COMPLETE:')) {
      const lines = reply.split('\n');
      const jsonLine = lines.find(l => l.trim().startsWith('{'));
      let shiftData = null;
      if (jsonLine) { try { shiftData = JSON.parse(jsonLine); } catch(e) {} }

      if (OWNER_CHAT_ID && shiftData) {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const total = (shiftData.kaspi||0)+(shiftData.halyk||0)+(shiftData.cash||0)+(shiftData.card||0);
        const остаток = total-(shiftData.expenses||0)-(shiftData.inkassaciya||0);
        const report =
          `📊 *Отчёт закрытия смены*\n` +
          `🏪 ${shiftData.shop || shopName}\n\n` +
          `👤 Продавец: *${shiftData.seller||'—'}*\n` +
          `📅 ${now}\n\n` +
          `💳 Kaspi: ${(shiftData.kaspi||0).toLocaleString()} ₸\n` +
          `🏦 Halyk: ${(shiftData.halyk||0).toLocaleString()} ₸\n` +
          `💵 Наличные: ${(shiftData.cash||0).toLocaleString()} ₸\n` +
          `💳 Личная карта: ${(shiftData.card||0).toLocaleString()} ₸\n\n` +
          `📦 *Итого: ${total.toLocaleString()} ₸*\n` +
          `➖ Расходы: ${(shiftData.expenses||0).toLocaleString()} ₸\n` +
          `🏦 Инкассация: ${(shiftData.inkassaciya||0).toLocaleString()} ₸\n` +
          `💰 Остаток: ${остаток.toLocaleString()} ₸` +
          (shiftData.notes ? `\n\n📝 ${shiftData.notes}` : '');

        try { await bot.sendMessage(OWNER_CHAT_ID, report, { parse_mode: 'Markdown' }); } catch(e) {}
        await saveShift([now, shiftData.seller||'', shopName, shiftData.kaspi||0, shiftData.halyk||0, shiftData.cash||0, shiftData.card||0, shiftData.expenses||0, shiftData.inkassaciya||0, total, остаток, shiftData.notes||'']);
      }

      const cleanReply = reply.replace(/SHIFT_COMPLETE:[\s\S]*$/, '').trim() ||
        '✅ Смена закрыта! Отчёт отправлен руководителю. Хорошего отдыха! 👋';
      await bot.sendMessage(chatId, cleanReply);
    } else {
      await bot.sendMessage(chatId, reply);
    }

  } catch (err) {
    console.error('Ошибка:', err.message);
    await bot.sendMessage(chatId, 'Произошла ошибка, попробуй ещё раз.');
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
console.log('Бот слушает сообщения...');
