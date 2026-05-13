const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1pHMBMpMpxEByKmVYJxoKAVynTPNSqSTWLrMhVnvZDLo';
const CASH_ALERT_LIMIT = parseInt(process.env.CASH_ALERT_LIMIT || '100000');

const getAllowedUsers = () => {
  const base = [String(OWNER_CHAT_ID)];
  if (process.env.ALLOWED_USERS) {
    return [...base, ...process.env.ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean)];
  }
  return base;
};

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

// Отслеживаем открытые смены { chatId: { seller, shop, openTime, cashOpen } }
const openShifts = {};

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
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function sendToOwner(text) {
  if (!OWNER_CHAT_ID) return;
  try { await bot.sendMessage(OWNER_CHAT_ID, text, { parse_mode: 'Markdown' }); } catch(e) {
    console.error('Ошибка отправки владельцу:', e.message);
  }
}

// Проверка наличных — алерт если > лимита
async function checkCashLimit(cashAmount, sellerName, shopName) {
  if (cashAmount >= CASH_ALERT_LIMIT) {
    await sendToOwner(
      `💰 *АЛЕРТ: Много наличных в кассе!*\n\n` +
      `🏪 ${shopName}\n` +
      `👤 Продавец: ${sellerName}\n` +
      `💵 В кассе: *${cashAmount.toLocaleString()} ₸*\n` +
      `⚠️ Лимит: ${CASH_ALERT_LIMIT.toLocaleString()} ₸\n\n` +
      `Рекомендуется провести инкассацию.`
    );
    console.log('Алерт наличных отправлен:', cashAmount);
  }
}

// Проверка незакрытых предоплат на сегодня
async function checkTodayPrepays() {
  try {
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
    const rows = await getSheetData('Предоплаты!A:J');
    if (rows.length < 2) return;
    const due = rows.slice(1).filter(r => {
      const visitDate = r[6] || '';
      const status = r[8] || '';
      return visitDate.includes(today.split('.')[0]) && status !== 'выдан' && status !== 'отменён';
    });
    if (due.length > 0) {
      let msg = `⏰ *Предоплаты на сегодня (${today}):*\n\n`;
      due.forEach((r, i) => {
        msg += `${i+1}. *${r[2]||'Клиент'}* · ${r[4]||''} · ${parseInt(r[5]||0).toLocaleString()} ₸\n`;
        msg += `   Товар: ${r[3]||'—'} · Ждёт: ${r[7]||'—'}\n\n`;
      });
      msg += `Напомни продавцу проверить эти предоплаты!`;
      await sendToOwner(msg);
    }
  } catch(e) { console.error('Ошибка проверки предоплат:', e.message); }
}

// Ежедневная сводка для Ермека
async function dailySummary() {
  try {
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
    const rows = await getSheetData('Смены!A:V');
    if (rows.length < 2) {
      await sendToOwner(`📊 *Сводка за ${today}*\n\nДанных по сменам за сегодня нет.`);
      return;
    }
    const todayRows = rows.slice(1).filter(r => (r[0]||'').includes(today.split('.').reverse().join('.')));
    
    if (todayRows.length === 0) {
      await sendToOwner(
        `📊 *Сводка за ${today}*\n\n` +
        `⚠️ Смены за сегодня не найдены.\n` +
        `Возможно смена не была закрыта через Томи.`
      );
      return;
    }

    let totalRosta = 0;
    let msg = `📊 *Сводка за ${today}*\n\n`;
    todayRows.forEach(r => {
      const seller = r[1] || '—';
      const rosta = parseInt(r[11]||0);
      totalRosta += rosta;
      const status = r[20] || 'ok';
      const icon = {'ok':'✅','remarks':'⚠️','issues':'🚨'}[status] || '✅';
      msg += `${icon} *${seller}*: ${rosta.toLocaleString()} ₸\n`;
    });
    msg += `\n💰 *Итого выручка: ${totalRosta.toLocaleString()} ₸*\n`;

    // Проверим открытые смены
    const openCount = Object.keys(openShifts).length;
    if (openCount > 0) {
      msg += `\n⚠️ Есть незакрытые смены: ${openCount} шт.`;
    }

    await sendToOwner(msg);
  } catch(e) { console.error('Ошибка сводки:', e.message); }
}

// Планировщик задач по времени (Астана UTC+5)
function scheduleTask(hourUTC, minuteUTC, task) {
  const now = new Date();
  let next = new Date();
  next.setUTCHours(hourUTC, minuteUTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    task();
    setInterval(task, 24 * 60 * 60 * 1000);
  }, delay);
}

// 22:00 Астана = 17:00 UTC — ежедневная сводка
scheduleTask(17, 0, dailySummary);

// 06:15 Астана = 01:15 UTC — алерт если смена не открыта
scheduleTask(1, 15, async () => {
  if (Object.keys(openShifts).length === 0) {
    await sendToOwner(
      `⏰ *Алерт: Смена не открыта!*\n\n` +
      `Уже 11:15 — ни один продавец не открыл смену через Томи.\n` +
      `Проверь ситуацию в магазине.`
    );
  }
});

// 09:00 Астана = 04:00 UTC — напоминание о предоплатах
scheduleTask(4, 0, checkTodayPrepays);

console.log('Планировщик запущен: сводка в 22:00, алерт в 11:15, предоплаты в 09:00 (Астана)');

const SELLER_PROMPT = (shopName) => `Ты Томи — ИИ-управляющий магазина NANÉ PARIS (${shopName || 'Алматы'}).
Ты умнее обычного бота — анализируешь, находишь ошибки, объясняешь расхождения.
Общаешься дружелюбно но чётко. Используешь имя продавца. Короткие сообщения.

═══ ОТКРЫТИЕ СМЕНЫ ═══
Запроси: имя продавца, остаток наличных в кассе на начало смены.
Если после 10:15 — зафикисруй опоздание и сообщи руководителю.

═══ В ТЕЧЕНИЕ ДНЯ ═══

ПОПОЛНЕНИЕ КАССЫ — если продавец говорит "добавили деньги", "пополнили кассу", "привезли размен":
Запроси: сумму, откуда (размен / от руководителя / частичная инкассация).
Подтверди: "Записала: +X ₸ в кассу."

РАСХОДЫ ИЗ КАССЫ:
Запроси: сумму, на что. Если > 5000 ₸ — уточни обоснование.

КОНТРОЛЬ НАЛИЧНЫХ В КАССЕ:
Если продавец сообщает остаток наличных и он >= ${CASH_ALERT_LIMIT} ₸ — скажи:
"⚠️ В кассе ${CASH_ALERT_LIMIT.toLocaleString()} ₸ и больше — нужна инкассация. Уведомила Ермека."
И обязательно укажи в ответе: CASH_ALERT:[сумма]

ПРЕДОПЛАТЫ — два типа:
1. ВХОДЯЩАЯ: имя клиента, телефон, канал (Kaspi QR/Онлайн Kaspi/Halyk QR/Онлайн Halyk/Наличные/Личная карта), сумма аванса, товар, полная стоимость, дата визита.
2. ВЫКУП: имя клиента, сумма доплаты, канал доплаты, товар выдан полностью?

═══ ЗАКРЫТИЕ СМЕНЫ ═══

ШАГ 1 — ROSTA (кассовая программа):
Kaspi QR, Онлайн Kaspi, Halyk QR, Онлайн Halyk, Наличные, Личная карта, Бонусы, Возвраты (если были).

ШАГ 2 — ТЕРМИНАЛЫ (реальные данные):
Kaspi терминал итого, возвраты Kaspi (если были), Halyk терминал итого, возвраты Halyk (если были).

ШАГ 3 — НАЛИЧНЫЕ:
Остаток в кассе на конец (пересчитать физически), выплаты клиентам, инкассация.

ШАГ 4 — СВЕРКА (считай автоматически):
Kaspi расхождение = Kaspi терминал - (Kaspi QR + Онлайн Kaspi)
Halyk расхождение = Halyk терминал - (Halyk QR + Онлайн Halyk)
Наличные факт = Конец - Начало + Расходы + Инкассация + Выплаты - Пополнения
Наличные расхождение = Наличные факт - Наличные ROSTA
Допуск: до 500 ₸ = норма ✅, больше 500 ₸ = уточни причину ⚠️

УМНАЯ ДИАГНОСТИКА расхождений — если терминал БОЛЬШЕ ROSTA:
→ Предоплата получена через терминал, не пробита в ROSTA
→ Возврат пробит в ROSTA сегодня, деньги выданы вчера
→ Продажа через терминал, чек не пробит

Если ROSTA БОЛЬШЕ терминала:
→ Выкуп предоплаты (часть денег была раньше)
→ Возврат наличными, в ROSTA отражён как терминал
→ Оплата на личную карту, пробита как наличные
→ Ошибка кассира в ROSTA

СТАТУС: ✅ корректно / ⚠️ с замечаниями / 🚨 есть вопросы

ПРАВИЛА:
1. Не закрывай с необъяснённым расхождением > 500 ₸
2. Уведомляй Ермека: опоздание / расхождение > 1000 ₸ / статус "вопросы"
3. Если наличные >= ${CASH_ALERT_LIMIT} ₸ в любой момент — пометь CASH_ALERT:[сумма]
4. Фото — читай все цифры и суммы

ЗАВЕРШЕНИЕ — после подтверждения:
SHIFT_COMPLETE:
{"seller":"","shop":"${shopName||'NANE PARIS'}","rosta_kaspi":0,"rosta_kaspi_online":0,"rosta_halyk":0,"rosta_halyk_online":0,"rosta_cash":0,"rosta_personal":0,"rosta_bonus":0,"rosta_returns":0,"terminal_kaspi":0,"terminal_halyk":0,"cash_open":0,"cash_close":0,"cash_add":0,"expenses":0,"payouts":0,"inkassaciya":0,"rosta_total":0,"diff":0,"status":"ok","notes":""}`;

const OWNER_PROMPT = `Ты Томи — личный ИИ-советник Ермека, владельца NANÉ PARIS.
Прямой, деловой стиль. Говоришь правду, даёшь конкретику без воды.

ЧТО УМЕЕШЬ:
- Управляющий: сводка смен, опоздания, дисциплина, статус дня
- Бухгалтер: продажи за период, каналы, расходы, аномалии
- HR: KPI продавцов, нарушения, рекомендации
- Коммерческий директор: динамика, лучшие дни, рост выручки
- Операционный директор: стандарты, узкие места, эффективность

Алерты которые Томи шлёт автоматически:
- 💰 Наличные в кассе > 100 000 ₸ — немедленно
- ⏰ Смена не открыта в 11:15 — сразу
- 📊 Ежедневная сводка в 22:00
- ⏳ Предоплаты на сегодня — в 09:00

Если данных нет — честно скажи. Не придумывай цифры.`;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const chatIdStr = String(chatId);
  const text = msg.text;
  const photo = msg.photo;

  if (!text && !photo) return;

  const allowed = getAllowedUsers();
  if (!allowed.includes(chatIdStr)) {
    await bot.sendMessage(chatId, '🔒 Доступ закрыт. Обратитесь к руководителю магазина.');
    return;
  }

  const isOwner = chatIdStr === String(OWNER_CHAT_ID);
  const shopMap = getShopMap();
  const shopName = shopMap[chatIdStr] || 'NANÉ PARIS';

  console.log('От', chatId, isOwner ? '[ЕРМЕК]' : `[${shopName}]`, photo ? '[фото]' : text);

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
        { type: 'text', text: isOwner ? 'Проанализируй документ и дай выводы.' : 'Прочитай все данные и суммы. Озвучь что видишь.' },
      ];
    } else {
      userContent = text;
    }

    conversations[chatId].push({ role: 'user', content: userContent });
    if (conversations[chatId].length > 40) conversations[chatId] = conversations[chatId].slice(-40);

    bot.sendChatAction(chatId, 'typing');

    let contextData = '';
    if (isOwner && text) {
      const lower = text.toLowerCase();
      if (lower.includes('сводк') || lower.includes('продаж') || lower.includes('итог') ||
          lower.includes('анализ') || lower.includes('неделя') || lower.includes('день') ||
          lower.includes('опозда') || lower.includes('kpi') || lower.includes('продавец') ||
          lower.includes('расход') || lower.includes('касс')) {
        const rows = await getSheetData('Смены!A:V');
        if (rows.length > 1) {
          contextData = '\n\nДАННЫЕ ИЗ ТАБЛИЦЫ:\nКолонки: ' +
            (rows[0]||[]).join(' | ') + '\n' +
            rows.slice(-30).map(r => r.join(' | ')).join('\n');
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

    // Проверяем алерт наличных
    const cashAlertMatch = reply.match(/CASH_ALERT:(\d+)/);
    if (cashAlertMatch && !isOwner) {
      const cashAmount = parseInt(cashAlertMatch[1]);
      const sellerName = openShifts[chatId]?.seller || 'Продавец';
      await checkCashLimit(cashAmount, sellerName, shopName);
    }

    // Обработка открытия смены
    if (!isOwner && text && (text.toLowerCase().includes('открыв') || text.toLowerCase().includes('открыт') || text.toLowerCase().includes('начинаю смен'))) {
      openShifts[chatId] = { shop: shopName, openTime: new Date() };
    }

    // Обработка закрытия смены
    if (!isOwner && reply.includes('SHIFT_COMPLETE:')) {
      const jsonLine = reply.split('\n').find(l => l.trim().startsWith('{'));
      let d = null;
      if (jsonLine) { try { d = JSON.parse(jsonLine); } catch(e) {} }

      // Удаляем из открытых смен
      delete openShifts[chatId];

      if (OWNER_CHAT_ID && d) {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const rostaTotal = d.rosta_total || (
          (d.rosta_kaspi||0)+(d.rosta_kaspi_online||0)+
          (d.rosta_halyk||0)+(d.rosta_halyk_online||0)+
          (d.rosta_cash||0)+(d.rosta_personal||0)+
          (d.rosta_bonus||0)-(d.rosta_returns||0)
        );
        const statusIcon = {'ok':'✅','remarks':'⚠️','issues':'🚨'}[d.status] || '✅';
        const statusText = {'ok':'Корректно','remarks':'С замечаниями','issues':'Есть вопросы'}[d.status] || '';

        const report =
          `📊 *Отчёт закрытия смены*\n` +
          `🏪 ${d.shop || shopName} · 📅 ${now}\n` +
          `👤 *${d.seller||'—'}*\n\n` +
          `📋 *ROSTA:*\n` +
          `  Kaspi QR: ${(d.rosta_kaspi||0).toLocaleString()} ₸\n` +
          ((d.rosta_kaspi_online||0)>0?`  Онлайн Kaspi: ${d.rosta_kaspi_online.toLocaleString()} ₸\n`:'') +
          `  Halyk QR: ${(d.rosta_halyk||0).toLocaleString()} ₸\n` +
          ((d.rosta_halyk_online||0)>0?`  Онлайн Halyk: ${d.rosta_halyk_online.toLocaleString()} ₸\n`:'') +
          `  Наличные: ${(d.rosta_cash||0).toLocaleString()} ₸\n` +
          ((d.rosta_personal||0)>0?`  Личная карта: ${d.rosta_personal.toLocaleString()} ₸\n`:'') +
          ((d.rosta_returns||0)>0?`  Возвраты: −${d.rosta_returns.toLocaleString()} ₸\n`:'') +
          `  *ИТОГО: ${rostaTotal.toLocaleString()} ₸*\n\n` +
          `💵 *Касса:*\n` +
          `  Начало: ${(d.cash_open||0).toLocaleString()} ₸\n` +
          ((d.cash_add||0)>0?`  Пополнение: +${d.cash_add.toLocaleString()} ₸\n`:'') +
          ((d.expenses||0)>0?`  Расходы: −${d.expenses.toLocaleString()} ₸\n`:'') +
          ((d.inkassaciya||0)>0?`  Инкассация: −${d.inkassaciya.toLocaleString()} ₸\n`:'') +
          `  Конец: ${(d.cash_close||0).toLocaleString()} ₸\n\n` +
          `${statusIcon} *${statusText}* · Расхождение: ${d.diff||0} ₸` +
          (d.notes?`\n📝 ${d.notes}`:'');

        try { await sendToOwner(report); } catch(e) {}

        // Алерт если наличные на конец смены большие
        if ((d.cash_close||0) >= CASH_ALERT_LIMIT) {
          await checkCashLimit(d.cash_close, d.seller||'—', shopName);
        }

        await saveShift([
          now, d.seller||'', shopName,
          d.rosta_kaspi||0, d.rosta_kaspi_online||0,
          d.rosta_halyk||0, d.rosta_halyk_online||0,
          d.rosta_cash||0, d.rosta_personal||0,
          d.rosta_bonus||0, d.rosta_returns||0,
          rostaTotal,
          d.terminal_kaspi||0, d.terminal_halyk||0,
          d.cash_open||0, d.cash_add||0, d.cash_close||0,
          d.expenses||0, d.inkassaciya||0,
          d.diff||0, d.status||'ok', d.notes||''
        ]);
      }

      const cleanReply = reply.replace(/SHIFT_COMPLETE:[\s\S]*$/, '').trim() ||
        '✅ Смена закрыта! Отчёт отправлен Ермеку. Хорошего отдыха! 👋';
      await bot.sendMessage(chatId, cleanReply);
    } else {
      // Убираем технические метки из ответа
      const cleanReply = reply.replace(/CASH_ALERT:\d+/g, '').trim();
      await bot.sendMessage(chatId, cleanReply);
    }

  } catch (err) {
    console.error('Ошибка:', err.message);
    await bot.sendMessage(chatId, 'Произошла ошибка, попробуй ещё раз.');
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));
console.log('Бот слушает...');
