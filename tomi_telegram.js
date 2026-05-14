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

async function savePrepay(p, shopName, sellerName) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({ credentials: keyData, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const nowDate = new Date().toISOString().split('T')[0];
    const nowStr = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

    if (p.type === 'incoming') {
      // Новая предоплата — добавляем строку
      const id = 'PREP-' + Date.now().toString().slice(-6);
      const fullPrice = p.full_price || 0;
      const amount = p.amount || 0;
      const balance = fullPrice > amount ? fullPrice - amount : 0;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Предоплаты!A:K',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[id, nowDate, p.client||'', p.phone||'', p.item||'', p.channel||'', amount, balance, 'Открыта', '', `${shopName} · ${sellerName}`]] },
      });
      console.log('Предоплата создана:', p.client);
    } else if (p.type === 'redeemed') {
      // Выкуп — ищем строку по имени клиента и меняем статус
      const rows = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Предоплаты!A:K' });
      const data = rows.data.values || [];
      let foundRow = -1;
      for (let i = 1; i < data.length; i++) {
        const clientName = String(data[i][2] || '').toLowerCase();
        const status = String(data[i][8] || '').toLowerCase();
        if (clientName.includes((p.client||'').toLowerCase()) && (status.includes('открыт') || status === '')) {
          foundRow = i + 1; // 1-indexed для Sheets API
          break;
        }
      }
      if (foundRow > 0) {
        // Обновляем статус и дату закрытия
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Предоплаты!I${foundRow}:J${foundRow}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['Закрыта', nowDate]] },
        });
        console.log('Предоплата закрыта:', p.client, 'строка', foundRow);
      } else {
        console.log('Предоплата не найдена для выкупа:', p.client);
      }
    }
    return true;
  } catch (e) { console.error('Save prepay error:', e.message); return false; }
}

async function saveLog(chatId, shopName, sellerName, role, message, isPhoto) {
  try {
    const keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({ credentials: keyData, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    // Добавляем заголовки если лист пустой
    const check = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Логи!A1' });
    if (!check.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Логи!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [['Дата/Время', 'Магазин', 'Продавец', 'Роль', 'Сообщение', 'Telegram ID']] },
      });
    }
    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Логи!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[now, shopName, sellerName, role, isPhoto ? '[фото]' : message, String(chatId)]] },
    });
  } catch (e) { console.error('Save log error:', e.message); }
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
  // Структура: A=ID, B=Дата, C=Клиент, D=Телефон, E=Товар, F=Канал, G=Сумма, H=Остаток, I=Статус, J=Дата закрытия
  try {
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
    const rows = await getSheetData('Предоплаты!A:K');
    if (rows.length < 2) return;
    const open = rows.slice(1).filter(r => {
      const status = String(r[8] || '').toLowerCase();
      const hasClient = String(r[2] || '').trim() !== '';
      return hasClient && (status.includes('открыт') || (status === '' && hasClient));
    });
    if (open.length > 0) {
      let msg = `⏳ *Открытые предоплаты на ${today}:*\n\n`;
      open.slice(0, 10).forEach((r, i) => {
        const amount = parseInt(String(r[6]||'0').replace(/[^\d]/g,'')) || 0;
        const balance = parseInt(String(r[7]||'0').replace(/[^\d]/g,'')) || 0;
        msg += `${i+1}. *${r[2]||'—'}* · ${r[5]||'—'}\n`;
        msg += `   Товар: ${r[4]||'—'}\n`;
        msg += `   Аванс: ${amount.toLocaleString()} ₸ · Остаток: ${balance.toLocaleString()} ₸\n\n`;
      });
      if (open.length > 10) msg += `...и ещё ${open.length - 10} предоплат\n`;
      msg += `Напомни продавцу проверить список!`;
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

ПРЕДОПЛАТЫ — продавец может:

А) СОЗДАТЬ новую предоплату (клиент вносит аванс сегодня):
Запроси: имя клиента, телефон, канал оплаты (Kaspi QR/Онлайн Kaspi/Halyk QR/Онлайн Halyk/Наличные/Личная карта), сумма аванса, товар, полная стоимость товара, дата когда придёт забирать.
После подтверждения выведи:
PREPAY_SAVE:
{"type":"incoming","client":"","phone":"","channel":"","amount":0,"item":"","full_price":0,"visit_date":"","seller":""}

Б) ЗАКРЫТЬ предоплату (клиент пришёл забирать товар):
Запроси: имя клиента (или найди в списке), сумма доплаты если есть, канал доплаты, товар выдан полностью?
После подтверждения выведи:
PREPAY_SAVE:
{"type":"redeemed","client":"","phone":"","channel":"","amount":0,"item":"","full_price":0,"visit_date":"","seller":""}

В) ПОСМОТРЕТЬ список предоплат:
Если продавец спрашивает "покажи предоплаты", "есть ли предоплата у [имя]", "открытые предоплаты" — выведи:
PREPAY_LIST:открытые
Или если спрашивает закрытые/историю:
PREPAY_LIST:все

Список придёт автоматически из таблицы.

═══ ЗАКРЫТИЕ СМЕНЫ ═══

ШАГ 1 — ROSTA (кассовая программа):
Kaspi QR, Онлайн Kaspi, Halyk QR, Онлайн Halyk, Наличные, Личная карта, Возвраты (если были).
Бонусы — если клиент платил бонусами Kaspi/Halyk. Это ВАЖНЫЙ канал:
  Бонусы пробиваются в ROSTA как продажа, но в терминале денег НЕТ (клиент заплатил баллами).
  Поэтому терминал будет меньше ROSTA на сумму бонусов — это нормально, не расхождение.
  Спроси: "Были ли оплаты бонусами сегодня? Если да — на какую сумму?"

ШАГ 2 — ТЕРМИНАЛЫ (реальные данные):
Kaspi терминал итого, возвраты Kaspi (если были), Halyk терминал итого, возвраты Halyk (если были).
Личная карта терминал — если были оплаты на личную карту продавца, запроси отдельно.

ШАГ 3 — НАЛИЧНЫЕ:
Остаток в кассе на конец (пересчитать физически), выплаты клиентам, инкассация.

ШАГ 4 — СВЕРКА С УЧЁТОМ ПРЕДОПЛАТ:

Базовая формула:
Kaspi расхождение = Kaspi терминал - (Kaspi QR ROSTA + Онлайн Kaspi ROSTA)
Halyk расхождение = Halyk терминал - (Halyk QR ROSTA + Онлайн Halyk ROSTA)
Личная карта расхождение = Личная карта терминал - Личная карта ROSTA
Наличные факт = Конец - Начало + Расходы + Инкассация + Выплаты - Пополнения
Наличные расхождение = Наличные факт - Наличные ROSTA

ВАЖНО по личной карте:
Если клиент платил переводом на личную карту продавца — это отдельный канал.
В ROSTA это может быть пробито как наличные (ошибка) или как личная карта (правильно).
Если пробито как наличные — расхождение будет в наличных, не в личной карте. Уточни у продавца.

ВАЖНО по бонусам:
Бонусы Kaspi/Halyk = оплата баллами. В ROSTA пробиты как продажа, но в терминале денег нет.
Формула: ROSTA итого включает бонусы, Факт терминалов — нет.
Поэтому: Факт = Терминалы + Наличные + Бонусы (бонусы добавляем к факту для сверки)
Если ROSTA больше терминалов на сумму бонусов — это норма ✅, не расхождение.

КОРРЕКТИРОВКА НА ПРЕДОПЛАТЫ (применяй если есть расхождение > 500 ₸):

Если терминал БОЛЬШЕ ROSTA (положительное расхождение):
→ Вероятно сегодня была ВХОДЯЩАЯ предоплата — клиент заплатил аванс через терминал, но товар ещё не пробит в ROSTA
→ Спроси: "Была ли входящая предоплата сегодня? Если да — по какому каналу и на какую сумму?"
→ Входящая предоплата УМЕНЬШАЕТ расхождение: расхождение - сумма предоплаты
→ Если после корректировки расхождение < 500 ₸ — смена сходится ✅

Если ROSTA БОЛЬШЕ терминала (отрицательное расхождение):
→ Вероятно сегодня был ВЫКУП предоплаты — товар пробит в ROSTA, но деньги частично были внесены раньше
→ Спроси: "Выкупал ли клиент предоплату сегодня? Если да — какая сумма была внесена ранее?"
→ Выкуп предоплаты УМЕНЬШАЕТ расхождение: расхождение + сумма ранее внесённого аванса
→ Если после корректировки расхождение < 500 ₸ — смена сходится ✅

ДРУГИЕ ПРИЧИНЫ расхождений:
Терминал больше ROSTA также может быть: возврат пробит в ROSTA но деньги выданы вчера / продажа через терминал чек не пробит / технический сбой терминала
ROSTA больше терминала также может быть: возврат наличными ROSTA уменьшена / оплата на личную карту пробита как наличные / ошибка кассира

ИТОГОВАЯ СВЕРКА:
Итого ROSTA = сумма всех каналов ROSTA
Итого Факт = терминалы + наличные факт
Корректировка предоплат = +входящие предоплаты - выкупы
Финальное расхождение = Факт + Корректировка - ROSTA
Допуск: < 500 ₸ = норма ✅

СТАТУС: ✅ корректно / ⚠️ с замечаниями / 🚨 есть вопросы

ПРАВИЛА:
1. Не закрывай с необъяснённым расхождением > 500 ₸
2. Уведомляй Ермека: опоздание / расхождение > 1000 ₸ / статус "вопросы"
3. Если наличные >= ${CASH_ALERT_LIMIT} ₸ в любой момент — пометь CASH_ALERT:[сумма]
4. Как только узнаёшь имя продавца — сразу выведи в ответе: SELLER_NAME:[имя]
   Пример: "Привет, Зарина! Записала. SELLER_NAME:Зарина"
5. ФОТО — три типа, скажи продавцу чётко:
   "Отправь фото Z-отчёта" — когда нужны данные ROSTA
   "Отправь фото Kaspi терминала" — когда нужны данные Kaspi
   "Отправь фото Halyk терминала" — когда нужны данные Halyk
   После получения фото — зачитай суммы и спроси подтвердить

ЗАВЕРШЕНИЕ — после подтверждения:
SHIFT_COMPLETE:
{"seller":"","shop":"${shopName||'NANE PARIS'}","rosta_kaspi":0,"rosta_kaspi_online":0,"rosta_halyk":0,"rosta_halyk_online":0,"rosta_cash":0,"rosta_personal":0,"rosta_bonus":0,"rosta_returns":0,"terminal_kaspi":0,"terminal_halyk":0,"terminal_personal":0,"cash_open":0,"cash_close":0,"cash_add":0,"expenses":0,"payouts":0,"inkassaciya":0,"rosta_total":0,"diff":0,"status":"ok","notes":""}`;

const OWNER_PROMPT = `Ты Томи — личный ИИ-советник Ермека, владельца NANÉ PARIS.
Прямой, деловой стиль. Говоришь правду, даёшь конкретику.

ВАЖНО: У тебя ЕСТЬ прямой доступ к Google Sheets таблице NANÉ PARIS.
Данные из таблицы передаются тебе в каждом сообщении в разделе "ДАННЫЕ ИЗ ТАБЛИЦЫ".
Используй эти данные для ответов — не говори что у тебя нет доступа!
Если раздел с данными пустой — тогда скажи что данных нет.

ЧТО УМЕЕШЬ:
- Управляющий: сводка смен, опоздания, дисциплина, статус дня
- Бухгалтер: продажи за период, каналы, расходы, аномалии  
- HR: KPI продавцов, нарушения, рекомендации
- Коммерческий директор: динамика, лучшие дни, рост выручки
- Операционный директор: стандарты, узкие места, эффективность
- Предоплаты: список открытых, история, поиск по клиенту

Алерты автоматически:
- 💰 Наличные > 100 000 ₸ — немедленно
- ⏰ Смена не открыта в 11:15
- 📊 Сводка в 22:00
- ⏳ Предоплаты в 09:00`;

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

      // Определяем тип фото по контексту последних сообщений
      const lastMsgs = (conversations[chatId] || []).slice(-4).map(m => typeof m.content === 'string' ? m.content.toLowerCase() : '').join(' ');
      let photoPrompt;
      if (isOwner) {
        photoPrompt = 'Проанализируй документ и дай выводы.';
      } else if (lastMsgs.includes('z-отчёт') || lastMsgs.includes('z отчёт') || lastMsgs.includes('z-report') || lastMsgs.includes('zотчет') || lastMsgs.includes('зед') || lastMsgs.includes('итоговый отчёт')) {
        photoPrompt = 'Это Z-отчёт кассовой системы ROSTA. Извлеки суммы по видам оплат: Kaspi QR, Онлайн Kaspi, Halyk QR, Онлайн Halyk, Наличные, Личная карта, Бонусы, Возвраты. Выведи каждую сумму отдельно. Формат: "Kaspi QR: X ₸, Halyk QR: X ₸" и т.д. Если строки нет — пиши 0.';
      } else if (lastMsgs.includes('kaspi терминал') || lastMsgs.includes('каспи терминал') || lastMsgs.includes('терминал kaspi') || lastMsgs.includes('отчёт kaspi')) {
        photoPrompt = 'Это отчёт с терминала Kaspi. Найди: сумму продаж (валовые), сумму возвратов (если есть), итого нетто. Выведи чётко: "Продажи Kaspi: X ₸, Возвраты: X ₸, Итого: X ₸"';
      } else if (lastMsgs.includes('halyk терминал') || lastMsgs.includes('халык терминал') || lastMsgs.includes('терминал halyk') || lastMsgs.includes('отчёт halyk')) {
        photoPrompt = 'Это отчёт с терминала Halyk. Найди: сумму поступлений за день, возвраты если есть. Выведи чётко: "Продажи Halyk: X ₸, Возвраты: X ₸, Итого: X ₸"';
      } else {
        photoPrompt = 'Прочитай все данные, суммы и цифры с документа. Озвучь что видишь — все числа и их значения.';
      }

      userContent = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: photoPrompt },
      ];
    } else {
      userContent = text;
    }

    conversations[chatId].push({ role: 'user', content: userContent });
    if (conversations[chatId].length > 40) conversations[chatId] = conversations[chatId].slice(-40);

    bot.sendChatAction(chatId, 'typing');

    // Для Ермека — всегда подгружаем все данные, Томи сама разберётся что использовать
    let contextData = '';
    if (isOwner) {
      try {
        const [shiftRows, prepRows] = await Promise.all([
          getSheetData('Смены!A:V'),
          getSheetData('Предоплаты!A:K')
        ]);

        if (shiftRows.length > 1) {
          contextData += '\n\nПОСЛЕДНИЕ СМЕНЫ (последние 30):\n';
          contextData += 'Колонки: ' + (shiftRows[0]||[]).join(' | ') + '\n';
          shiftRows.slice(-30).forEach(r => {
            contextData += r.join(' | ') + '\n';
          });
        }

        if (prepRows.length > 1) {
          const allPreps = prepRows.slice(1);
          // Фильтруем открытые предоплаты
          const openPreps = allPreps.filter(r => {
            const status = String(r[8]||'').trim();
            const hasClient = String(r[2]||'').trim() !== '';
            // Считаем открытой если статус содержит "Открыт" или пустой но есть клиент
            return hasClient && (status.includes('Открыт') || status.includes('открыт') || status === '');
          });
          contextData += `\n\nПРЕДОПЛАТЫ NANE PARIS:\n`;
          contextData += `Всего строк: ${allPreps.length}, Открытых: ${openPreps.length}\n`;
          contextData += 'ID | Дата | Клиент | Телефон | Товар | Канал | Аванс | Остаток\n';
          // Передаём ВСЕ открытые предоплаты
          openPreps.forEach(r => {
            contextData += `${r[0]||''} | ${r[1]||''} | ${r[2]||''} | ${r[3]||''} | ${r[4]||''} | ${r[5]||''} | ${r[6]||0} | ${r[7]||0}\n`;
          });
        }
      } catch(e) {
        console.error('Ошибка загрузки данных для Ермека:', e.message);
      }
    }

    const dataSection = contextData ? ('\n\n═══ ДАННЫЕ ИЗ ТАБЛИЦЫ ═══' + contextData) : '\n\n═══ ДАННЫЕ ИЗ ТАБЛИЦЫ ═══\nДанные не загружены.';
    const systemPrompt = isOwner ? OWNER_PROMPT + dataSection : SELLER_PROMPT(shopName);

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: reply });

    // Логируем сообщение продавца
    if (!isOwner) {
      const sellerName = openShifts[chatId]?.seller || 'Продавец';
      await saveLog(chatId, shopName, sellerName, 'продавец', photo ? '[фото]' : text, !!photo);
    }

    // Проверяем алерт наличных
    const cashAlertMatch = reply.match(/CASH_ALERT:(\d+)/);
    if (cashAlertMatch && !isOwner) {
      const cashAmount = parseInt(cashAlertMatch[1]);
      const sellerName = openShifts[chatId]?.seller || 'Продавец';
      await checkCashLimit(cashAmount, sellerName, shopName);
    }

    // Обработка открытия смены — расширенный список фраз
    if (!isOwner && text) {
      const tl = text.toLowerCase();
      const isOpenPhrase = tl.includes('открыв') || tl.includes('открыт') || tl.includes('начинаю смен') ||
        tl.includes('начала смен') || tl.includes('смена начал') || tl.includes('доброе утро') ||
        tl.includes('начинаем') || tl.includes('на смене') || tl.includes('вышла на смен') ||
        tl.includes('вышел на смен') || tl.includes('/start');
      if (isOpenPhrase) {
        openShifts[chatId] = { shop: shopName, openTime: new Date(), seller: 'Продавец' };
      }
    }

    // Парсим имя продавца из ответа Томи если встречается SELLER_NAME:
    const sellerMatch = reply.match(/SELLER_NAME:(.+)/);
    if (sellerMatch && !isOwner) {
      const name = sellerMatch[1].trim();
      if (!openShifts[chatId]) openShifts[chatId] = { shop: shopName, openTime: new Date() };
      openShifts[chatId].seller = name;
      console.log('Имя продавца:', name);
    }

    // Показ списка предоплат продавцу
    if (!isOwner && reply.includes('PREPAY_LIST:')) {
      const listType = reply.includes('PREPAY_LIST:все') ? 'все' : 'открытые';
      try {
        const rows = await getSheetData('Предоплаты!A:K');
        if (rows.length < 2) {
          await bot.sendMessage(chatId, '📋 Предоплат пока нет.');
        } else {
          const list = rows.slice(1).filter(r => {
            const status = String(r[8] || '').trim();
            const hasClient = String(r[2] || '').trim() !== '';
            if (listType === 'все') return hasClient;
            return hasClient && (status.includes('Открыт') || status.includes('открыт') || status === '');
          });
          if (list.length === 0) {
            await bot.sendMessage(chatId, listType === 'все' ? '📋 Предоплат нет.' : '📋 Открытых предоплат нет.');
          } else {
            let msg = listType === 'все' ? 
              `📋 *Все предоплаты (${list.length} шт):*

` : 
              `📋 *Открытые предоплаты (${list.length} шт):*

`;
            list.slice(0, 15).forEach((r, i) => {
              const status = String(r[8] || '').toLowerCase();
              const isOpen = status.includes('открыт') || status === '';
              const icon = isOpen ? '🟡' : '✅';
              const amount = parseInt(String(r[6]||'0').replace(/[^\d]/g,'')) || 0;
              const balance = parseInt(String(r[7]||'0').replace(/[^\d]/g,'')) || 0;
              msg += `${icon} *${r[2]||'—'}* · ${r[1]||''}\n`;
              msg += `   ${r[4]||'—'} · ${r[5]||'—'}\n`;
              msg += `   Аванс: ${amount.toLocaleString()} ₸`;
              if (balance > 0) msg += ` · Остаток: ${balance.toLocaleString()} ₸`;
              if (!isOpen && r[9]) msg += `\nВыдан: ${r[9]}`;
              msg += '\n\n';
            });
            if (list.length > 15) msg += `...и ещё ${list.length - 15} записей`;
            const cleanMsg = reply.replace(/PREPAY_LIST:\S+/g, '').trim();
            if (cleanMsg) await bot.sendMessage(chatId, cleanMsg);
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
          }
        }
      } catch(e) {
        console.error('Ошибка загрузки предоплат:', e.message);
        await bot.sendMessage(chatId, 'Не удалось загрузить предоплаты. Попробуй ещё раз.');
      }
      return; // выходим, уже ответили
    }

    // Сохранение предоплаты
    if (!isOwner && reply.includes('PREPAY_SAVE:')) {
      const jsonLine = reply.split('\n').find(l => l.trim().startsWith('{') && l.includes('client'));
      if (jsonLine) {
        try {
          const p = JSON.parse(jsonLine);
          const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
          const seller = openShifts[chatId]?.seller || p.seller || 'Продавец';
          await savePrepay(p, shopName, seller);
          console.log('Предоплата сохранена:', p.client);
        } catch(e) { console.error('Ошибка парсинга предоплаты:', e.message); }
      }
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
          ((d.rosta_bonus||0)>0?`  Бонусы: ${d.rosta_bonus.toLocaleString()} ₸\n`:'') +
          ((d.rosta_returns||0)>0?`  Возвраты: −${d.rosta_returns.toLocaleString()} ₸\n`:'') +
          `  *ИТОГО: ${rostaTotal.toLocaleString()} ₸*\n\n` +
          ((d.terminal_personal||0)>0?`  Личная карта (терминал): ${d.terminal_personal.toLocaleString()} ₸\n`:'') +
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
          d.terminal_kaspi||0, d.terminal_halyk||0, d.terminal_personal||0,
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
      const cleanReply = reply.replace(/CASH_ALERT:\d+/g, '').replace(/PREPAY_SAVE:[\s\S]*?(\n\n|$)/g, '').trim();
      await bot.sendMessage(chatId, cleanReply);
    }

  } catch (err) {
    console.error('Ошибка:', err.message);
    await bot.sendMessage(chatId, 'Произошла ошибка, попробуй ещё раз.');
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));
console.log('Бот слушает...');