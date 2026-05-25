// ══════════════════════════════════════════════════════════════════════
// ТОМИ — Telegram AI Управляющий NANE PARIS
// Версия 3.0 — Telegram + Supabase память
// ══════════════════════════════════════════════════════════════════════

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ── Supabase ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Переменные окружения ──────────────────────────────────────────────
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID    = process.env.SPREADSHEET_ID;
const CASH_ALERT_LIMIT  = parseInt(process.env.CASH_ALERT_LIMIT || '100000');

const OWNER_IDS = (process.env.OWNER_TELEGRAM_IDS || '').split(',').map(p => p.trim()).filter(Boolean);

const ALLOWED_MAP = {};
(process.env.ALLOWED_TELEGRAM_USERS || '').split(',').forEach(entry => {
  const [id, name] = entry.split(':');
  if (id && name) ALLOWED_MAP[id.trim()] = name.trim();
});
OWNER_IDS.forEach(id => { if (!ALLOWED_MAP[id]) ALLOWED_MAP[id] = 'Руководитель'; });

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Память ────────────────────────────────────────────────────────────
const conversations = {};
const openShifts    = {};

// ── Supabase функции ──────────────────────────────────────────────────
async function loadConversation(userId) {
  try {
    const { data } = await supabase
      .from('conversations')
      .select('role, content')
      .eq('phone', userId)
      .order('created_at', { ascending: true })
      .limit(20);
    return data || [];
  } catch(e) { return []; }
}

async function saveMessages(userId, userContent, assistantContent) {
  try {
    await supabase.from('conversations').insert([
      { phone: userId, role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) },
      { phone: userId, role: 'assistant', content: assistantContent }
    ]);
  } catch(e) { console.error('Supabase save error:', e.message); }
}

async function loadOpenShift(userId) {
  try {
    const { data } = await supabase.from('open_shifts').select('*').eq('phone', userId).single();
    return data || null;
  } catch(e) { return null; }
}

async function saveOpenShift(userId, shiftData) {
  try {
    await supabase.from('open_shifts').upsert({ phone: userId, ...shiftData });
  } catch(e) { console.error('Supabase shift save error:', e.message); }
}

async function deleteOpenShift(userId) {
  try {
    await supabase.from('open_shifts').delete().eq('phone', userId);
  } catch(e) { console.error('Supabase shift delete error:', e.message); }
}

// ── Google Sheets ─────────────────────────────────────────────────────
const GOOGLE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDXQU0YWE5wixDi
kU0X0blrAMQASdMvaQxWlztaWeSQ8K1/uj9Cgm5o1Q4YJY5tL++7xSZN7TYNhQ/n
m17QnOVsQyF7WSNq9hcJwQPBBO2QKXANjD1O32Bqe/A4OVB0upjjq/MLwRAgMo3/
ZhHabhn/zT6ZMo22hKiVAmSs5ZhOu22zdUK7nimucBF6O0H+hCfhEXVN91JcQKiU
puF4bpYMYpdg/BMW4ERyXg8BOwRQ++Zufkpuw/qbT7PidqY0ZydGcNsQ/k0z0h1m
qDxCWQwvleF0FPMV5mNfycjHcxbzRdG1XmfSI9uEs5wWKhZaKA6BYXJICUvCTY23
B+DIC909AgMBAAECggEACimXAEj9AmMNEUafCeVDeH82VwrP5GC0gysL048ZE38K
uz7EXqQQnoo+f9qCuqTFJUuLFynq6nZSLahVcIppFMnSPRlUgCfYUcQnJKKnrO3J
O0PYH3mRev2Dy20TShYxgoAwpD5Wv/pltKgxkWsvduGjrLETuolRTzWoIfc1+rOC
4ptUNfSduMv9Jm5x5oeINQU5Phq7Srzs5gxNPyvVYylcbuEilkyxqbl2EEVRL5dU
UavVt/0KyugLFVWRd27A/7LemFMSxO9AQbf5O23T5lonB8oIksq7+5YkicEzl17C
KSyBoiZMnj2rWx/5BqrTP13HTXkV8pnLxG7znzqN+QKBgQD8a0IHp4eYptxoq3BJ
mkg4oQjlTGjfDRwwaP5ln9k0alMT0h8CklQyztWUvuMhKWs/aETGLWaTqNbIwjmK
BghI/uoGOBx3w2FsjfV+xEctT70U5zxnbuLlH84tKRrZgJ8wJbK8E2Mzqgw6+zN9
hrAtvHcO+PYxwDwl1tXrEJpCiQKBgQDaTxIE+nehurO+5EwJIKYxU4mz2l46tGdD
OhmhxumFir/H0za26tSCdaa1XtX/jiVTyEn9nq3j8Rmcg4TzVfajHIjCJWF2ySCa
0B2fLwkmIcO13Sw/N2bFP19jHdh9mw20/Vx287CsAGLrP1rWBvbzZ2z9lOpKXDgV
SmSFtUcoFQKBgHQqpJPDPPs657rgE2g8MbqmGeL1PFpSvUNmPpXkb+DYge1gSVc0
or1TRSYUh5EOb8YZpXUTFd8k19xCzpo/1nZJoshD8I4Jg/+igXXavOsUhG9nT/xG
IvPRpGBSR4IL2Lce0lgOEByJyOEoFHVTlCcoUh644wzYbJX5fi+VT3kJAoGBAJUf
VADAkr2QCj5INkQ54CxrkvGfJaTWHH+IjX+7n0KQX6aA+awDRvyCn0jfKjDyCT9s
3lX3cXL1+3e1QzjxLJOI50YvQJ9ijfoSVVmqSIaao9Rz60iXcIUmX+MVvQ83vio2
s1Wx6qnjba6iTUtL4J6ttH6XnV8EFW89rOLEzIFtAoGBAJviAai9xiUBx2hc53Iw
TZNi7Z88wctwijjHcK1IhgE2FmndmtAdTryeKReHaF4LoU8mK6TfwJGtK55eken3
QEEAqs6wz3nwz11a48YdS6P3qWY5zy7cJ5vNmtV72mUwM1jb3cR1N9nlViTRvMGw
G2Xaa8KKIecwaLyNTlVw7DTZ
-----END PRIVATE KEY-----`;

function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: 'tomi-nane',
      private_key_id: '70384f8bcb840da762e2d8493af280a8b84a408b',
      private_key: GOOGLE_PRIVATE_KEY,
      client_email: 'tomi-sheets@tomi-nane.iam.gserviceaccount.com',
      client_id: '100228927705920212548',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/tomi-sheets%40tomi-nane.iam.gserviceaccount.com',
      universe_domain: 'googleapis.com'
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function readSheet(range) {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    return res.data.values || [];
  } catch(e) { console.error('Sheets read error:', e.message); return []; }
}

async function appendSheet(range, values) {
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
    return true;
  } catch(e) { console.error('Sheets append error:', e.message); return false; }
}

async function updateSheetCell(range, value) {
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[value]] }
    });
    return true;
  } catch(e) { console.error('Sheets update error:', e.message); return false; }
}

// ── Отправка Telegram сообщения ───────────────────────────────────────
async function sendTelegram(chatId, text, parseMode = 'HTML') {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));

  for (const chunk of chunks) {
    const body = JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: parseMode });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { if (res.statusCode !== 200) console.error('Telegram send error:', data); resolve(); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    await new Promise(r => setTimeout(r, 300));
  }
}

// ── Загрузка данных ───────────────────────────────────────────────────
async function loadOwnerData() {
  const [shifts, prepays] = await Promise.all([readSheet('Смены!A:Y'), readSheet('Предоплаты!A:K')]);
  const recentShifts = shifts.slice(-30).map(r => ({ date: r[0], seller: r[1], rostaTotal: r[19], factTotal: r[20], diff: r[21], status: r[22] }));
  const openPrepays = prepays.slice(1).filter(r => r[0] && String(r[8]||'').toLowerCase().includes('открыт')).map(r => ({ id: r[0], date: r[1], client: r[2], phone: r[3], item: r[4], channel: r[5], amount: r[6], balance: r[7] }));
  return { recentShifts, openPrepays };
}

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
    const status = String(r[8]||'').replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/gu,'').trim().toLowerCase();
    const amount = parseFloat(String(r[6]||'0').replace(/[^0-9.]/g,''))||0;
    const balance = parseFloat(String(r[7]||'0').replace(/[^0-9.]/g,''))||0;
    const rawPhone = String(r[3]||'').replace(/[^0-9]/g,'');
    const phone = rawPhone.length > 4 ? rawPhone : '';
    const item = String(r[4]||'').trim();
    if (!prepMap[prepId]) {
      prepMap[prepId] = { id: prepId, date: String(r[1]||''), client, phone, channel: String(r[5]||'—'), amount, balance, status, items: [] };
    } else {
      if (!prepMap[prepId].phone && phone) prepMap[prepId].phone = phone;
      if (amount > prepMap[prepId].amount) prepMap[prepId].amount = amount;
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

// ── Форматирование карточки предоплаты (Telegram HTML) ────────────────
function formatPrepayCard(p, num) {
  const isClosed = p.status.includes('закрыт');
  const icon = isClosed ? '✅' : '🟡';
  let card = `${icon} <b>№${num}. ${p.client}</b>\n`;
  if (p.id) card += `🆔 ${p.id}\n`;
  if (p.phone) card += `📞 ${p.phone}\n`;
  if (p.items.length) card += `👗 ${p.items.join(', ')}\n`;
  if (p.date) card += `📅 ${p.date}\n`;
  card += `💰 Аванс: <b>${Number(p.amount).toLocaleString()} тг</b>\n`;
  if (p.balance > 0) card += `⚠️ Долг: <b>${Number(p.balance).toLocaleString()} тг</b>\n`;
  else if (isClosed) card += `✅ Оплачено полностью\n`;
  else card += `💵 Остаток уточнить\n`;
  card += `💳 ${p.channel}\n`;
  return card;
}

// ── Промпты ───────────────────────────────────────────────────────────
function getSellerPrompt(sellerName, shopName) {
  const today = new Date().toLocaleDateString('ru-RU', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  return `Ты — Томи, AI-управляющий магазина NANE PARIS (Астана).
Сегодня: ${today}
Продавец: ${sellerName}

ХАРАКТЕР: Строгий профессионал. Чётко, по делу, без лишних слов. Не грубишь, но не сюсюкаешь.
Один вопрос за раз. Помни контекст. Язык — русский.
ВАЖНО: Никакого Markdown. Никаких *, **, #, ##, _, ~, `. Только обычный текст и эмодзи.

═══════════════════════════════════════════
ЧЕК-ЛИСТ ОТКРЫТИЯ СМЕНЫ (начало 11:00)
═══════════════════════════════════════════
Когда продавец пишет «Начала смену» — проводи строго по шагам:

ШАГ 0 — ВНЕШНИЙ ВИД:
1. «Макияж и укладка готовы?»
2. «Одежда по стандарту магазина?»
3. «Готова к работе с клиентами?»
Только после трёх «да» — фиксируй открытие.
Если позже 11:00 → LATE_ALERT:{"seller":"${sellerName}","time":""}

ШАГ 1 — КАССА:
«Касса. Сколько наличных на начало смены?»

ШАГ 2 — ТЕРМИНАЛЫ:
«Терминалы. Пришли фото экрана Kaspi и Halyk.»
Если терминал не работает → TERMINAL_ALERT:{"seller":"${sellerName}","terminal":"","reason":""}

ШАГ 3 — ЗАЛ:
«Зал. Проверь: Пыль / Ценники / Выкладка / Освещение / Музыка»

ШАГ 4 — ПРИМЕРОЧНЫЕ:
«Примерочные. Проверь: Чисто / Крючки / Зеркала»

ШАГ 5 — ГОСТЕВАЯ ЗОНА:
«Гостевая зона. Проверь: Чай/кофе / Вода / Посуда»

ШАГ 6 — УПАКОВКА:
«Пакеты, коробки, бумага — достаточно?»

ШАГ 7 — ТЕЛЕФОН:
«Телефон заряжен, на связи?»

ШАГ 8 — ROSTA:
«ROSTA открыта?»
После «да» → SHIFT_OPEN:{"seller":"${sellerName}","shop":"${shopName}","cashOpen":0,"time":""}

═══════════════════════════════════════════
ПРЕДОПЛАТЫ
═══════════════════════════════════════════
А) НОВАЯ предоплата:
Собери: ФИО, телефон, товар (название+цвет+размер)
Канал: Kaspi QR / Halyk QR / Личная карта / Наличные / Бонусы
Сумма аванса, полная стоимость, дата выдачи.
Требуй фото подтверждения оплаты.
→ PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}

Б) ВЫКУП:
Имя → PREPAY_LIST:открытые → найти → уточнить доплату → PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}

В) ПРОСМОТР:
Открытые → PREPAY_LIST:открытые | Закрытые → PREPAY_LIST:закрытые

═══════════════════════════════════════════
ЗАКРЫТИЕ СМЕНЫ
═══════════════════════════════════════════
Когда продавец пишет «Закрываю смену»:

ШАГ 1 — Z-ОТЧЁТ: фото экрана ROSTA
ШАГ 2 — ФИНАНСОВАЯ СВЕРКА: фото Kaspi терминал, фото Halyk терминал, наличные вручную
ШАГ 3 — ИНКАССАЦИЯ: «Была инкассация? Сколько забрал Ермек?» → INKASSO_CHECK:{"sellerAmount":0,"ownerAmount":0}
ШАГ 4 — ПРЕДОПЛАТЫ: были выдачи за смену?
ШАГ 5 — ЗАЛ: убрано?
ШАГ 6 — ГОСТЕВАЯ ЗОНА: посуда вымыта?
ШАГ 7 — ОБОРУДОВАНИЕ: ROSTA закрыта? Телефон на зарядке?
ШАГ 8 — ГЕОЛОКАЦИЯ: пришли геолокацию

После сверки → SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}

ЗАКОННЫЕ расхождения:
- Больше Z → получена предоплата
- Меньше Z → выдан товар по старой предоплате
- Личная карта: ±5000 тг допустимо
Необъяснённое > 500 тг — НЕ ЗАКРЫВАЙ.

По-русски. Один вопрос за раз. Строго и чётко.`;
}

function getOwnerPrompt(ownerName, data) {
  const today = new Date().toLocaleDateString('ru-RU', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const totalPrepay = data.openPrepays.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  return `Ты — Томи, AI-партнёр NANE PARIS.
Сегодня: ${today}. Владелец: ${ownerName}

ХАРАКТЕР: Партнёр на равных. Прямо, честно, с цифрами.
ВАЖНО: Никакого Markdown. Никаких *, **, #, ##, _, ~, `. Только обычный текст и эмодзи.

ДАННЫЕ:
Последние смены: ${JSON.stringify(data.recentShifts, null, 2)}
Открытые предоплаты (${data.openPrepays.length} шт, итого: ${totalPrepay.toLocaleString()} тг):
${JSON.stringify(data.openPrepays.slice(0, 20), null, 2)}

КОМАНДЫ:
«Отчёт» — итог за сутки
«Аналитика» — недельная сводка
«Предоплаты» → PREPAY_LIST:открытые
«Команда» — сводка по продавцам
«Зарплата» — расчёт ФОТ
«Инкассация [сумма]» → OWNER_INKASSO:{"amount":0,"time":""}

ШКАЛА ФОТ: до 500к→1.2%, 500к-750к→1.7%, 750к-1млн→2.2%, 1млн+→2.7%
Бонусы: >=700к +5000тг/чел, >=2млн +40000тг/чел
Фикс: Асель 14000, Зарина 14000, Луиза 14000

По-русски. Прямо, с цифрами.`;
}

// ── OCR фото ──────────────────────────────────────────────────────────
async function downloadTelegramFile(fileId) {
  const fileInfo = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`,
      method: 'GET'
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });

  const filePath = fileInfo.result.file_path;
  const fileData = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/file/bot${TELEGRAM_TOKEN}/${filePath}`,
      method: 'GET'
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

async function readPhotoWithClaude(base64Image, photoType) {
  let prompt = '';
  if (photoType === 'zreport') {
    prompt = `Это Z-отчёт из ROSTA. Верни ТОЛЬКО JSON: {"kaspi_qr":0,"online_kaspi":0,"halyk_qr":0,"online_halyk":0,"cash":0,"personal":0,"bonus":0,"ret_kaspi":0,"ret_halyk":0,"ret_cash":0}`;
  } else if (photoType === 'kaspi_terminal') {
    prompt = `Это отчёт Kaspi терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}`;
  } else if (photoType === 'halyk_terminal') {
    prompt = `Это отчёт Halyk терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}`;
  } else {
    prompt = `Опиши документ. Извлеки все числовые данные по продажам и кассе.`;
  }
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
      { type: 'text', text: prompt }
    ]}]
  });
  return response.content[0].text;
}

function detectPhotoType(conversation) {
  const last = conversation.slice(-6).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).toLowerCase()).join(' ');
  if (last.includes('z-отчёт') || last.includes('rosta') || last.includes('роста')) return 'zreport';
  if (last.includes('kaspi терминал') || last.includes('терминал kaspi')) return 'kaspi_terminal';
  if (last.includes('halyk терминал') || last.includes('терминал halyk')) return 'halyk_terminal';
  return 'unknown';
}

// ── Обработка системных команд ────────────────────────────────────────
async function handleSystemCommands(reply, userId, sellerName) {
  let cleanReply = reply;

  if (reply.includes('PREPAY_LIST:')) {
    const type = reply.includes('PREPAY_LIST:закрытые') ? 'closed' : 'open';
    cleanReply = reply.replace(/PREPAY_LIST:\S+/g, '').trim();
    const list = await loadPrepays(type);
    if (list.length === 0) {
      await sendTelegram(userId, type === 'open' ? '📋 Открытых предоплат нет.' : '📋 Закрытых предоплат нет.');
    } else {
      const header = type === 'open' ? `📋 <b>Открытые предоплаты: ${list.length} шт</b>\n\n` : `📋 <b>Закрытые предоплаты: ${list.length} шт</b>\n\n`;
      for (let i = 0; i < list.length; i += 10) {
        const chunk = list.slice(i, i + 10);
        let msg = i === 0 ? header : `📋 <b>...продолжение:</b>\n\n`;
        chunk.forEach((p, idx) => { msg += formatPrepayCard(p, i + idx + 1) + '\n'; });
        await sendTelegram(userId, msg);
      }
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('PREPAY_SAVE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_SAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const phone = String(p.phone||'').replace(/\D/g,'');
        const today = new Date().toISOString().split('T')[0];
        const rows = await readSheet('Предоплаты!A:A');
        let maxNum = 0;
        rows.forEach(r => { const m = String(r[0]||'').match(/PREP-(\d+)/i); if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; } });
        const id = `PREP-${String(maxNum + 1).padStart(4, '0')}`;
        await appendSheet('Предоплаты!A:K', [id, p.date||today, p.client||'', phone.length>4?phone:'', p.item||'', p.channel||'', p.amount||0, p.balance||0, '🟡 Открыта', '', p.notes||sellerName]);
      }
    } catch(e) { console.error('PREPAY_SAVE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_SAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PREPAY_CLOSE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const rows = await readSheet('Предоплаты!A:K');
        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][0]) === String(p.id)) {
            await updateSheetCell(`Предоплаты!I${i+1}`, '🟢 Закрыта');
            await updateSheetCell(`Предоплаты!J${i+1}`, p.closeDate||new Date().toISOString().split('T')[0]);
            await updateSheetCell(`Предоплаты!K${i+1}`, p.notes||'Товар выдан');
            break;
          }
        }
      }
    } catch(e) { console.error('PREPAY_CLOSE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_CLOSE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SHIFT_OPEN:')) {
    try {
      const jsonStr = reply.match(/SHIFT_OPEN:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        const shiftData = { ...s, start_time: new Date().toISOString() };
        openShifts[userId] = shiftData;
        await saveOpenShift(userId, shiftData);
        const now = new Date();
        if (now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() > 15)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `⚠️ <b>Опоздание!</b>\n👤 ${s.seller}\n🕐 ${now.toLocaleTimeString('ru-RU')}`);
        }
        if ((s.cashOpen||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `💰 <b>АЛЕРТ — касса на начало смены</b>\nНаличных: <b>${Number(s.cashOpen).toLocaleString()} тг</b>\n👤 ${s.seller}`);
        }
      }
    } catch(e) { console.error('SHIFT_OPEN error:', e.message); }
    cleanReply = reply.replace(/SHIFT_OPEN:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SHIFT_CLOSE:')) {
    try {
      const jsonStr = reply.match(/SHIFT_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        const shift = openShifts[userId] || await loadOpenShift(userId) || {};
        const today = new Date().toISOString().split('T')[0];
        const rostaTotal = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0)-(s.rRetKaspi||0)-(s.rRetHalyk||0)-(s.rRetCash||0);
        const kaspiNet = (s.tKaspi||0)-(s.tKaspiRet||0);
        const halykNet = (s.tHalyk||0)-(s.tHalykRet||0);
        const cashSales = (s.cashActual||0)-(s.cashOpen||0)+(s.cashPayouts||0)+(s.inkasso||0)+(s.rRetCash||0);
        const factTotal = kaspiNet + halykNet + cashSales + (s.tPersonal||0) + (s.rBonus||0);
        const diff = factTotal - rostaTotal;
        const totalRet = (s.rRetKaspi||0)+(s.rRetHalyk||0)+(s.rRetCash||0);
        const netSales = rostaTotal + totalRet - totalRet;

        await appendSheet('Смены!A:Y', [
          today, shift.seller||sellerName, shift.shop||'',
          s.rKaspi||0, s.rOnline||0, s.rHalyk||0, s.rHalykOnline||0,
          s.rCash||0, s.rPersonal||0, s.rBonus||0,
          s.rRetKaspi||0, s.rRetHalyk||0,
          s.inkasso||0, s.cashPayouts||0, s.cashOpen||0, s.cashActual||0,
          s.tKaspi||0, s.tHalyk||0, s.tPersonal||0,
          rostaTotal, factTotal, diff,
          diff===0 ? '✅ Корректно' : Math.abs(diff)<500 ? '⚠️ Незначительное' : '🚨 Расхождение',
          s.notes||'', new Date().toLocaleString('ru-RU')
        ]);

        const sverkaLine = diff===0 ? '✅ Kaspi · Halyk · Наличные — все сходятся' : Math.abs(diff)<500 ? '⚠️ Незначительное расхождение' : '🚨 РАСХОЖДЕНИЕ — требует внимания';

        const report = `━━━━━━━━━━━━━━━━━━━━━
📊 <b>NANÉ PARIS · ОТЧЁТ СМЕНЫ</b>
━━━━━━━━━━━━━━━━━━━━━
📅 ${today}  👤 ${shift.seller||sellerName}

💚 <b>Чистые продажи: ${Number(rostaTotal).toLocaleString()} тг</b>
💙 Получено деньгами: ${Number(factTotal).toLocaleString()} тг${totalRet>0 ? '\n🔴 Возвраты: −'+Number(totalRet).toLocaleString()+' тг' : ''}

━━━━━━━━━━━━━━━━━━━━━
🔵 <b>KASPI</b>
  📲 Онлайн: ${Number(s.rOnline||0).toLocaleString()} тг
  📱 QR: ${Number(s.rKaspi||0).toLocaleString()} тг
  Терминал: ${Number(kaspiNet).toLocaleString()} тг

🟣 <b>HALYK</b>
  📲 Онлайн: ${Number(s.rHalykOnline||0).toLocaleString()} тг
  📱 QR: ${Number(s.rHalyk||0).toLocaleString()} тг
  Терминал: ${Number(halykNet).toLocaleString()} тг

🟢 <b>ПРОЧИЕ</b>
  💵 Наличные: ${Number(s.rCash||0).toLocaleString()} тг${(s.tPersonal||0)>0 ? '\n  💳 Личная карта: '+Number(s.tPersonal||0).toLocaleString()+' тг' : ''}${(s.rBonus||0)>0 ? '\n  🎁 Бонусы: '+Number(s.rBonus||0).toLocaleString()+' тг' : ''}

━━━━━━━━━━━━━━━━━━━━━
💵 <b>КАССА</b>
  Начало: ${Number(s.cashOpen||0).toLocaleString()} → Конец: ${Number(s.cashActual||0).toLocaleString()} тг
  Продажи нал: ${Number(cashSales).toLocaleString()} тг${(s.inkasso||0)>0 ? '\n  💰 Инкассация: −'+Number(s.inkasso||0).toLocaleString()+' тг' : ''}${(s.cashPayouts||0)>0 ? '\n  Расходы: −'+Number(s.cashPayouts||0).toLocaleString()+' тг' : ''}

━━━━━━━━━━━━━━━━━━━━━
🔍 <b>СВЕРКА</b>
  ROSTA: ${Number(rostaTotal).toLocaleString()} тг
  Факт: ${Number(factTotal).toLocaleString()} тг
  Расхождение: <b>${diff>=0?'+':''}${Number(diff).toLocaleString()} тг</b>

${sverkaLine}
━━━━━━━━━━━━━━━━━━━━━`;

        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, report);
        delete openShifts[userId];
        await deleteOpenShift(userId);
      }
    } catch(e) { console.error('SHIFT_CLOSE error:', e.message); }
    cleanReply = reply.replace(/SHIFT_CLOSE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('CASH_ALERT:')) {
    try {
      const jsonStr = reply.match(/CASH_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `💰 <b>АЛЕРТ ИНКАССАЦИИ</b>\nНаличных: <b>${Number(a.amount).toLocaleString()} тг</b>\n👤 ${sellerName}`);
      }
    } catch(e) {}
    cleanReply = reply.replace(/CASH_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('LATE_ALERT:')) {
    try {
      const jsonStr = reply.match(/LATE_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `⚠️ <b>Опоздание!</b>\n👤 ${a.seller}\n🕐 ${a.time}`);
      }
    } catch(e) {}
    cleanReply = reply.replace(/LATE_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('TERMINAL_ALERT:')) {
    try {
      const jsonStr = reply.match(/TERMINAL_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `⚠️ <b>Терминал не работает</b>\n👤 ${a.seller}\n💳 ${a.terminal}\n📝 ${a.reason}`);
      }
    } catch(e) {}
    cleanReply = reply.replace(/TERMINAL_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('INKASSO_CHECK:')) {
    try {
      const jsonStr = reply.match(/INKASSO_CHECK:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const diff = Math.abs((parseFloat(a.sellerAmount)||0)-(parseFloat(a.ownerAmount)||0));
        if (diff > 500) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, `🚨 <b>РАСХОЖДЕНИЕ ИНКАССАЦИИ!</b>\nЕрмек: ${Number(a.ownerAmount).toLocaleString()} тг\nПродавец: ${Number(a.sellerAmount).toLocaleString()} тг\nРасхождение: ${Number(diff).toLocaleString()} тг`);
        }
      }
    } catch(e) {}
    cleanReply = reply.replace(/INKASSO_CHECK:\{.*?\}/s, '').trim();
  }

  if (reply.includes('OWNER_INKASSO:')) {
    try {
      const jsonStr = reply.match(/OWNER_INKASSO:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        await appendSheet('Логи!A:F', [new Date().toLocaleString('ru-RU'), 'Инкассация', 'Владелец', '', `Инкассация: ${a.amount} тг`, '']);
      }
    } catch(e) {}
    cleanReply = reply.replace(/OWNER_INKASSO:\{.*?\}/s, '').trim();
  }

  return cleanReply;
}

// ── Основной обработчик ───────────────────────────────────────────────
async function handleMessage(userId, messageText, photoFileId) {
  const senderName = ALLOWED_MAP[String(userId)];
  if (!senderName) {
    await sendTelegram(userId, '🔒 Доступ закрыт. Обратитесь к руководителю.');
    return;
  }

  const isOwner = OWNER_IDS.includes(String(userId));

  if (!conversations[userId]) {
    const history = await loadConversation(String(userId));
    conversations[userId] = history;
  }

  let userContent;

  if (photoFileId) {
    try {
      await sendTelegram(userId, '📷 Читаю фото...');
      const base64 = await downloadTelegramFile(photoFileId);
      const photoType = detectPhotoType(conversations[userId] || []);
      const ocrResult = await readPhotoWithClaude(base64, photoType);
      let contextText = '';
      if (photoType === 'zreport') contextText = 'Прочитал Z-отчёт ROSTA:\n' + ocrResult;
      else if (photoType === 'kaspi_terminal') contextText = 'Прочитал Kaspi терминал:\n' + ocrResult;
      else if (photoType === 'halyk_terminal') contextText = 'Прочитал Halyk терминал:\n' + ocrResult;
      else contextText = 'Прочитал фото:\n' + ocrResult;
      userContent = [
        { type: 'text', text: messageText || 'Прочитай данные с фото.' },
        { type: 'text', text: contextText }
      ];
    } catch(e) {
      console.error('OCR error:', e.message);
      userContent = messageText || 'Не удалось прочитать фото.';
    }
  } else {
    userContent = messageText;
  }

  conversations[userId].push({ role: 'user', content: userContent });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  try {
    let systemPrompt;
    if (isOwner) {
      const data = await loadOwnerData();
      systemPrompt = getOwnerPrompt(senderName, data);
    } else {
      systemPrompt = getSellerPrompt(senderName, 'NANE PARIS Астана');
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: conversations[userId]
    });

    const reply = response.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text.trim())
      .filter(t => t.length > 0)
      .join('\n').trim();

    if (!reply) { await sendTelegram(userId, 'Произошла ошибка. Попробуй ещё раз.'); return; }

    conversations[userId].push({ role: 'assistant', content: reply });
    await saveMessages(String(userId), userContent, reply);

    const cleanReply = await handleSystemCommands(reply, userId, senderName);
    if (cleanReply && cleanReply.trim()) await sendTelegram(userId, cleanReply);

    await appendSheet('Логи!A:F', [
      new Date().toLocaleString('ru-RU'),
      isOwner ? 'Руководитель' : 'Продавец',
      senderName, String(userId),
      messageText || '[фото]',
      cleanReply?.slice(0, 500) || ''
    ]);

  } catch(e) {
    console.error('Claude error:', e.message);
    await sendTelegram(userId, 'Произошла ошибка. Попробуй ещё раз.');
  }
}

// ── Webhook Telegram ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const message = body.message || body.edited_message;
    if (!message) return;

    const userId = message.chat.id;
    const messageText = message.text || message.caption || '';
    const photoFileId = message.photo ? message.photo[message.photo.length - 1].file_id : null;

    if (!messageText && !photoFileId) return;
    await handleMessage(userId, messageText, photoFileId);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'TOMI NANE PARIS Telegram', version: '3.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Томи Telegram запущена на порту ${PORT}`);

  // Регистрируем webhook
  const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`;
  const body = JSON.stringify({ url: webhookUrl });
  https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/setWebhook`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log('Webhook установлен:', data));
  }).end(body);
});
