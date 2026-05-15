// ══════════════════════════════════════════════════════════════════════
// ТОМИ — WhatsApp AI Управляющий NANE PARIS
// Версия 1.0 — с нуля, чистая архитектура
// ══════════════════════════════════════════════════════════════════════

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');

const app = express();
app.use(express.json());

// ── Переменные окружения ──────────────────────────────────────────────
// Green API настройки
const GREEN_API_ID      = process.env.GREEN_API_ID || '7107620766';
const GREEN_API_TOKEN   = process.env.GREEN_API_TOKEN;
const GREEN_API_URL     = `https://7107.api.greenapi.com/waInstance${GREEN_API_ID}`;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID    = process.env.SPREADSHEET_ID;
const CASH_ALERT_LIMIT  = parseInt(process.env.CASH_ALERT_LIMIT || '100000');

// Руководители — их номера получат отчёты
// Формат: 77001234567,77009876543
const OWNER_PHONES = (process.env.OWNER_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);

// Белый список — только эти номера могут писать Томи
// Формат: 77001234567:Продавец1,77009876543:Продавец2
const ALLOWED_MAP = {};
(process.env.ALLOWED_USERS || '').split(',').forEach(entry => {
  const [phone, name] = entry.split(':');
  if (phone && name) ALLOWED_MAP[phone.trim()] = name.trim();
});
// Руководители тоже в белом списке
OWNER_PHONES.forEach(p => { if (!ALLOWED_MAP[p]) ALLOWED_MAP[p] = 'Руководитель'; });

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Память диалогов (в RAM, сбрасывается при перезапуске) ────────────
const conversations = {}; // { phone: [ {role, content}, ... ] }
const openShifts    = {}; // { phone: { name, time, shop, cashOpen } }

// ── Google Sheets ─────────────────────────────────────────────────────
function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function readSheet(range) {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    return res.data.values || [];
  } catch(e) {
    console.error('Sheets read error:', e.message);
    return [];
  }
}

async function appendSheet(range, values) {
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
    return true;
  } catch(e) {
    console.error('Sheets append error:', e.message);
    return false;
  }
}

async function updateSheetCell(range, value) {
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[value]] }
    });
    return true;
  } catch(e) {
    console.error('Sheets update error:', e.message);
    return false;
  }
}

// ── Загрузка данных для руководителя ─────────────────────────────────
async function loadOwnerData() {
  const [shifts, prepays] = await Promise.all([
    readSheet('Смены!A:Y'),
    readSheet('Предоплаты!A:K')
  ]);

  // Последние 30 смен
  const recentShifts = shifts.slice(-30).map(r => ({
    date: r[0], seller: r[1], rostaTotal: r[19], factTotal: r[20], diff: r[21], status: r[22]
  }));

  // Открытые предоплаты
  const openPrepays = prepays.slice(1).filter(r => {
    if (!r[0]) return false;
    const status = String(r[8] || '').toLowerCase();
    return status.includes('открыт');
  }).map(r => ({
    id: r[0], date: r[1], client: r[2], phone: r[3],
    item: r[4], channel: r[5], amount: r[6], balance: r[7]
  }));

  return { recentShifts, openPrepays };
}

// ── Загрузка предоплат для продавца ──────────────────────────────────
async function loadPrepays(type = 'open') {
  const rows = await readSheet('Предоплаты!A:K');
  const prepMap = {};

  rows.slice(1).forEach(r => {
    if (!r[0]) return;
    const prepId = String(r[0]).trim();
    if (!prepId.toUpperCase().startsWith('PREP')) return;

    const client = String(r[2] || '').trim();
    if (!client || client.length < 2) return;
    if (/^CL-\d+$/.test(client) || /^\d+$/.test(client)) return;

    const status   = String(r[8] || '').trim().toLowerCase();
    const amount   = parseFloat(String(r[6] || '0').replace(/[^0-9.]/g, '')) || 0;
    const balance  = parseFloat(String(r[7] || '0').replace(/[^0-9.]/g, '')) || 0;
    const rawPhone = String(r[3] || '').replace(/[^0-9]/g, '');
    const phone    = rawPhone.length > 4 ? rawPhone : '';
    const item     = String(r[4] || '').trim();

    if (!prepMap[prepId]) {
      prepMap[prepId] = {
        id: prepId, date: String(r[1] || ''), client, phone,
        channel: String(r[5] || '—'), amount, balance, status, items: []
      };
    } else {
      if (!prepMap[prepId].phone && phone) prepMap[prepId].phone = phone;
      prepMap[prepId].amount += amount;
      if (status.includes('открыт')) prepMap[prepId].status = status;
    }
    if (item && !prepMap[prepId].items.includes(item)) prepMap[prepId].items.push(item);
  });

  let list = Object.values(prepMap);
  if (type === 'open') list = list.filter(p => p.status.includes('открыт'));
  if (type === 'closed') list = list.filter(p => p.status.includes('закрыт'));
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  return list;
}

// ── Форматирование карточки предоплаты ───────────────────────────────
function formatPrepayCard(p, num) {
  const isClosed = p.status.includes('закрыт');
  const icon = isClosed ? '✅' : '🟡';
  let card = `${icon} *№${num}. ${p.client}*\n`;
  if (p.id) card += `🆔 ${p.id}\n`;
  if (p.phone) card += `📞 ${p.phone}\n`;
  if (p.items.length) card += `👗 ${p.items.join(', ')}\n`;
  if (p.date) card += `📅 ${p.date}\n`;
  card += `💰 Аванс: *${Number(p.amount).toLocaleString()} тг*\n`;
  if (p.balance > 0) card += `⚠️ Долг: *${Number(p.balance).toLocaleString()} тг*\n`;
  else if (isClosed) card += `✅ Оплачено полностью\n`;
  else card += `💵 Остаток уточнить\n`;
  card += `💳 ${p.channel}\n`;
  return card;
}

// ── Промпт для продавца ───────────────────────────────────────────────
function getSellerPrompt(sellerName, shopName) {
  const today = new Date().toLocaleDateString('ru-RU', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  return `Ты — Томи, AI-управляющий магазина NANE PARIS (${shopName}).
Сегодня: ${today}
Продавец: ${sellerName}

Общаешься дружелюбно но чётко. Знаешь продавцов: Зарина, Асель, Луиза, Айнур.
Задавай ОДИН вопрос за раз. Помни контекст разговора.

═══════════════════════════════════════════
ЧЕК-ЛИСТ ОТКРЫТИЯ (11:00-21:00)
═══════════════════════════════════════════
Когда продавец пишет что пришёл — проводи по пунктам по одному:
1. ✅ Открыта смена в ROSTA?
2. 💵 Пересчитана наличка — сколько на начало?
3. 🪞 Раздевалки чистые, вешалки и зеркала на месте?
4. 🗂 Ресепшан убран, лишнее убрано?
5. 👗 В форме? Макияж и причёска готовы ДО начала работы?
6. ☕ Посуда чистая, вода для клиентов набрана?
7. 🛍 Витрина проверена — всё на месте?
8. 🏷 Ценники на месте и читаемы?
9. 🎵 Музыка и освещение включены?
10. 🛍 Пакеты и вешалки в наличии?

Опоздание после 11:15 → LATE_ALERT:{"seller":"${sellerName}","time":""}
После чек-листа → SHIFT_OPEN:{"seller":"${sellerName}","shop":"${shopName}","cashOpen":0,"time":""}

═══════════════════════════════════════════
ПРЕДОПЛАТЫ
═══════════════════════════════════════════
А) НОВАЯ предоплата:
Собери: имя, телефон, товар (название+цвет+размер), канал
(Kaspi / Онлайн Kaspi / Halyk / Онлайн Halyk / Наличные / Личная карта / Бонусы),
сумма аванса, полная стоимость (остаток = полная - аванс), дата визита.
Повтори → подтверждение → PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}

Б) ВЫКУП — клиент забирает:
Имя → PREPAY_LIST:открытые → найти карточку → уточнить доплату → PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}

В) ПРОСМОТР:
Без уточнения → "Открытые или закрытые?"
Открытые → PREPAY_LIST:открытые | Закрытые → PREPAY_LIST:закрытые

═══════════════════════════════════════════
ЗАКРЫТИЕ СМЕНЫ
═══════════════════════════════════════════
Собирай данные последовательно.

ШАГ 1 — ROSTA:
Kaspi QR | Онлайн (Kaspi) | Halyk QR | Онлайн (Halyk) |
Наличные | Личная карта | Бонусы |
Возвраты Kaspi | Возвраты Halyk | Возвраты наличными

ШАГ 2 — ТЕРМИНАЛЫ:
Kaspi: валовые продажи + возвраты (терминал = 3 строки: продажи/возвраты/итого — нужны все)
Halyk: валовые продажи + возвраты
Личная карта терминал

ШАГ 3 — КАССА:
Остаток начало | Пополнения | Выплаты | Инкассация | Остаток конец (пересчитай сейчас)

ШАГ 4 — ПРЕДОПЛАТЫ:
Входящие сегодня? (деньги пришли, товар не выдан → терминал > ROSTA)
Выкуп сегодня? (товар выдан, деньги были раньше → ROSTA > терминал)

ШАГ 5 — СВЕРКА ПО КАНАЛАМ:
Kaspi расхождение = (tKaspi - tKaspiRet) - (rKaspi + rOnline - rRetKaspi) - предоплаты Kaspi
Halyk расхождение = (tHalyk - tHalykRet) - (rHalyk + rHalykOnline - rRetHalyk) - предоплаты Halyk
Наличные расхождение = (cashActual - cashOpen + cashPayouts + inkasso + rRetCash) - rCash - предоплаты нал
Личная карта = tPersonal - rPersonal
Бонусы: в ROSTA есть, в терминале нет — ЭТО НОРМА, объяснять не нужно
Итог = сумма всех расхождений

⚠️ РАСХОЖДЕНИЕ > 500 тг — НЕ ЗАКРЫВАЙ:
Анализируй знак и предлагай причины:

Факт БОЛЬШЕ ROSTA → вероятно:
• Предоплата через терминал, в ROSTA не пробита (товар не оприходован)
• Возврат пробит сегодня в ROSTA, деньги выданы вчера
• Технический сбой терминала

Факт МЕНЬШЕ ROSTA → вероятно:
• Выкуп предоплаты — часть денег была в прошлую смену
• Возврат выдан наличными, пробит через терминал
• Ошибка в ROSTA / лишний чек

Задавай конкретные вопросы, проси доказательства (скриншоты терминала, чеки).
Если продавец объяснил — принимай и закрывай.
Если не может объяснить → UNRESOLVED_DIFF:{"seller":"${sellerName}","diff":0,"notes":""}

Статусы смены:
✅ Закрыта корректно — расхождение < 500 тг
⚠️ С замечаниями — расхождение объяснено продавцом
🚨 Есть вопросы — требует внимания руководителя

После закрытия:
SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}

═══════════════════════════════════════════
ЧЕК-ЛИСТ ЗАКРЫТИЯ
═══════════════════════════════════════════
1. ✅ Смена закрыта в ROSTA?
2. 💵 Касса пересчитана и сдана?
3. ☕ Посуда помыта?
4. 🪞 Раздевалки убраны?
5. 🗂 Торговый зал прибран?
6. 👗 Вещи с примерочных на витрине?
7. 🏷 Ценники проверены?
8. 🎵 Музыка и свет выключены?
9. 🔒 Окна и двери закрыты?
10. 📸 Зал сфотографирован перед уходом?
11. 📝 Нестандартные ситуации за день?

═══════════════════════════════════════════
РАСХОДЫ И КАССА
═══════════════════════════════════════════
Расходы → категория + сумма + обоснование
Пополнение → сумма + источник
Наличных ≥ 100,000 тг → CASH_ALERT:{"amount":0}

Дружелюбно но чётко. Один вопрос за раз. По-русски.`;
}

// ── Промпт для руководителя ─────────────────────────────────────────────
function getOwnerPrompt(ownerName, data) {
  const today = new Date().toLocaleDateString('ru-RU', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const totalPrepay = data.openPrepays.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  return `Ты — Томи, AI-управляющий и бизнес-советник NANE PARIS.
Сегодня: ${today}. Руководитель: ${ownerName}

Работаешь как коммерческий директор + управляющий + HR + бухгалтер.
Говоришь прямо, с цифрами, конкретные рекомендации.
Уточняющий вопрос если запрос неоднозначный.

ДАННЫЕ ИЗ ТАБЛИЦЫ:
Последние смены: ${JSON.stringify(data.recentShifts, null, 2)}

Открытые предоплаты (${data.openPrepays.length} шт, итого: ${totalPrepay.toLocaleString()} тг):
${JSON.stringify(data.openPrepays.slice(0, 20), null, 2)}

ПРЕДОПЛАТЫ:
Без уточнения → "Открытые или закрытые?"
Открытые → PREPAY_LIST:открытые | Закрытые → PREPAY_LIST:закрытые

ЧТО УМЕЕШЬ:
• Управляющий: сводка дня/недели/месяца, опоздания, дисциплина
• Бухгалтер: выручка по каналам, расхождения, расходы, инкассации
• HR: KPI продавцов, паттерны опозданий, мотивация
• Коммерческий директор: динамика выручки, топ дней и каналов, рекомендации
• Операционный директор: стандарты, узкие места, эффективность
• Предоплаты: дебиторка, кто давно не приходит, суммы

Прямо, деловито, с цифрами и рекомендациями.`;
}

// ── Отправка WhatsApp сообщения через Green API ──────────────────────
async function sendWhatsApp(to, text) {
  // Форматируем номер — убираем + и добавляем @c.us
  const chatId = to.replace(/[^0-9]/g, '') + '@c.us';

  // Разбиваем длинные сообщения на части по 4000 символов
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));

  for (const chunk of chunks) {
    const body = JSON.stringify({
      chatId: chatId,
      message: chunk
    });

    await new Promise((resolve, reject) => {
      const url = new URL(`${GREEN_API_URL}/sendMessage/${GREEN_API_TOKEN}`);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          if (res.statusCode !== 200) console.error('Green API send error:', res.statusCode, data);
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Небольшая задержка между сообщениями
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Обработка системных команд из ответа Томи ────────────────────────
async function handleSystemCommands(reply, fromPhone, sellerName) {
  let cleanReply = reply;

  // PREPAY_LIST — показать список предоплат
  if (reply.includes('PREPAY_LIST:')) {
    const type = reply.includes('PREPAY_LIST:закрытые') ? 'closed' : 'open';
    cleanReply = reply.replace(/PREPAY_LIST:\S+/g, '').trim();

    const list = await loadPrepays(type);
    if (list.length === 0) {
      await sendWhatsApp(fromPhone, type === 'open' ? '📋 Открытых предоплат нет.' : '📋 Закрытых предоплат нет.');
    } else {
      const header = type === 'open'
        ? `📋 *Открытые предоплаты: ${list.length} шт*\n\n`
        : `📋 *Закрытые предоплаты: ${list.length} шт*\n\n`;

      // Отправляем по 10 карточек
      for (let i = 0; i < list.length; i += 10) {
        const chunk = list.slice(i, i + 10);
        let msg = i === 0 ? header : `📋 *...продолжение:*\n\n`;
        chunk.forEach((p, idx) => { msg += formatPrepayCard(p, i + idx + 1) + '\n'; });
        await sendWhatsApp(fromPhone, msg);
      }
    }
    if (!cleanReply) return;
  }

  // PREPAY_SAVE — сохранить новую предоплату
  if (reply.includes('PREPAY_SAVE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_SAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const phone = String(p.phone || '').replace(/\D/g, '');
        const today = new Date().toISOString().split('T')[0];

        // Получаем следующий PREP ID
        const rows = await readSheet('Предоплаты!A:A');
        let maxNum = 0;
        rows.forEach(r => {
          const m = String(r[0] || '').match(/PREP-(\d+)/i);
          if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; }
        });
        const id = `PREP-${String(maxNum + 1).padStart(4, '0')}`;

        await appendSheet('Предоплаты!A:K', [
          id, p.date || today, p.client || '', phone.length > 4 ? phone : '',
          p.item || '', p.channel || '', p.amount || 0, p.balance || 0,
          '🟡 Открыта', '', p.notes || sellerName
        ]);
        console.log('Предоплата сохранена:', id);
      }
    } catch(e) { console.error('PREPAY_SAVE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_SAVE:\{.*?\}/s, '').trim();
  }

  // PREPAY_CLOSE — закрыть предоплату (выдать товар)
  if (reply.includes('PREPAY_CLOSE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const rows = await readSheet('Предоплаты!A:K');
        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][0]) === String(p.id)) {
            const rowNum = i + 1;
            await updateSheetCell(`Предоплаты!I${rowNum}`, '🟢 Закрыта');
            await updateSheetCell(`Предоплаты!J${rowNum}`, p.closeDate || new Date().toISOString().split('T')[0]);
            await updateSheetCell(`Предоплаты!K${rowNum}`, p.notes || 'Товар выдан');
            console.log('Предоплата закрыта:', p.id);
            break;
          }
        }
      }
    } catch(e) { console.error('PREPAY_CLOSE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_CLOSE:\{.*?\}/s, '').trim();
  }

  // SHIFT_OPEN — открытие смены
  if (reply.includes('SHIFT_OPEN:')) {
    try {
      const jsonStr = reply.match(/SHIFT_OPEN:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        openShifts[fromPhone] = { ...s, startTime: new Date().toISOString() };

        // Проверяем опоздание
        const now = new Date();
        const hour = now.getHours(), min = now.getMinutes();
        if (hour > 11 || (hour === 11 && min > 15)) {
          const lateMsg = `⚠️ *Опоздание!*\n👤 ${s.seller}\n🕐 ${now.toLocaleTimeString('ru-RU')}\n🏪 ${s.shop}`;
          for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, lateMsg);
        }
        // Проверяем кассу на начало смены
        if ((s.cashOpen || 0) >= CASH_ALERT_LIMIT) {
          const cashOpenMsg = `💰 *АЛЕРТ — касса на начало смены*\nНаличных: *${Number(s.cashOpen).toLocaleString()} тг*\n👤 ${s.seller} | 🏪 ${s.shop}\nНужна инкассация!`;
          for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, cashOpenMsg);
        }
      }
    } catch(e) { console.error('SHIFT_OPEN error:', e.message); }
    cleanReply = reply.replace(/SHIFT_OPEN:\{.*?\}/s, '').trim();
  }

  // SHIFT_CLOSE — закрытие смены
  if (reply.includes('SHIFT_CLOSE:')) {
    try {
      const jsonStr = reply.match(/SHIFT_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        const shift = openShifts[fromPhone] || {};
        const today = new Date().toISOString().split('T')[0];

        // Бонусы: в ROSTA есть (клиент оплатил баллами), в терминале нет — вычитаем из факта для сверки
        const rostaTotal = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0)-(s.rRetKaspi||0)-(s.rRetHalyk||0)-(s.rRetCash||0);
        const kaspiNet   = (s.tKaspi||0)-(s.tKaspiRet||0);
        const halykNet   = (s.tHalyk||0)-(s.tHalykRet||0);
        const cashSales  = (s.cashActual||0)-(s.cashOpen||0)+(s.cashPayouts||0)+(s.inkasso||0)+(s.rRetCash||0);
        const factTotal  = kaspiNet + halykNet + cashSales + (s.tPersonal||0) + (s.rBonus||0);
        const diff       = factTotal - rostaTotal;
        // Эффективность дня
        const grossSales = rostaTotal + (s.rRetKaspi||0) + (s.rRetHalyk||0) + (s.rRetCash||0);
        const totalRet   = (s.rRetKaspi||0) + (s.rRetHalyk||0) + (s.rRetCash||0);
        const netSales   = grossSales - totalRet;

        await appendSheet('Смены!A:Y', [
          today, shift.seller || sellerName, shift.shop || '',
          s.rKaspi||0, s.rOnline||0, s.rHalyk||0, s.rHalykOnline||0,
          s.rCash||0, s.rPersonal||0, s.rBonus||0,
          s.rRetKaspi||0, s.rRetHalyk||0,
          s.inkasso||0, s.cashPayouts||0, s.cashOpen||0, s.cashActual||0,
          s.tKaspi||0, s.tHalyk||0, s.tPersonal||0,
          rostaTotal, factTotal, diff,
          diff === 0 ? '✅ Корректно' : Math.abs(diff) < 500 ? '⚠️ Незначительное' : '🚨 Расхождение',
          s.notes || '', new Date().toLocaleString('ru-RU')
        ]);

        // Алерт инкассации
        if ((s.cashActual || 0) >= CASH_ALERT_LIMIT) {
          const cashMsg = `💰 *АЛЕРТ ИНКАССАЦИИ*\nНаличных в кассе: *${Number(s.cashActual).toLocaleString()} тг*\n👤 ${shift.seller}\n📅 ${today}`;
          for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, cashMsg);
        }

        // Отчёт руководителям
        // Формируем каналы ROSTA
        const kaspiBlock = [
          `  📲 Онлайн Kaspi: ${Number(s.rOnline||0).toLocaleString()} тг`,
          `  📱 Kaspi QR: ${Number(s.rKaspi||0).toLocaleString()} тг`,
          `  Терминал net: ${Number(kaspiNet).toLocaleString()} тг${(s.tKaspiRet||0)>0 ? ' (возврат −'+Number(s.tKaspiRet||0).toLocaleString()+' тг)' : ''}`
        ].join('\n');

        const halykBlock = [
          `  📲 Онлайн Halyk: ${Number(s.rHalykOnline||0).toLocaleString()} тг`,
          `  📱 Halyk QR: ${Number(s.rHalyk||0).toLocaleString()} тг`,
          `  Терминал net: ${Number(halykNet).toLocaleString()} тг${(s.tHalykRet||0)>0 ? ' (возврат −'+Number(s.tHalykRet||0).toLocaleString()+' тг)' : ''}`
        ].join('\n');

        const otherBlock = [
          `  💵 Наличные: ${Number(s.rCash||0).toLocaleString()} тг`,
          (s.tPersonal||0)>0 ? `  💳 Личная карта (Айнур): ${Number(s.tPersonal||0).toLocaleString()} тг` : null,
          (s.rBonus||0)>0 ? `  🎁 Бонусы (−): ${Number(s.rBonus||0).toLocaleString()} тг` : null,
        ].filter(Boolean).join('\n');

        const kassaBlock = (s.inkasso||0)>0
          ? `  Начало: ${Number(s.cashOpen||0).toLocaleString()} тг → Конец: ${Number(s.cashActual||0).toLocaleString()} тг\n  Продажи нал: ${Number(cashSales).toLocaleString()} тг\n  💰 Инкассация: −${Number(s.inkasso||0).toLocaleString()} тг\n  Остаток после: ${Number(s.cashActual||0).toLocaleString()} тг`
          : `  Начало: ${Number(s.cashOpen||0).toLocaleString()} тг → Конец: ${Number(s.cashActual||0).toLocaleString()} тг\n  Продажи нал: ${Number(cashSales).toLocaleString()} тг`;

        const sverkaLine = diff === 0
          ? '✅ Kaspi · Halyk · Наличные — все сходятся'
          : Math.abs(diff) < 500
          ? '⚠️ Незначительное расхождение'
          : '🚨 РАСХОЖДЕНИЕ — требует внимания';

        const report = `━━━━━━━━━━━━━━━━━━━━━
📊 *NANÉ PARIS · ОТЧЁТ СМЕНЫ*
━━━━━━━━━━━━━━━━━━━━━
📅 ${today}  👤 ${shift.seller || sellerName}

💚 *Чистые продажи: ${Number(netSales).toLocaleString()} тг*
💙 Получено деньгами: ${Number(factTotal).toLocaleString()} тг${totalRet>0 ? '\n🔴 Возвраты: −'+Number(totalRet).toLocaleString()+' тг' : ''}

━━━━━━━━━━━━━━━━━━━━━
🔵 *KASPI ТЕРМИНАЛ*
${kaspiBlock}

🟣 *HALYK ТЕРМИНАЛ*
${halykBlock}

🟢 *ПРОЧИЕ КАНАЛЫ*
${otherBlock}

━━━━━━━━━━━━━━━━━━━━━
💵 *КАССА*
${kassaBlock}${(s.cashPayouts||0)>0 ? '\n  Расходы: −'+Number(s.cashPayouts||0).toLocaleString()+' тг' : ''}

━━━━━━━━━━━━━━━━━━━━━
🔍 *СВЕРКА*
  ROSTA: ${Number(rostaTotal).toLocaleString()} тг
  Факт: ${Number(factTotal).toLocaleString()} тг
  Расхождение: *${diff >= 0 ? '+' : ''}${Number(diff).toLocaleString()} тг*

${sverkaLine}
━━━━━━━━━━━━━━━━━━━━━`;

        for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, report);
        delete openShifts[fromPhone];
      }
    } catch(e) { console.error('SHIFT_CLOSE error:', e.message); }
    cleanReply = reply.replace(/SHIFT_CLOSE:\{.*?\}/s, '').trim();
  }

  // CASH_ALERT — алерт наличных
  if (reply.includes('CASH_ALERT:')) {
    try {
      const jsonStr = reply.match(/CASH_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const alertMsg = `💰 *АЛЕРТ ИНКАССАЦИИ*\nНаличных в кассе: *${Number(a.amount).toLocaleString()} тг*\n👤 ${sellerName}\n⏰ ${new Date().toLocaleTimeString('ru-RU')}`;
        for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, alertMsg);
      }
    } catch(e) { console.error('CASH_ALERT error:', e.message); }
    cleanReply = reply.replace(/CASH_ALERT:\{.*?\}/s, '').trim();
  }

  // LATE_ALERT — алерт опоздания
  if (reply.includes('LATE_ALERT:')) {
    try {
      const jsonStr = reply.match(/LATE_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const lateMsg = `⚠️ *Опоздание!*\n👤 ${a.seller}\n🕐 ${a.time}`;
        for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, lateMsg);
      }
    } catch(e) { console.error('LATE_ALERT error:', e.message); }
    cleanReply = reply.replace(/LATE_ALERT:\{.*?\}/s, '').trim();
  }

  return cleanReply;
}


// ── Скачать медиафайл из WhatsApp ────────────────────────────────────
async function downloadWhatsAppMedia(mediaId) {
  // Получаем URL медиафайла
  const urlRes = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v18.0/${mediaId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });

  if (!urlRes.url) throw new Error('Не удалось получить URL медиафайла');

  // Скачиваем файл
  const fileData = await new Promise((resolve, reject) => {
    const url = new URL(urlRes.url);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });

  return fileData.toString('base64');
}

// ── OCR фото через Claude Vision ──────────────────────────────────────
async function readPhotoWithClaude(base64Image, photoType) {
  let prompt = '';

  if (photoType === 'zreport') {
    prompt = `Это Z-отчёт из кассовой программы ROSTA. Извлеки все суммы по каналам оплаты.
Верни ТОЛЬКО JSON без пояснений:
{
  "kaspi_qr": число,
  "online_kaspi": число,
  "halyk_qr": число,
  "online_halyk": число,
  "cash": число,
  "personal": число,
  "bonus": число,
  "ret_kaspi": число,
  "ret_halyk": число,
  "ret_cash": число
}
Если канал не найден — ставь 0. Только цифры без пробелов и символов валюты.`;

  } else if (photoType === 'kaspi_terminal') {
    prompt = `Это отчёт с Kaspi терминала. Терминал показывает три строки: продажи (валовые), возвраты (со знаком минус), итого за период.
Верни ТОЛЬКО JSON:
{
  "gross": число,
  "returns": число,
  "net": число
}
gross = валовые продажи (без возвратов), returns = возвраты (положительное число), net = итого (gross - returns). Только цифры.`;

  } else if (photoType === 'halyk_terminal') {
    prompt = `Это отчёт с Halyk терминала. Извлеки суммы продаж и возвратов.
Верни ТОЛЬКО JSON:
{
  "gross": число,
  "returns": число,
  "net": число
}
gross = валовые продажи, returns = возвраты (положительное число), net = итого. Только цифры.`;

  } else {
    prompt = `Опиши что видишь на этом документе/фото. Извлеки все числовые данные которые могут относиться к продажам, кассе или финансам.`;
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  return response.content[0].text;
}

// ── Определить тип фото по контексту разговора ───────────────────────
function detectPhotoType(conversation) {
  const lastMessages = conversation.slice(-6).map(m => 
    (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).toLowerCase()
  ).join(' ');

  if (lastMessages.includes('z-отчёт') || lastMessages.includes('z отчёт') || 
      lastMessages.includes('зетчёт') || lastMessages.includes('rosta') || 
      lastMessages.includes('роста') || lastMessages.includes('z-report')) {
    return 'zreport';
  }
  if (lastMessages.includes('kaspi терминал') || lastMessages.includes('каспи терминал') ||
      lastMessages.includes('терминал kaspi') || lastMessages.includes('kaspi terminal')) {
    return 'kaspi_terminal';
  }
  if (lastMessages.includes('halyk терминал') || lastMessages.includes('халык терминал') ||
      lastMessages.includes('терминал halyk')) {
    return 'halyk_terminal';
  }
  return 'unknown';
}

// ── Основной обработчик сообщений ────────────────────────────────────
async function handleMessage(fromPhone, messageText, messageType, mediaId) {
  // Проверяем белый список
  const senderName = ALLOWED_MAP[fromPhone];
  if (!senderName) {
    await sendWhatsApp(fromPhone, '🔒 Доступ закрыт. Обратитесь к руководителю.');
    return;
  }

  const isOwner = OWNER_PHONES.includes(fromPhone);

  // Инициализируем историю диалога
  if (!conversations[fromPhone]) conversations[fromPhone] = [];

  let userContent;

  // Обработка фото — OCR через Claude Vision
  if (messageType === 'image' && mediaId) {
    try {
      await sendWhatsApp(fromPhone, '📷 Читаю фото...');
      const base64 = await downloadWhatsAppMedia(mediaId);
      const photoType = detectPhotoType(conversations[fromPhone] || []);
      const ocrResult = await readPhotoWithClaude(base64, photoType);

      let contextText = '';
      if (photoType === 'zreport') {
        contextText = 'Я прочитал Z-отчёт из ROSTA. Вот данные:\n' + ocrResult;
      } else if (photoType === 'kaspi_terminal') {
        contextText = 'Я прочитал отчёт Kaspi терминала. Вот данные:\n' + ocrResult;
      } else if (photoType === 'halyk_terminal') {
        contextText = 'Я прочитал отчёт Halyk терминала. Вот данные:\n' + ocrResult;
      } else {
        contextText = 'Я прочитал фото. Вот что увидел:\n' + ocrResult;
      }

      userContent = [
        { type: 'text', text: messageText || 'Прочитай данные с фото и помоги заполнить смену.' },
        { type: 'text', text: contextText }
      ];
    } catch(e) {
      console.error('OCR error:', e.message);
      userContent = messageText || 'Не удалось прочитать фото, попробуй ещё раз.';
    }
  } else {
    userContent = messageText;
  }

  conversations[fromPhone].push({ role: 'user', content: userContent });

  // Ограничиваем историю последними 20 сообщениями
  if (conversations[fromPhone].length > 20) {
    conversations[fromPhone] = conversations[fromPhone].slice(-20);
  }

  try {
    // Получаем данные для промпта
    let systemPrompt;
    if (isOwner) {
      const data = await loadOwnerData();
      systemPrompt = getOwnerPrompt(senderName, data);
    } else {
      const shopName = 'NANE PARIS Астана';
      systemPrompt = getSellerPrompt(senderName, shopName);
    }

    // Запрос к Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: conversations[fromPhone]
    });

    const reply = response.content[0].text;
    conversations[fromPhone].push({ role: 'assistant', content: reply });

    // Обрабатываем системные команды и получаем чистый текст
    const cleanReply = await handleSystemCommands(reply, fromPhone, senderName);

    // Отправляем ответ
    if (cleanReply && cleanReply.trim()) {
      await sendWhatsApp(fromPhone, cleanReply);
    }

    // Логируем диалог
    await appendSheet('Логи!A:F', [
      new Date().toLocaleString('ru-RU'),
      isOwner ? 'Руководитель' : 'Продавец',
      senderName, fromPhone,
      messageText || '[фото]',
      cleanReply?.slice(0, 500) || ''
    ]);

  } catch(e) {
    console.error('Claude error:', e.message);
    await sendWhatsApp(fromPhone, 'Произошла ошибка. Попробуй ещё раз.');
  }
}

// ── Webhook Green API ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  res.json({ status: 'ok', service: 'TOMI NANE PARIS' });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // сразу отвечаем Green API

  try {
    const body = req.body;
    if (!body || !body.typeWebhook) return;

    // Обрабатываем только входящие сообщения
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    const msg = body.messageData;
    const sender = body.senderData;
    if (!msg || !sender) return;

    // Получаем номер отправителя (убираем @c.us)
    const fromPhone = sender.chatId.replace('@c.us', '').replace('@g.us', '');

    // Игнорируем групповые чаты
    if (sender.chatId.includes('@g.us')) return;

    let messageText = '';
    let mediaId = null;
    let messageType = 'text';

    if (msg.typeMessage === 'textMessage') {
      messageText = msg.textMessageData?.textMessage || '';
    } else if (msg.typeMessage === 'imageMessage') {
      messageType = 'image';
      mediaId = msg.fileMessageData?.downloadUrl;
      messageText = msg.fileMessageData?.caption || '';
    } else if (msg.typeMessage === 'documentMessage') {
      messageType = 'document';
      mediaId = msg.fileMessageData?.downloadUrl;
      messageText = msg.fileMessageData?.caption || '';
    } else {
      return; // игнорируем другие типы
    }

    if (!messageText && !mediaId) return;

    await handleMessage(fromPhone, messageText, messageType, mediaId);
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// ── Health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TOMI NANE PARIS WhatsApp', version: '1.0' });
});

// ── Запуск ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Томи WhatsApp запущена на порту ${PORT}`);
  console.log(`Руководители: ${OWNER_PHONES.join(', ')}`);
  console.log(`Разрешённых пользователей: ${Object.keys(ALLOWED_MAP).length}`);
});
