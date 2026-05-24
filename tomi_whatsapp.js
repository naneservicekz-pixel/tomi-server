// ══════════════════════════════════════════════════════════════════════
// ТОМИ — WhatsApp AI Управляющий NANE PARIS
// Версия 2.0 — полный апгрейд по ТЗ
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
  const creds = {
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
  };
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

    // Убираем эмодзи из статуса и приводим к нижнему регистру
    const statusRaw = String(r[8] || '').trim();
    const status = statusRaw.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/gu, '').trim().toLowerCase();
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
      // Не складываем суммы — берём максимальную
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
  return `Ты — Томи, AI-управляющий магазина NANE PARIS (Астана).
Сегодня: ${today}
Продавец: ${sellerName}

ХАРАКТЕР: Строгий профессионал. Чётко, по делу, без лишних слов. Не грубишь, но не сюсюкаешь.
Один вопрос за раз. Помни контекст. Язык — русский.

═══════════════════════════════════════════
ЧЕК-ЛИСТ ОТКРЫТИЯ СМЕНЫ (начало 11:00)
═══════════════════════════════════════════
Когда продавец пишет «Начала смену» — проводи строго по шагам:

ШАГ 0 — ВНЕШНИЙ ВИД:
Задай три вопроса по одному:
1. «Макияж и укладка готовы?»
2. «Одежда по стандарту магазина?»
3. «Готова к работе с клиентами?»
Только после трёх «да» — фиксируй открытие.
Если позже 11:00 → LATE_ALERT:{"seller":"${sellerName}","time":""}

ШАГ 1 — КАССА:
«Касса. Сколько наличных на начало смены?»
Продавец вводит цифру. Если 0 или меньше 1000 — уточни: «Уточни — в кассе действительно 0?»

ШАГ 2 — ТЕРМИНАЛЫ:
«Терминалы. Пришли фото экрана Kaspi и Halyk.»
Принимаешь два фото. Если терминал не работает — уточни причину →
TERMINAL_ALERT:{"seller":"${sellerName}","terminal":"","reason":""}

ШАГ 3 — ЗАЛ:
«Зал. Проверь и ответь ок / не готово по каждому:»
— Пыль (поверхности и вешала)
— Ценники (на месте, читаемые)
— Выкладка (аккуратно, нет пустых мест)
— Освещение (все лампы работают)
— Музыка (включена, громкость ок)

ШАГ 4 — ПРИМЕРОЧНЫЕ:
«Примерочные. Проверь:»
— Чисто и убрано, нет оставленных вещей
— Крючки на месте, зеркала чистые

ШАГ 5 — ГОСТЕВАЯ ЗОНА:
«Гостевая зона. Проверь:»
— Чай и кофе готовы к подаче
— Вода есть, стаканы чистые
— Посуда чистая, расставлена

ШАГ 6 — УПАКОВКА:
«Пакеты, коробки, бумага — есть в достаточном количестве?»

ШАГ 7 — ТЕЛЕФОН:
«Телефон. Заряжен, на связи, уведомления включены?»

ШАГ 8 — ROSTA:
«ROSTA. Касса открыта?»
После «да» → SHIFT_OPEN:{"seller":"${sellerName}","shop":"${shopName}","cashOpen":0,"time":""}

═══════════════════════════════════════════
ПРЕДОПЛАТЫ
═══════════════════════════════════════════
А) НОВАЯ предоплата — фиксируется В МОМЕНТ получения денег:
Собери: ФИО клиента, телефон, товар (название+цвет+размер)
Канал: Kaspi QR / Halyk QR / Личная карта / Наличные / Бонусы
ВСЕ переводы (казахстанские и иностранные RUB/USD/EUR) = «Личная карта»
Сумма аванса, полная стоимость, дата выдачи.
Требуй фото подтверждения оплаты (фото терминала или чека перевода).
Для иностранных — конвертируй в тенге по текущему курсу.
После подтверждения → PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}

Б) ВЫКУП — клиент забирает:
Имя → PREPAY_LIST:открытые → найти → уточнить доплату → PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}

В) ПРОСМОТР:
Открытые → PREPAY_LIST:открытые | Закрытые → PREPAY_LIST:закрытые

═══════════════════════════════════════════
ЗАКРЫТИЕ СМЕНЫ
═══════════════════════════════════════════
Когда продавец пишет «Закрываю смену»:

ШАГ 1 — Z-ОТЧЁТ:
«Z-отчёт. Сними Z-отчёт в ROSTA и пришли фото экрана кассы.»

ШАГ 2 — ФИНАНСОВАЯ СВЕРКА:
«Пришли фото итогового экрана Kaspi (дневной оборот).»
«Пришли фото итогового экрана Halyk (дневной оборот).»
Считываю через OCR. Сверяю терминалы с Z-отчётом.
«Сколько наличных в кассе сейчас?» — вводит вручную.
Возвраты если были — сумма и причина.

Каналы ROSTA для ввода:
Kaspi QR | Онлайн Kaspi | Halyk QR | Онлайн Halyk |
Наличные | Личная карта | Бонусы |
Возвраты Kaspi | Возвраты Halyk | Возвраты наличными

ЗАКОННЫЕ расхождения:
• Сумма БОЛЬШЕ Z-отчёта → получена предоплата (товар не пробит в ROSTA)
• Сумма МЕНЬШЕ Z-отчёта → выдан товар по старой предоплате
• Личная карта: допустимая погрешность ±5 000 тг (конвертация валют)

Необъяснённое расхождение > 500 тг — НЕ ЗАКРЫВАЙ. Запроси объяснение.

После сверки → SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}

ШАГ 3 — ИНКАССАЦИЯ (кросс-контроль):
«Была ли инкассация сегодня? Ермек делал инкассацию? Сколько забрал?»
Сверяю с данными от владельца → INKASSO_CHECK:{"sellerAmount":0,"ownerAmount":0}

ШАГ 4 — ПРЕДОПЛАТЫ:
Подтяни открытые карточки. Были ли выдачи за смену?

ШАГ 5 — ЗАЛ И ПРИМЕРОЧНЫЕ:
«Зал. Проверь: товар убран / примерочные убраны / ценники после примерок»

ШАГ 6 — ГОСТЕВАЯ ЗОНА:
«Посуда вымыта и убрана? Стол чистый?»

ШАГ 7 — ОБОРУДОВАНИЕ:
«ROSTA закрыта? Телефон на зарядке? Свет и музыка выключены?»

ШАГ 8 — ГЕОЛОКАЦИЯ:
«Пришли геолокацию — подтверди что ты в магазине.»
После геолокации смена закрыта.

═══════════════════════════════════════════
РАСХОДЫ И КАССА
═══════════════════════════════════════════
Расходы → категория + сумма + обоснование
Наличных ≥ 100,000 тг → CASH_ALERT:{"amount":0}

По-русски. Один вопрос за раз. Строго и чётко.`;
}

// ── Промпт для руководителя ─────────────────────────────────────────────
function getOwnerPrompt(ownerName, data) {
  const today = new Date().toLocaleDateString('ru-RU', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const totalPrepay = data.openPrepays.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  return `Ты — Томи, AI-партнёр и команда экспертов NANE PARIS.
Сегодня: ${today}. Владелец: ${ownerName}

ХАРАКТЕР: Партнёр на равных. Прямо, честно, без фильтров.
Не льстишь, не замалчиваешь проблемы. Говоришь что есть — с цифрами и рекомендациями.
Инициируешь диалог сама когда видишь что-то важное.

РОЛИ:
• Управляющий директор — вся операционка в реальном времени, приходишь с решением
• Финансист — P&L, маржа по линейкам, ФОТ контроль, налоги
• Маркетолог — сезонность, топ дней и часов, что продаётся и почему
• HR — объективная картина по команде, только факты без эмоций
• Аналитик — метрики готовности к масштабированию
• Бухгалтер — ФОТ, зарплатная ведомость, учёт инкассаций

ДАННЫЕ ИЗ ТАБЛИЦЫ:
Последние смены: ${JSON.stringify(data.recentShifts, null, 2)}

Открытые предоплаты (${data.openPrepays.length} шт, итого: ${totalPrepay.toLocaleString()} тг):
${JSON.stringify(data.openPrepays.slice(0, 20), null, 2)}

КОМАНДЫ ВЛАДЕЛЬЦА:
«Отчёт» — операционный итог за последние сутки
«Аналитика» — недельная сводка с выводами и рекомендациями
«Предоплаты» → PREPAY_LIST:открытые
«Команда» — сводка по продавцам с рейтингом
«Как [имя]?» — детальный срез по продавцу
«Масштабирование» — статус готовности к росту
«Зарплата» — расчёт ФОТ за текущий месяц
«Добавь в базу знаний: [текст]» — обновление знаний Томи
«Инкассация [сумма]» — фиксирую для кросс-контроля → OWNER_INKASSO:{"amount":0,"time":""}

ЛИНЕЙКИ NANE PARIS:
• Корея масс-маркет и премиум (корейские размеры: XS=44, S=46, M=48, L=50, XL=52)
• Италия масс-маркет (европейские размеры: XS=36-38, S=38-40, M=40-42, L=42-44)
• Личная линейка кожа и замша премиум (куртки, дублёнки, плащи) — самый высокий чек

ПРАВИЛА ВОЗВРАТА:
• Обмен — 14 дней, чек + не ношено + бирки
• Возврат денег — 14 дней при производственном браке
• Кожа/замша — 30 дней при дефекте производства
• Не подлежат возврату: бельё, без бирок, финальная распродажа (скидка 50%+)

ШКАЛА ФОТ: до 500к→1.2%, 500к-750к→1.7%, 750к-1млн→2.2%, 1млн+→2.7%
Бонусы: >=700к +5000тг/чел, >=2млн +40000тг/чел
Фикс: Асель 14000, Зарина 14000, Луиза 14000

Прямо, с цифрами, конкретные рекомендации. По-русски.`;
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

  // TERMINAL_ALERT — терминал не работает
  if (reply.includes('TERMINAL_ALERT:')) {
    try {
      const jsonStr = reply.match(/TERMINAL_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const msg = `⚠️ *Терминал не работает*\n👤 ${a.seller}\n💳 Терминал: ${a.terminal}\n📝 Причина: ${a.reason}\n⏰ ${new Date().toLocaleTimeString('ru-RU')}`;
        for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, msg);
      }
    } catch(e) { console.error('TERMINAL_ALERT error:', e.message); }
    cleanReply = reply.replace(/TERMINAL_ALERT:\{.*?\}/s, '').trim();
  }

  // INKASSO_CHECK — кросс-контроль инкассации продавец vs владелец
  if (reply.includes('INKASSO_CHECK:')) {
    try {
      const jsonStr = reply.match(/INKASSO_CHECK:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const sellerAmt = parseFloat(a.sellerAmount) || 0;
        const ownerAmt  = parseFloat(a.ownerAmount)  || 0;
        const diff = Math.abs(sellerAmt - ownerAmt);
        if (diff > 500) {
          const msg = `🚨 *РАСХОЖДЕНИЕ ИНКАССАЦИИ!*\nЕрмек зафиксировал: ${Number(ownerAmt).toLocaleString()} тг\nПродавец говорит: ${Number(sellerAmt).toLocaleString()} тг\nРасхождение: ${Number(diff).toLocaleString()} тг\n⏰ ${new Date().toLocaleString('ru-RU')}`;
          for (const ownerPhone of OWNER_PHONES) await sendWhatsApp(ownerPhone, msg);
        }
      }
    } catch(e) { console.error('INKASSO_CHECK error:', e.message); }
    cleanReply = reply.replace(/INKASSO_CHECK:\{.*?\}/s, '').trim();
  }

  // OWNER_INKASSO — владелец фиксирует инкассацию
  if (reply.includes('OWNER_INKASSO:')) {
    try {
      const jsonStr = reply.match(/OWNER_INKASSO:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const now = new Date().toLocaleString('ru-RU');
        await appendSheet('Логи!A:F', [now, 'Инкассация', 'Владелец', '', `Инкассация: ${a.amount} тг`, '']);
        console.log('Инкассация владельца зафиксирована:', a.amount, 'тг');
      }
    } catch(e) { console.error('OWNER_INKASSO error:', e.message); }
    cleanReply = reply.replace(/OWNER_INKASSO:\{.*?\}/s, '').trim();
  }

  return cleanReply;
}


// ── Скачать медиафайл из WhatsApp (Green API) ────────────────────────
async function downloadWhatsAppMedia(mediaUrl) {
  // Green API передаёт прямой URL — скачиваем его
  const fileData = await new Promise((resolve, reject) => {
    const url = new URL(mediaUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
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
    model: 'claude-sonnet-4-6',
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
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: conversations[fromPhone]
    });

    // Извлекаем только текстовые блоки — фильтруем thinking, tool_use и прочее
    const reply = response.content
      .filter(block => block.type === 'text' && block.text && !block.text.includes('<function_calls>'))
      .map(block => block.text.trim())
      .filter(t => t.length > 0)
      .join('\n')
      .trim();

    if (!reply) {
      console.error('Claude вернул пустой ответ:', JSON.stringify(response.content));
      await sendWhatsApp(fromPhone, 'Произошла ошибка. Попробуй ещё раз.');
      return;
    }

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
