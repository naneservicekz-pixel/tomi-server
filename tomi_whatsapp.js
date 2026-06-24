// ══════════════════════════════════════════════════════════════════════
// ТОМИ — Telegram AI Управляющий NANE PARIS
// Версия 4.4 — исправлено сохранение фото по порядку
// ══════════════════════════════════════════════════════════════════════

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID    = process.env.SPREADSHEET_ID;
const DASHBOARD_ID      = process.env.DASHBOARD_ID;
const CASH_ALERT_LIMIT  = parseInt(process.env.CASH_ALERT_LIMIT || '100000');

const SHOP_LAT = 51.135307;
const SHOP_LON = 71.396877;
const SHOP_RADIUS = 100;

const OWNER_IDS = (process.env.OWNER_TELEGRAM_IDS || '').split(',').map(p => p.trim()).filter(Boolean);

const ALLOWED_MAP = {};
(process.env.ALLOWED_TELEGRAM_USERS || '').split(',').forEach(entry => {
  const [id, name] = entry.split(':');
  if (id && name) ALLOWED_MAP[id.trim()] = name.trim();
});
OWNER_IDS.forEach(id => { if (!ALLOWED_MAP[id]) ALLOWED_MAP[id] = 'Руководитель'; });

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};
const openShifts = {};
const pendingGeoAction = {};
const checklistTimers = {};
const pendingReopenApprovals = {};
const lastShiftReports = {};
const pendingResendApprovals = {};
const pendingPrepayDelete = {};
const shiftPhotos = {};
const shiftOCR = {}; // Структурные данные OCR по фото: { userKey: { zreport:{...}, kaspi:{...}, halyk:{...} } }
const userLocks = {}; // Сериализация сообщений одного пользователя (защита от гонок)
const PLAN_TOTAL = 27000000; // план магазина/мес
const SELLER_PLANS = {'Асель':8550000,'Зарина':10350000,'Луиза':8100000}; // личные планы
const pendingExpense = {};
const pendingDayReset = {}; // Подтверждение сброса дня владельцем
const pendingClose = {}; // Закрытие, заблокированное расхождением — ждём предоплату/причину от продавца
const firstCloseDone = {}; // Ключ: дата, значение: true если первый уже закрыл

function detectCategory(description) {
  const d = (description || '').toLowerCase();
  if (/еда|обед|ужин|завтрак|ресторан|кафе|кофе|продукты|доставка|food/.test(d)) return 'Еда';
  if (/такси|uber|яндекс|бензин|парковка|авто|машина|каршеринг/.test(d)) return 'Транспорт';
  if (/одежда|шопинг|обувь|покупка|магазин|маркет/.test(d)) return 'Шопинг';
  if (/аренда|коммуналка|свет|вода|газ|интернет|связь/.test(d)) return 'Жильё';
  if (/спорт|фитнес|зал|тренировка/.test(d)) return 'Спорт';
  if (/развлечение|кино|театр|концерт|клуб|отдых/.test(d)) return 'Развлечения';
  if (/лечение|аптека|врач|больница|лекарство/.test(d)) return 'Здоровье';
  if (/реклама|маркетинг|smm|продвижение/.test(d)) return 'Маркетинг';
  if (/канцелярия|офис|хозтовары|уборка/.test(d)) return 'Хозтовары';
  return 'Прочее';
}

async function dbSaveSale(date, revenue, seller1, seller2) {
  try {
    let d = date;
    if (typeof date === 'string' && date.includes('.')) {
      const parts = date.split('.');
      d = parts[2] + '-' + parts[1] + '-' + parts[0];
    }
    const m = parseInt(d.split('-')[1]);
    const y = parseInt(d.split('-')[0]);
    const { error } = await supabase.from('daily_sales').upsert({
      sale_date: d, revenue: Number(revenue),
      seller1: seller1 || '', seller2: seller2 || '',
      month: m, year: y
    }, { onConflict: 'sale_date' });
    if (error) console.error('dbSaveSale error:', error.message);
    return !error;
  } catch(e) { console.error('dbSaveSale exception:', e.message); return false; }
}

async function dbGetSales(month, year) {
  try {
    const { data, error } = await supabase
      .from('daily_sales').select('*')
      .eq('month', month).eq('year', year)
      .order('sale_date', { ascending: true });
    if (error) console.error('dbGetSales error:', error.message);
    return data || [];
  } catch(e) { return []; }
}

async function dbSaveExpense(date, category, amount, description, isPersonal, userId) {
  try {
    const d = typeof date === 'string' && date.includes('.')
      ? date.split('.').reverse().join('-') : date;
    const parts = d.split('-');
    const m = parseInt(parts[1]);
    const y = parseInt(parts[0]);
    if (isPersonal) {
      const { error } = await supabase.from('personal_expenses').insert([{
        user_id: String(userId), amount: Number(amount),
        description: description, category: category, expense_date: date
      }]);
      if (error) console.error('dbSaveExpense personal error:', error.message);
      return !error;
    } else {
      const { error } = await supabase.from('expenses').insert([{
        expense_date: d, category: category, amount: Number(amount),
        description: description, month: m, year: y
      }]);
      if (error) console.error('dbSaveExpense nane error:', error.message);
      return !error;
    }
  } catch(e) { console.error('dbSaveExpense exception:', e.message); return false; }
}

async function dbGetExpenses(month, year, isPersonal, userId) {
  try {
    if (isPersonal) {
      const start = year + '-' + String(month).padStart(2,'0') + '-01';
      const end   = year + '-' + String(month).padStart(2,'0') + '-31';
      const { data } = await supabase.from('personal_expenses')
        .select('*').eq('user_id', String(userId))
        .gte('created_at', start).lte('created_at', end + 'T23:59:59');
      return data || [];
    } else {
      const { data } = await supabase.from('expenses')
        .select('*').eq('month', month).eq('year', year)
        .order('expense_date', { ascending: true });
      return data || [];
    }
  } catch(e) { return []; }
}

async function dbSaveDiscipline(date, sellerName, eventType, eventTime, note) {
  try {
    const d = typeof date === 'string' && date.includes('.')
      ? date.split('.').reverse().join('-') : date;
    await supabase.from('discipline').insert([{
      event_date: d, seller_name: sellerName,
      event_type: eventType, event_time: eventTime, note: note
    }]);
  } catch(e) { console.error('dbSaveDiscipline error:', e.message); }
}

async function dbSavePrepay(id, date, client, phone, item, channel, amount, balance, status, notes, seller) {
  try {
    const d = typeof date === 'string' && date.includes('.')
      ? date.split('.').reverse().join('-') : (date || new Date().toISOString().split('T')[0]);
    const { error } = await supabase.from('prepayments').upsert({
      prep_id: id, prep_date: d, client_name: client, phone: phone,
      item: item, channel: channel, amount: Number(amount),
      balance: Number(balance), status: status || '🟡 Открыта',
      notes: notes, seller_name: seller
    }, { onConflict: 'prep_id' });
    if (error) console.error('dbSavePrepay error:', error.message);
    return !error;
  } catch(e) { console.error('dbSavePrepay exception:', e.message); return false; }
}

async function dbGetPrepays(statusFilter) {
  try {
    let query = supabase.from('prepayments').select('*').order('prep_date', { ascending: true });
    if (statusFilter === 'open') query = query.not('status', 'ilike', '%Закрыта%');
    else if (statusFilter === 'closed') query = query.ilike('status', '%Закрыта%');
    const { data, error } = await query;
    if (error) console.error('dbGetPrepays error:', error.message);
    return (data || []).filter(r => r.client_name && r.client_name.trim().length > 0);
  } catch(e) { return []; }
}

async function dbGetNextPrepayId() {
  try {
    const { data } = await supabase.from('prepayments')
      .select('prep_id').order('prep_id', { ascending: false }).limit(1);
    if (!data || data.length === 0) return 'PREP-0001';
    const last = String(data[0].prep_id || 'PREP-0000');
    const num = parseInt(last.replace('PREP-', '')) + 1;
    return 'PREP-' + String(num).padStart(4, '0');
  } catch(e) { return 'PREP-' + Date.now(); }
}

async function saveKPI(sellerName, score, month, year) {
  try {
    await supabase.from('kpi_scores').upsert({
      seller_name: sellerName, score: score, month: month, year: year
    }, { onConflict: 'seller_name,month,year' });
  } catch(e) { console.error('saveKPI error:', e.message); }
}

async function getKPI(month, year) {
  try {
    const { data } = await supabase.from('kpi_scores')
      .select('*').eq('month', month).eq('year', year);
    const result = {};
    (data || []).forEach(r => { result[r.seller_name] = r.score; });
    return result;
  } catch(e) { return {}; }
}

async function calcSalary(month, year) {
  try {
    const sales = await dbGetSales(month, year);
    if (!sales || sales.length === 0) return null;
    const KE = 14000;
    const TAX_PCT = 0.03;
    const BONUS_PLAN = 30000;
    const KPI_ONE = 25000;
    const personalPlans = { 'Асель': 8550000, 'Зарина': 10350000, 'Луиза': 8100000 };
    const getPct = (amount) => {
      if (amount >= 1000000) return 0.027;
      if (amount >= 750000)  return 0.022;
      if (amount >= 500000)  return 0.017;
      return 0.012;
    };
    const kpiScores = await getKPI(month, year);
    const sellers = ['Асель', 'Зарина', 'Луиза'];
    const data = {};
    sellers.forEach(s => { data[s] = { shifts: 0, sales: 0, bonusGoodDay: 0, bonusRecord: 0, pctSum: 0 }; });
    let totalRevenue = 0;
    sales.forEach(day => {
      const rev = Number(day.revenue || 0);
      totalRevenue += rev;
      const daySellers = [day.seller1, day.seller2].filter(s => s && sellers.includes(s));
      if (daySellers.length === 0) return;
      const dayPct = rev * getPct(rev);
      daySellers.forEach(s => {
        data[s].shifts++;
        data[s].sales += rev / daySellers.length;
        data[s].pctSum = (data[s].pctSum || 0) + dayPct;
        if (rev >= 2000000) data[s].bonusRecord += 40000;
        else if (rev >= 700000) data[s].bonusGoodDay += 5000;
      });
    });
    const result = {};
    sellers.forEach(s => {
      const d = data[s];
      const ke = d.shifts * KE;
      const pct = Math.round(d.pctSum || 0);
      const bonusPlan = d.sales >= (personalPlans[s] || 0) ? BONUS_PLAN : 0;
      const kpiScore = kpiScores[s] !== undefined ? kpiScores[s] : 3;
      const kpiAmt = kpiScore * KPI_ONE;
      const total = ke + pct + d.bonusGoodDay + d.bonusRecord + bonusPlan + kpiAmt;
      result[s] = {
        shifts: d.shifts, sales: Math.round(d.sales), ke, pct,
        kpiScore, kpiAmt, bonusGoodDay: d.bonusGoodDay, bonusRecord: d.bonusRecord,
        bonusPlan, planFact: Math.round(d.sales), planTarget: personalPlans[s] || 0,
        planDone: d.sales >= (personalPlans[s] || 0), total: Math.round(total)
      };
    });
    const totalFot = sellers.reduce((s, name) => s + result[name].total, 0);
    const tax = Math.round(totalRevenue * TAX_PCT);
    return { sellers: result, totalRevenue, totalFot, tax, month, year };
  } catch(e) { console.error('calcSalary error:', e.message); return null; }
}

async function showSalaryReport(userId, month, year) {
  try {
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const calc = await calcSalary(month, year);
    if (!calc) { await sendTelegram(userId, '📊 Нет данных по продажам за ' + (monthNames[month]||month) + ' ' + year); return; }
    const fmt = n => Math.round(n).toLocaleString('ru-RU');
    const sellers = ['Асель', 'Зарина', 'Луиза'];
    let msg = '💰 РАСЧЁТ ЗАРПЛАТЫ — ' + (monthNames[month]||month) + ' ' + year + '\n━━━━━━━━━━━━━━━━━━━━\n\n';
    sellers.forEach(name => {
      const s = calc.sellers[name];
      if (!s || s.shifts === 0) return;
      msg += '👤 ' + name + ' · ' + s.shifts + ' смен\n';
      msg += '  КЕ (выходы): ' + fmt(s.ke) + ' тг\n';
      msg += '  % от продаж: ' + fmt(s.pct) + ' тг\n';
      if (s.bonusGoodDay > 0) msg += '  Бонус хор.день: ' + fmt(s.bonusGoodDay) + ' тг\n';
      if (s.bonusRecord > 0)  msg += '  Рекорд ≥2млн: ' + fmt(s.bonusRecord) + ' тг\n';
      if (s.bonusPlan > 0)    msg += '  Бонус за план: ' + fmt(s.bonusPlan) + ' тг ✅\n';
      else                     msg += '  План: ' + fmt(s.planFact) + ' из ' + fmt(s.planTarget) + ' тг ❌\n';
      msg += '  KPI: ' + s.kpiScore + '/3 = ' + fmt(s.kpiAmt) + ' тг\n';
      msg += '  ▶ ИТОГО: ' + fmt(s.total) + ' тг\n\n';
    });
    msg += '━━━━━━━━━━━━━━━━━━━━\n';
    msg += '💼 Оборот: ' + fmt(calc.totalRevenue) + ' тг\n';
    msg += '📊 ФОТ итого: ' + fmt(calc.totalFot) + ' тг\n';
    msg += '🏛 Налог (3%): ' + fmt(calc.tax) + ' тг\n';
    msg += '💰 Прибыль: ~' + fmt(calc.totalRevenue - calc.totalFot - calc.tax) + ' тг';
    await sendTelegram(userId, msg);
  } catch(e) { console.error('showSalaryReport error:', e.message); }
}

function getNow() { return new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }); }
function getTime() { return new Date().toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' }); }
function getDate() { return new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }

function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// Извлекает JSON после тега по БАЛАНСУ скобок (работает с вложенными {}, напр. prepayApplied:[{...}])
function extractTagJSON(text, tag) {
  const key = tag + ':{';
  const i = text.indexOf(key);
  if (i < 0) return null;
  const start = i + tag.length + 1;
  let depth = 0, end = -1;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) return null;
  return { json: text.slice(start, end), from: i, to: end };
}
function stripTag(text, tag) {
  const r = extractTagJSON(text, tag);
  if (!r) return (text || '').trim();
  return (text.slice(0, r.from) + text.slice(r.to)).trim();
}

// Чистит массив сообщений для Anthropic: без пустых, начинается с user (иначе API 400)
function sanitizeMessages(msgs) {
  let arr = (msgs || []).filter(m => {
    if (!m || !m.role) return false;
    const c = m.content;
    if (typeof c === 'string') return c.trim() !== '';
    if (Array.isArray(c)) return c.length > 0 && c.some(b => (b && b.text && String(b.text).trim() !== '') || (b && b.type === 'image'));
    return false;
  });
  while (arr.length && arr[0].role !== 'user') arr.shift();
  return arr;
}

async function loadConversation(userId) {
  try {
    const { data } = await supabase.from('conversations').select('role, content, created_at').eq('phone', String(userId)).order('created_at', { ascending: false }).limit(40);
    if (!data || data.length === 0) return [];
    return data.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch(e) { return []; }
}

async function saveMessages(userId, userContent, assistantContent) {
  try {
    await supabase.from('conversations').insert([
      { phone: String(userId), role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) },
      { phone: String(userId), role: 'assistant', content: assistantContent }
    ]);
  } catch(e) {}
}

async function loadOpenShift(userId) {
  try {
    const { data } = await supabase.from('open_shifts').select('*').eq('phone', String(userId)).maybeSingle();
    return data || null;
  } catch(e) { return null; }
}

async function saveOpenShift(userId, shiftData) {
  try {
    const dataToSave = { phone: String(userId), ...shiftData };
    const result = await supabase.from('open_shifts').upsert(dataToSave, { onConflict: 'phone' });
    if (result.error && result.error.code === 'PGRST204') {
      const { is_second, ...dataWithout } = dataToSave;
      await supabase.from('open_shifts').upsert(dataWithout, { onConflict: 'phone' });
      console.log('saveOpenShift OK (without is_second)');
    } else {
      console.log('saveOpenShift result:', JSON.stringify(result?.error || 'ok'));
    }
  } catch(e) { console.error('saveOpenShift ERROR:', e.message); }
}

async function saveLastReport(userId, html, filename, caption) {
  try {
    await supabase.from('last_reports').upsert({ user_id: String(userId), html, filename, caption }, { onConflict: 'user_id' });
  } catch(e) { console.error('saveLastReport error:', e.message); }
}

async function loadLastReport(userId) {
  try {
    const { data } = await supabase.from('last_reports').select('*').eq('user_id', String(userId)).maybeSingle();
    return data || null;
  } catch(e) { return null; }
}

async function deleteOpenShift(userId) {
  try { await supabase.from('open_shifts').delete().eq('phone', String(userId)); } catch(e) {}
}

async function loadLastCash() {
  try {
    const { data } = await supabase.from('open_shifts').select('cash_open').order('start_time', { ascending: false }).limit(5);
    if (data && data.length > 0) {
      for (const row of data) { if (row.cash_open && row.cash_open > 0) return row.cash_open; }
    }
    return null;
  } catch(e) { return null; }
}

async function restoreOpenShifts() {
  try {
    const { data } = await supabase.from('open_shifts').select('*');
    if (data) data.forEach(row => { openShifts[row.phone] = row; });
    console.log('Восстановлено смен:', (data||[]).length);
  } catch(e) {}
}

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

function getSheets(spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account', project_id: 'tomi-nane',
      private_key_id: '70384f8bcb840da762e2d8493af280a8b84a408b',
      private_key: GOOGLE_PRIVATE_KEY,
      client_email: 'tomi-sheets@tomi-nane.iam.gserviceaccount.com',
      client_id: '100228927705920212548',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return { api: google.sheets({ version: 'v4', auth }), id: spreadsheetId };
}

async function readSheet(range, spreadsheetId) {
  try {
    const { api, id } = getSheets(spreadsheetId || SPREADSHEET_ID);
    const res = await api.spreadsheets.values.get({ spreadsheetId: id, range });
    return res.data.values || [];
  } catch(e) { console.error('readSheet error:', e.message); return []; }
}

async function appendSheet(range, values, spreadsheetId) {
  try {
    const { api, id } = getSheets(spreadsheetId || SPREADSHEET_ID);
    await api.spreadsheets.values.append({ spreadsheetId: id, range, valueInputOption: 'USER_ENTERED', resource: { values: [values] } });
    return true;
  } catch(e) { console.error('appendSheet error:', e.message); return false; }
}

async function sendTelegram(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    const body = JSON.stringify({ chat_id: chatId, text: chunk });
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => resolve()); });
      req.on('error', reject); req.write(body); req.end();
    });
    await new Promise(r => setTimeout(r, 300));
  }
}

async function forwardPhoto(chatId, fileId, caption) {
  try {
    const body = JSON.stringify({ chat_id: chatId, photo: fileId, caption: caption || '' });
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/sendPhoto', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{ if(res.statusCode!==200) console.error('forwardPhoto error:', d); resolve(); }); });
      req.on('error', reject); req.write(body); req.end();
    });
  } catch(e) { console.error('forwardPhoto error:', e.message); }
}

async function sendTelegramDocument(chatId, filename, content, caption) {
  const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
  const fileBuffer = Buffer.from(content, 'utf8');
  let body = '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n';
  if (caption) body += '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
  body += '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + filename + '"\r\nContent-Type: text/html\r\n\r\n';
  const fullBody = Buffer.concat([Buffer.from(body, 'utf8'), fileBuffer, Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')]);
  await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/sendDocument', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': fullBody.length } }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => { if (res.statusCode !== 200) console.error('sendDocument error:', data); resolve(); }); });
    req.on('error', reject); req.write(fullBody); req.end();
  });
}

async function downloadTelegramFile(fileId) {
  const fileInfo = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + fileId, method: 'GET' }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data))); });
    req.on('error', reject); req.end();
  });
  const fileData = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/file/bot' + TELEGRAM_TOKEN + '/' + fileInfo.result.file_path, method: 'GET' }, res => { const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve(Buffer.concat(chunks))); });
    req.on('error', reject); req.end();
  });
  return fileData.toString('base64');
}

async function readPhotoWithClaude(base64Image, photoType) {
  let prompt;
  if (photoType === 'auto' || !photoType) {
    prompt = 'Это фото финансового отчёта магазина одежды NANE. СНАЧАЛА определи ТИП документа по визуальным признакам:\n'
      + '• zreport — ИТОГОВЫЙ ОТЧЕТ кассовой программы ROSTA: заголовок «ИТОГОВЫЙ ОТЧЕТ» или «Смена», таблица «Отчёт по видам оплат» со СПИСКОМ из нескольких каналов (Halyk QR, Kaspi QR, Онлайн Каспи, Наличные и т.д.) и строка «Итого». Обычно ч/б распечатка или скрин с компьютера.\n'
      + '• kaspi_terminal — экран терминала Kaspi: КРАСНЫЙ интерфейс, логотип Kaspi.kz, надпись Smart POS или «Через Smart POS», строки «N продаж», «N возврата», «Итого за период». ОДИН канал.\n'
      + '• halyk_terminal — экран терминала Halyk: ЗЕЛЁНЫЙ интерфейс, «Отчёт по продажам», строки «Оплата (N)», «Возврат (N)», «Отмена (N)», «Итого». ОДИН канал.\n'
      + 'ГЛАВНЫЙ ПРИЗНАК: в Z-отчёте НЕСКОЛЬКО видов оплат списком и слова «видам оплат»; у терминала — итог по ОДНОМУ каналу. Kaspi красный, Halyk зелёный.\n\n'
      + 'ЗАТЕМ верни ТОЛЬКО JSON, без пояснений и markdown.\n'
      + 'Если терминал:\n{"type":"kaspi_terminal","gross":0,"returns":0,"net":0}\nили\n{"type":"halyk_terminal","gross":0,"returns":0,"net":0}\n(gross = сумма оплат/продаж, returns = сумма возвратов положительным числом, net = итог).\n\n'
      + 'Если Z-отчёт ROSTA:\n{"type":"zreport","kaspi_qr":0,"online_kaspi":0,"halyk_qr":0,"online_halyk":0,"cash":0,"personal":0,"bonus":0,"ret_kaspi_qr":0,"ret_online_kaspi":0,"ret_halyk_qr":0,"ret_online_halyk":0,"ret_cash":0,"ret_personal":0,"itogo":0}\n'
      + 'Сопоставление (продажи): Kaspi QR→kaspi_qr; Онлайн Каспи/Онлайн Kaspi→online_kaspi; Halyk QR→halyk_qr; Онлайн Халык/Онлайн Halyk→online_halyk; Наличные→cash; Личная карта/Личная карточка (с любым именем)→personal; Бонусы→bonus.\n'
      + 'Возвраты (строки со словом Возврат): Kaspi QR (Возврат)→ret_kaspi_qr; Онлайн Каспи (Возврат)→ret_online_kaspi; Halyk QR (Возврат)→ret_halyk_qr; Онлайн Халык (Возврат)→ret_online_halyk; Наличные (Возврат)→ret_cash; Личная карта (Возврат)→ret_personal. itogo = число в строке «Итого:».\n'
      + 'Все значения ПОЛОЖИТЕЛЬНЫЕ. Нет строки — 0. Игнорируй префиксы «1.», «5.». ПРОВЕРКА zreport: сумма продаж − сумма возвратов = itogo.';
  } else prompt = photoType === 'zreport'
    ? 'Это Z-отчет (Итоговый отчёт) из ROSTA. В блоке «Отчёт по видам оплат» строки могут иметь номера-префиксы (например «1.Halyk QR», «5.Онлайн Каспи»). Игнорируй номер, читай название и сумму. Верни ТОЛЬКО JSON без пояснений:\n{"kaspi_qr":0,"online_kaspi":0,"halyk_qr":0,"online_halyk":0,"cash":0,"personal":0,"bonus":0,"ret_kaspi_qr":0,"ret_online_kaspi":0,"ret_halyk_qr":0,"ret_online_halyk":0,"ret_cash":0,"ret_personal":0,"itogo":0}\nСООТВЕТСТВИЕ НАЗВАНИЙ (продажи):\n- "Kaspi QR" → kaspi_qr\n- "Онлайн Каспи" / "Онлайн Kaspi" → online_kaspi\n- "Halyk QR" → halyk_qr\n- "Онлайн Халык" / "Онлайн Halyk" → online_halyk\n- "Наличные" → cash\n- "Личная карта" / "Личная карточка" (с любым именем, напр. «Личная карточка Айнуша») → personal\n- "Бонусы" → bonus\nВОЗВРАТЫ (строки со словом «Возврат», обычно с минусом):\n- "Kaspi QR (Возврат)" → ret_kaspi_qr\n- "Онлайн Каспи (Возврат)" → ret_online_kaspi\n- "Halyk QR (Возврат)" → ret_halyk_qr\n- "Онлайн Халык (Возврат)" → ret_online_halyk\n- "Наличные (Возврат)" → ret_cash\n- "Личная карта (Возврат)" → ret_personal\n- itogo = число в строке "Итого:" внизу блока видов оплат\nПРАВИЛА:\n- Все значения ПОЛОЖИТЕЛЬНЫЕ (минус НЕ ставить, в т.ч. для возвратов).\n- Если строки нет — ставь 0.\n- ПРОВЕРКА: (kaspi_qr+online_kaspi+halyk_qr+online_halyk+cash+personal+bonus) − (все ret_*) должно равняться itogo. Если не сходится — перечитай суммы внимательнее.'
    : photoType === 'kaspi_terminal' ? 'Это отчет Kaspi терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}'
    : photoType === 'halyk_terminal' ? 'Это отчет Halyk терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}'
    : 'Опиши документ. Извлеки все числовые данные по продажам.';
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
      { type: 'text', text: prompt }
    ]}]
  });
  const block = (response.content || []).find(b => b.type === 'text' && b.text);
  return block ? block.text : '{}';
}

// ══════════════════════════════════════════════════════════════════════
// ИСПРАВЛЕНО v4.4: сохранение фото строго по порядку прихода
// Фото 1 = Z-отчёт ROSTA
// Фото 2 = Kaspi терминал
// Фото 3 = Halyk терминал
// ══════════════════════════════════════════════════════════════════════

// (устаревшие savePhotoByOrder/getPhotoTypeByOrder удалены — тип определяется по содержимому)

// Персист OCR в таблицу conversations (переживает редеплой, без новых колонок)
async function persistOCR(userId, type, obj) {
  try { await supabase.from('conversations').insert([{ phone:String(userId), role:'user', content:'[OCR:'+type+']'+JSON.stringify(obj) }]); } catch(e) {}
}
// Восстановление shiftOCR из истории (после рестарта), если память сброшена
function rebuildShiftOCR(userKey) {
  const conv = conversations[userKey] || [];
  if (!shiftOCR[userKey]) shiftOCR[userKey] = {};
  for (const msg of conv) {
    const txt = typeof msg.content === 'string' ? msg.content
      : (Array.isArray(msg.content) ? msg.content.map(c => (c && c.text) || '').join(' ') : '');
    const re = /\[OCR:(zreport|kaspi_terminal|halyk_terminal)\](\{[\s\S]*?\})/g;
    let mt;
    while ((mt = re.exec(txt))) {
      try {
        const obj = JSON.parse(mt[2]);
        if (mt[1] === 'zreport') shiftOCR[userKey].zreport = obj;
        else if (mt[1] === 'kaspi_terminal') shiftOCR[userKey].kaspi = obj;
        else if (mt[1] === 'halyk_terminal') shiftOCR[userKey].halyk = obj;
      } catch(e) {}
    }
  }
  return shiftOCR[userKey];
}

// Сохранение фото по РАСПОЗНАННОМУ типу (не по порядку)
function savePhotoByType(userId, type, photoFileId) {
  if (!shiftPhotos[String(userId)]) shiftPhotos[String(userId)] = {};
  const photos = shiftPhotos[String(userId)];
  if (type === 'zreport') photos.zreport = photoFileId;
  else if (type === 'kaspi_terminal') photos.kaspi = photoFileId;
  else if (type === 'halyk_terminal') photos.halyk = photoFileId;
  console.log('Photo saved by type:', type, '| shiftPhotos:', JSON.stringify(photos));
}

function getSellerPrompt(sellerName, shopName, hasOpenShift, isSecondSeller, firstSellerName) {
  const today = getDate();
  const now = getTime();
  if (isSecondSeller) {
    return 'Ты — Томи, AI-управляющая NANE PARIS (Астана). Ты — женщина.\n' +
      'Сегодня: ' + today + ', время: ' + now + '\nПродавец: ' + sellerName + '\n' +
      'РОЛЬ: Второй продавец смены. Смену уже открыл(а) ' + (firstSellerName || 'первый продавец') + '.\n\n' +
      'ХАРАКТЕР: Строгий профессионал. Четко, по делу. Женский род.\nОдин вопрос за раз. Только русский. Никакого Markdown.\n\n' +
      'КРИТИЧЕСКИ ВАЖНО:\nЕсли продавец пишет "Открыть смену" — это ПРИХОД. Начни ЧЕК-ЛИСТ ПРИХОДА.\nЕсли пишет "Закрыть смену" — это УХОД. Начни чек-лист закрытия.\n\n' +
      'ЧЕК-ЛИСТ ПРИХОДА (второй продавец):\nЕсли позже 11:00 => LATE_ALERT:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'ШАГ 0 — ВНЕШНИЙ ВИД\nШАГ 1 — ГЕОЛОКАЦИЯ: "Пришли геолокацию через скрепку."\n' +
      'Когда геолокация принята — выдай SECOND_ARRIVE и попрощайся.\n' +
      '=> SECOND_ARRIVE:{"seller":"' + sellerName + '","time":"' + now + '"}\n\n' +
      'ЗАКРЫТИЕ (второй продавец): ШАГ 1 — Товар убран? ШАГ 2 — Посуда вымыта? ШАГ 3 — Геолокация.\n' +
      'После геолокации выдай SHIFT_CLOSE:\n' +
      '=> SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetOnlineKaspi":0,"rRetHalyk":0,"rRetHalykOnline":0,"rRetCash":0,"rRetPersonal":0,"rostaCheck":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"second_close","seller2":"' + sellerName + '","notes":"Второй продавец закрыл смену"}\n\n' +
      'ПРЕДОПЛАТЫ:\nНовая => PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}\n' +
      'Выкуп товара по предоплате:\n' +
      '  1. Выдай PREPAY_LIST:открытые (показать список)\n' +
      '  2. Спроси: "Какую предоплату закрываем? Назови ID или имя клиента"\n' +
      '  3. После ответа выдай PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}\n' +
      'Удаление => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента","reason":""}';
  }
  const shiftStatus = hasOpenShift
    ? 'СМЕНА УЖЕ ОТКРЫТА. Не начинай чек-лист открытия заново.'
    : 'Смена не открыта. Начинай чек-лист ТОЛЬКО когда продавец напишет "Начала смену".';
  return 'Ты — Томи, AI-управляющая NANE PARIS (Астана). Ты — женщина.\n' +
    'Сегодня: ' + today + ', время: ' + now + '\nПродавец: ' + sellerName + '\nСТАТУС СМЕНЫ: ' + shiftStatus + '\n\n' +
    'ХАРАКТЕР: Строгий профессионал. Четко, по делу. Женский род.\nОдин вопрос за раз. Только русский. Никакого Markdown.\n\n' +
    'ПРЕДОПЛАТЫ (доступны ВСЕГДА):\nНовая => PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}\n' +
    'Выкуп товара по предоплате:\n' +
    '  1. Выдай PREPAY_LIST:открытые (показать список)\n' +
    '  2. Спроси: "Какую предоплату закрываем? Назови ID или имя клиента"\n' +
    '  3. После ответа выдай PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}\n' +
    'Удаление => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента","reason":""}\n\n' +
    'ЧЕК-ЛИСТ ОТКРЫТИЯ:\nШАГ 0 — ВНЕШНИЙ ВИД. Если позже 11:00 => LATE_ALERT:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
    'ШАГ 1 — ГЕОЛОКАЦИЯ: "Пришли геолокацию через скрепку."\nКогда геолокация принята — спроси шаг 2.\n' +
    'ШАГ 2 — КАССА: сколько наличных? Запомни сумму для SHIFT_OPEN.\n' +
    'ШАГ 3 — ТЕРМИНАЛЫ. ШАГ 4 — ЗАЛ. ШАГ 5 — ПРИМЕРОЧНЫЕ. ШАГ 6 — ГОСТЕВАЯ. ШАГ 7 — УПАКОВКА. ШАГ 8 — ТЕЛЕФОН.\n' +
    'ШАГ 9 — ROSTA: после "да" выдай SHIFT_OPEN с реальной суммой кассы.\n' +
    '=> SHIFT_OPEN:{"seller":"' + sellerName + '","shop":"' + shopName + '","cashOpen":СУММА,"time":"' + now + '"}\n\n' +
    'ЗАКРЫТИЕ СМЕНЫ:\n' +
    'КРИТИЧЕСКИ ВАЖНО ПРО ФОТО: фото Z-отчёта ROSTA, Kaspi и Halyk терминалов принимает и распознаёт СИСТЕМА автоматически — она сама подтверждает приём каждого фото и пишет "Все 3 отчёта собраны". Тебе НЕ нужно просить эти фото, НЕ повторяй шаги с фото, НЕ говори "пришли фото". Если в истории уже есть "приняты системой" — фото готовы, сразу веди опрос по кассе.\n' +
    'КРИТИЧЕСКИ ВАЖНО ПРО КАССУ: НЕ считай сам ожидаемую наличность, расхождения, излишки и недостачи и не называй эти цифры — всю сверку (касса, каналы, план/факт) делает СИСТЕМА автоматически после SHIFT_CLOSE. Твоя задача — собрать ответы и выдать SHIFT_CLOSE. Если продавец спорит о цифрах — не пересчитывай, скажи, что сверку сделает система.\n\n' +
    'Опрос по кассе (СТРОГО по одному вопросу за сообщение):\n' +
    'НАЛИЧНЫЕ — "Сколько наличных в кассе сейчас? Пересчитай." (запомни как cashActual)\n' +
    'ЛИЧНАЯ КАРТА — были ли продажи через личную карту?\n' +
    'ИНКАССАЦИЯ — была ли инкассация сегодня? на какую сумму? (inkasso)\n' +
    'ЗАЛ — всё убрано, товар на местах?\n' +
    'ГОСТЕВАЯ — всё в порядке, убрано?\n' +
    'ГЕОЛОКАЦИЯ — "Пришли геолокацию через скрепку." После геолокации выдай SHIFT_CLOSE.\n' +
    'ЕСЛИ ПОСЛЕ ЗАКРЫТИЯ СИСТЕМА ПОКАЗАЛА РАСХОЖДЕНИЕ ПО КАНАЛУ (Kaspi/Halyk):\n' +
    '— если продавец говорит, что это из-за предоплаты (сегодня выкуп товара по предоплате): спроси «Какая предоплата? Назови имя клиента или ID» (можешь показать PREPAY_LIST:открытые). Когда назовут — выдай SHIFT_CLOSE заново с тем же набором цифр и добавь поле prepayApplied, напр.: "prepayApplied":[{"channel":"Kaspi","ref":"Жулдыз"}] (ref — имя клиента или ID предоплаты). Система сама привяжет предоплату и закроет смену.\n' +
    '— если причина другая: впиши её в notes и выдай SHIFT_CLOSE заново. Сама расхождения НЕ считай.\n' +
    '=> SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetOnlineKaspi":0,"rRetHalyk":0,"rRetHalykOnline":0,"rRetCash":0,"rRetPersonal":0,"rostaCheck":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}';
}

function getOwnerPrompt(ownerName, data) {
  const today = getDate();
  const now = getTime();
  const totalPrepay = data.openPrepays.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  return 'Ты — Томи, AI-партнер NANE PARIS. Ты — женщина.\n' +
    'Сегодня: ' + today + ', время: ' + now + '\nВладелец: ' + ownerName + '\n\n' +
    'ХАРАКТЕР: Партнер на равных. Прямо, честно, с цифрами. Никакого Markdown.\n\n' +
    'ДАННЫЕ:\nОткрытые предоплаты (' + data.openPrepays.length + ' шт, итого: ' + totalPrepay.toLocaleString() + ' тг):\n' +
    JSON.stringify(data.openPrepays.slice(0, 20)) + '\n\n' +
    'КОМАНДЫ:\n"Предоплаты" => PREPAY_LIST:открытые\n' +
    'Удалить предоплату => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента"}\n' +
    '"Дашборд" => DASHBOARD_HTML\n"Повторно вышли отчёт" => RESEND_REPORT\n"P&L" => PL_REPORT\n' +
    'Расход/трата с суммой => EXPENSE_NEW:{"amount":0,"description":""}\n' +
    '"Мои расходы" => EXPENSE_LIST:{"period":"month"}\n' +
    '"Продажи за май" => SALES_LIST:{"month":0,"year":0}\n' +
    '"Финансы за май" => FINANCE_REPORT:{"month":0,"year":0}\n' +
    '"Зарплата за май" => SALARY_CALC:{"month":0,"year":0}\n' +
    '"KPI Асель 3" => KPI_SET:{"seller":"Имя","score":0,"month":0,"year":0}\n' +
    '"Запусти обучение" => TRAINING_NOW\n"Запусти тест сейчас" => TRAINING_TEST_NOW\n"Отправь случайный вопрос" => RANDOM_QUESTION_NOW\n' +
    '"Останови обучение" => TRAINING_PAUSE\n' +
    '"Возобнови обучение" => TRAINING_RESUME\n' +
    '"Еженедельный отчёт" => WEEKLY_REPORT\n\n' +
    'По-русски. Прямо, с цифрами.';
}

// Сброс дня: чистит БД и память по указанным продавцам (для тестов закрытия)
async function resetDayForSellers(ids, wipeSales, wipeAllShifts) {
  const today = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
  const dateKey = today.split('.').reverse().join('-'); // ГГГГ-ММ-ДД
  let count = 0;
  for (const id of ids) {
    const sid = String(id);
    try { await supabase.from('open_shifts').delete().eq('phone', sid); } catch(e) {}
    try { await supabase.from('conversations').delete().eq('phone', sid); } catch(e) {}
    try { await supabase.from('last_reports').delete().eq('user_id', sid); } catch(e) {}
    delete shiftOCR[sid]; delete shiftPhotos[sid]; delete pendingGeoAction[sid]; delete pendingClose[sid];
    delete lastShiftReports[sid]; delete conversations[sid]; delete openShifts[sid];
    count++;
  }
  if (wipeAllShifts) {
    // сносим ВСЕ открытые смены, включая осиротевшие (от удалённых тест-аккаунтов/заблокированных закрытий)
    try { await supabase.from('open_shifts').delete().neq('phone', ''); } catch(e) {}
    for (const k of Object.keys(openShifts)) delete openShifts[k];
    for (const k of Object.keys(shiftOCR)) delete shiftOCR[k];
    for (const k of Object.keys(shiftPhotos)) delete shiftPhotos[k];
    for (const k of Object.keys(pendingGeoAction)) delete pendingGeoAction[k];
    for (const k of Object.keys(pendingClose)) delete pendingClose[k];
  }
  if (wipeSales) { try { await supabase.from('daily_sales').delete().eq('sale_date', dateKey); } catch(e) {} }
  delete firstCloseDone[today];
  console.log('resetDayForSellers:', JSON.stringify({ ids, wipeSales, wipeAllShifts, dateKey, count }));
  return { dateKey, count };
}

async function handleSystemCommands(reply, userId, sellerName, messageText) {
  let cleanReply = reply;

  // ── Команда владельца: СБРОС ДНЯ (с подтверждением) ──
  if (OWNER_IDS.includes(String(userId)) && messageText) {
    const cmd = messageText.toLowerCase().trim();
    if (pendingDayReset[String(userId)]) {
      if (cmd === 'да' || cmd === 'yes') {
        const tgt = pendingDayReset[String(userId)];
        delete pendingDayReset[String(userId)];
        const r = await resetDayForSellers(tgt.ids, tgt.wipeSales, tgt.wipeAllShifts);
        await sendTelegram(userId, '✅ Сброс выполнен.\nПродавцов очищено: ' + r.count + (tgt.wipeSales ? '\nПродажи дня ' + r.dateKey + ' удалены.' : '') + '\nОткрытые смены, история и фото обнулены. Можно открывать смену заново.');
        return '';
      } else if (cmd === 'нет' || cmd === 'no') {
        delete pendingDayReset[String(userId)];
        await sendTelegram(userId, '❌ Сброс отменён.');
        return '';
      }
    }
    if (cmd === 'сброс' || cmd === 'сброс дня' || cmd === 'сброс смены' || cmd.startsWith('сброс ')) {
      const sellerIds = Object.keys(ALLOWED_MAP).filter(id => !OWNER_IDS.includes(id));
      let ids = sellerIds, label = 'ВСЕХ продавцов', wipeSales = true;
      const isAll = (cmd === 'сброс' || cmd === 'сброс дня' || cmd === 'сброс смены');
      if (!isAll) {
        const arg = cmd.replace(/^сброс\s+/, '').trim();
        const match = sellerIds.filter(id => String(id) === arg || (ALLOWED_MAP[id] || '').toLowerCase() === arg);
        if (match.length) { ids = match; label = ALLOWED_MAP[match[0]] + ' (id ' + match[0] + ')'; }
        else { await sendTelegram(userId, '❌ Не нашла продавца «' + arg + '».\nДоступные: ' + (sellerIds.map(id => ALLOWED_MAP[id]).join(', ') || 'нет') + '.\nИли напиши «СБРОС ДНЯ» — сбросить всех.'); return ''; }
      }
      if (ids.length === 0) { await sendTelegram(userId, '❌ Нет продавцов для сброса.'); return ''; }
      pendingDayReset[String(userId)] = { ids, wipeSales, wipeAllShifts: isAll };
      const today = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
      await sendTelegram(userId, '⚠️ СБРОС за ' + today + ' для: ' + label + '\n\nУдалю НЕОБРАТИМО:\n• ' + (isAll ? 'ВСЕ открытые смены (вкл. осиротевшие)' : 'открытую смену') + '\n• историю чатов и распознанные фото\n• сохранённые отчёты' + (wipeSales ? '\n• продажи дня ' + today : '') + '\n\nОтветь ДА — сбросить, НЕТ — отмена.');
      return '';
    }
  }


  if (reply.includes('REMINDER_SAVE:')) {
    try {
      const jsonStr = reply.match(/REMINDER_SAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) { const r = JSON.parse(jsonStr); await saveReminder(userId, r.text, r.remind_at); }
    } catch(e) {}
    cleanReply = reply.replace(/REMINDER_SAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PL_REPORT')) {
    cleanReply = reply.replace(/PL_REPORT/g, '').trim();
    await sendTelegram(userId, '📊 P&L временно недоступен. Используй команду "Финансы".');
    if (!cleanReply) return '';
  }

  if (reply.includes('RESEND_REPORT')) {
    cleanReply = reply.replace(/RESEND_REPORT/g, '').trim();
    const report = lastShiftReports[String(userId)];
    if (!report) {
      await sendTelegram(userId, '📋 Отчёт закрытия не найден.');
    } else {
      for (const ownerId of OWNER_IDS) {
        pendingResendApprovals[String(ownerId)] = { sellerId: String(userId), sellerName: ALLOWED_MAP[String(userId)] || 'Продавец' };
        await sendTelegram(ownerId, '📋 ' + (ALLOWED_MAP[String(userId)]||'Продавец') + ' запрашивает повторную отправку отчёта.\n\nОтветь ДА или НЕТ.');
      }
      await sendTelegram(userId, '⏳ Запрос отправлен руководителю.');
    }
    if (!cleanReply) return '';
  }

  if (OWNER_IDS.includes(String(userId)) && pendingExpense[String(userId)]) {
    const choice = (messageText || '').trim();
    if (choice === '1' || choice === '2') {
      const exp = pendingExpense[String(userId)];
      delete pendingExpense[String(userId)];
      const isNane = choice === '1';
      const category = detectCategory(exp.description);
      try {
        await dbSaveExpense(exp.date, category, exp.amount, exp.description, !isNane, userId);
        await sendTelegram(userId, '✅ Записано в ' + (isNane ? 'NANE PARIS' : 'личные расходы') + '\n📁 ' + category + '\n💸 ' + Number(exp.amount).toLocaleString('ru-RU') + ' тг — ' + exp.description);
      } catch(e) {}
      return '';
    }
  }

  if (OWNER_IDS.includes(String(userId)) && pendingPrepayDelete[String(userId)]) {
    const msgLower2 = (messageText||'').toLowerCase().trim();
    if (msgLower2 === 'да' || msgLower2 === 'yes') {
      const { sellerId, prepayId } = pendingPrepayDelete[String(userId)];
      delete pendingPrepayDelete[String(userId)];
      try {
        const { error } = await supabase.from('prepayments').delete().ilike('prep_id', prepayId);
        if (!error) {
          await sendTelegram(userId, '✅ Предоплата удалена.');
          await sendTelegram(sellerId, '✅ Руководитель подтвердил — предоплата удалена.');
        } else { await sendTelegram(userId, '❌ Ошибка: ' + error.message); }
      } catch(e) {}
      return '';
    } else if (msgLower2 === 'нет' || msgLower2 === 'no') {
      const { sellerId } = pendingPrepayDelete[String(userId)];
      delete pendingPrepayDelete[String(userId)];
      await sendTelegram(sellerId, '❌ Руководитель отказал в удалении.');
      await sendTelegram(userId, '❌ Удаление отменено.');
      return '';
    }
  }

  if (OWNER_IDS.includes(String(userId)) && pendingResendApprovals[String(userId)]) {
    const msgLower = (messageText||'').toLowerCase().trim();
    if (msgLower === 'да' || msgLower === 'yes') {
      const { sellerId, sellerName: sName } = pendingResendApprovals[String(userId)];
      delete pendingResendApprovals[String(userId)];
      let report = lastShiftReports[sellerId];
      if (!report) report = await loadLastReport(sellerId);
      if (report) {
        await sendTelegramDocument(sellerId, report.filename, report.html, report.caption);
        await sendTelegram(userId, '✅ Отчёт повторно отправлен ' + sName + '.');
      }
      return '';
    } else if (msgLower === 'нет' || msgLower === 'no') {
      const { sellerId } = pendingResendApprovals[String(userId)];
      delete pendingResendApprovals[String(userId)];
      await sendTelegram(sellerId, '❌ Руководитель не разрешил повторную отправку.');
      await sendTelegram(userId, '❌ Отказано.');
      return '';
    }
  }

  if (reply.includes('DASHBOARD_HTML')) {
    cleanReply = reply.replace(/DASHBOARD_HTML/g, '').trim();
    const html = await generateDashboardHTML();
    if (html) {
      const filename = 'dashboard_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
      await sendTelegramDocument(userId, filename, html, '📊 Дашборд NANÉ PARIS — открой в браузере');
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('PREPAY_LIST:')) {
    const type = reply.includes('PREPAY_LIST:закрытые') ? 'closed' : 'open';
    cleanReply = reply.replace(/PREPAY_LIST:\S+/g, '').trim();
    const list = await loadPrepays(type);
    if (list.length === 0) {
      await sendTelegram(userId, type === 'open' ? '📋 Открытых предоплат нет.' : '📋 Закрытых предоплат нет.');
    } else {
      const totalDebt = list.filter(p => !p.status.includes('закрыт')).reduce((s,p) => s + (p.balance||0), 0);
      const header = (type === 'open' ? '📋 Открытые предоплаты: ' + list.length + ' шт' : '📋 Закрытые: ' + list.length + ' шт') +
        (totalDebt > 0 ? '\n💰 Общий долг: ' + Number(totalDebt).toLocaleString() + ' тг' : '') + '\n\n';
      for (let i = 0; i < list.length; i += 8) {
        let msg = i === 0 ? header : '📋 ...продолжение:\n\n';
        list.slice(i, i + 8).forEach((p, num) => {
          const isClosed = p.status.includes('закрыт');
          msg += (isClosed ? '✅' : '🟡') + ' №' + (i + num + 1) + '\n👤 ' + p.client + '\n';
          if (p.id) msg += '🆔 ' + p.id + ' · ' + p.date + '\n';
          if (p.items && p.items.length) msg += '👗 ' + p.items.join(', ') + '\n';
          msg += '\n💰 Аванс: ' + Number(p.amount).toLocaleString() + ' тг\n';
          if (p.balance > 0) msg += '⚠️ Долг: ' + Number(p.balance).toLocaleString() + ' тг\n';
          msg += '💳 ' + p.channel + '\n─────────────────────\n';
        });
        await sendTelegram(userId, msg);
      }
      const htmlContent = generatePrepaysHTML(list, type);
      const filename = (type === 'open' ? 'prepays_open' : 'prepays_closed') + '_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
      await sendTelegramDocument(userId, filename, htmlContent, '📋 Предоплаты — открой в браузере');
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
        const id = await dbGetNextPrepayId();
        await dbSavePrepay(id, p.date||today, p.client||'', phone.length>4?phone:'', p.item||'', p.channel||'', p.amount||0, p.balance||0, '🟡 Открыта', p.notes||sellerName, sellerName);
      }
    } catch(e) {}
    cleanReply = reply.replace(/PREPAY_SAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PREPAY_CLOSE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const rows = await dbGetPrepays('all');
        const searchStr = String(p.id||'').trim().toLowerCase();
        let found = null;
        // Ищем по ID или по имени клиента
        for (const row of rows) {
          const matchId = String(row.prep_id||'').trim().toUpperCase() === searchStr.toUpperCase();
          const matchName = String(row.client_name||'').trim().toLowerCase().includes(searchStr);
          if (matchId || matchName) { found = row; break; }
        }
        if (found) {
          await supabase.from('prepayments').update({ status: '🟢 Закрыта', notes: p.notes||'Товар выдан' }).eq('prep_id', found.prep_id);
          await sendTelegram(userId, '✅ Предоплата закрыта\n👤 ' + found.client_name + '\n🆔 ' + found.prep_id + '\n💰 ' + Number(found.amount||0).toLocaleString('ru-RU') + ' тг');
        } else {
          await sendTelegram(userId, '❌ Предоплата не найдена: ' + p.id + '\nПроверь ID или имя клиента.');
        }
      }
    } catch(e) { console.error('PREPAY_CLOSE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_CLOSE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PREPAY_DELETE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_DELETE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const findPrepayRow = async (searchStr) => {
          const rows = await dbGetPrepays('all');
          const search = String(searchStr).trim().toLowerCase();
          for (const row of rows) {
            if (String(row.prep_id||'').trim().toUpperCase() === search.toUpperCase() || String(row.client_name||'').trim().toLowerCase().includes(search)) {
              return { id: row.prep_id, client: row.client_name, supabaseId: row.id };
            }
          }
          return null;
        };
        if (OWNER_IDS.includes(String(userId))) {
          const found = await findPrepayRow(p.id);
          if (found) { await supabase.from('prepayments').delete().eq('id', found.supabaseId); }
          else { await sendTelegram(userId, '❌ Предоплата не найдена: ' + p.id); }
        } else {
          const found = await findPrepayRow(p.id);
          if (!found) {
            await sendTelegram(userId, '❌ Предоплата не найдена: ' + p.id);
          } else {
            for (const ownerId of OWNER_IDS) {
              pendingPrepayDelete[String(ownerId)] = { sellerId: String(userId), sellerName, prepayId: found.id, reason: p.reason||'' };
              await sendTelegram(ownerId, '🗑 Запрос на удаление\n\n👤 ' + sellerName + '\n🆔 ' + found.id + ' — ' + found.client + (p.reason?'\n📝 '+p.reason:'') + '\n\nОтветь ДА или НЕТ.');
            }
            await sendTelegram(userId, '⏳ Запрос на удаление отправлен руководителю.');
          }
        }
      }
    } catch(e) { console.error('PREPAY_DELETE error:', e.message); }
    cleanReply = reply.replace(/PREPAY_DELETE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SHIFT_OPEN:')) {
    try {
      const jsonStr = (extractTagJSON(reply, 'SHIFT_OPEN')||{}).json;
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        const lastCash = await loadLastCash();
        const cashOpen = parseFloat(s.cashOpen) || 0;
        if (lastCash !== null && lastCash > 0 && Math.abs(cashOpen - lastCash) > 500) {
          const cashDiff = cashOpen - lastCash;
          const direction = cashDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
          const sign = cashDiff > 0 ? '+' : '';
          for (const ownerId of OWNER_IDS) {
            await sendTelegram(ownerId, '🚨 РАСХОЖДЕНИЕ КАССЫ при открытии!\n👤 ' + s.seller + '\n💰 Закрыли: ' + Number(lastCash).toLocaleString() + ' тг\n💰 Открыли: ' + Number(cashOpen).toLocaleString() + ' тг\n❌ ' + direction + ': ' + sign + Number(cashDiff).toLocaleString() + ' тг');
          }
        }
        const shiftData = { seller: s.seller, shop: s.shop, cash_open: s.cashOpen, start_time: new Date().toISOString() };
        openShifts[String(userId)] = shiftData;
        await saveOpenShift(userId, shiftData);
        clearChecklistTimer(userId);
        const timeStr = getTime();
        const hour = parseInt(timeStr.split(':')[0]);
        const min = parseInt(timeStr.split(':')[1]);
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId, '🟢 Смена открыта\n👤 ' + s.seller + '\n🕐 ' + timeStr + '\n💰 Касса: ' + Number(s.cashOpen||0).toLocaleString('ru-RU') + ' тг');
        }
        if (hour > 11 || (hour === 11 && min > 0)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + s.seller + '\n🕐 ' + timeStr);
        }
        if ((s.cashOpen||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ — касса\nНаличных: ' + Number(s.cashOpen).toLocaleString() + ' тг');
        }
      }
    } catch(e) { console.error('SHIFT_OPEN error:', e.message); }
    cleanReply = reply.replace(/SHIFT_OPEN:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SHIFT_CLOSE:')) {
    try {
      const jsonStr = (extractTagJSON(reply, 'SHIFT_CLOSE')||{}).json;
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        // ═══════════════════════════════════════════════════════════════
        // ИСТОЧНИК ИСТИНЫ — структурный OCR, а НЕ цифры из чата.
        // Чат-модель теряет цифры за время чек-листа → берём прямо из OCR.
        // ═══════════════════════════════════════════════════════════════
        if (!shiftOCR[String(userId)] || !shiftOCR[String(userId)].zreport) rebuildShiftOCR(String(userId));
        const ocr = shiftOCR[String(userId)] || {};
        if (ocr.zreport) {
          const z = ocr.zreport;
          const pick = (a, b) => (a !== undefined && a !== null) ? Number(a) : (Number(b) || 0);
          s.rKaspi        = pick(z.kaspi_qr,        s.rKaspi);
          s.rOnline       = pick(z.online_kaspi,    s.rOnline);
          s.rHalyk        = pick(z.halyk_qr,        s.rHalyk);
          s.rHalykOnline  = pick(z.online_halyk,    s.rHalykOnline);
          s.rCash         = pick(z.cash,            s.rCash);
          s.rPersonal     = pick(z.personal,        s.rPersonal);
          s.rBonus        = pick(z.bonus,           s.rBonus);
          s.rRetKaspi       = pick(z.ret_kaspi_qr,    s.rRetKaspi);
          s.rRetOnlineKaspi = pick(z.ret_online_kaspi, s.rRetOnlineKaspi);
          s.rRetHalyk       = pick(z.ret_halyk_qr,    s.rRetHalyk);
          s.rRetHalykOnline = pick(z.ret_online_halyk, s.rRetHalykOnline);
          s.rRetCash        = pick(z.ret_cash,        s.rRetCash);
          s.rRetPersonal    = pick(z.ret_personal,    s.rRetPersonal);
          // rostaCheck = сумма по видам − все возвраты (контрольная сумма из самого Z-отчёта)
          s.rostaCheck = (s.rKaspi+s.rOnline+s.rHalyk+s.rHalykOnline+s.rCash+s.rPersonal+s.rBonus)
            - (s.rRetKaspi+s.rRetOnlineKaspi+s.rRetHalyk+s.rRetHalykOnline+s.rRetCash+s.rRetPersonal);
        }
        if (ocr.kaspi) { s.tKaspi = Number(ocr.kaspi.gross)||0; s.tKaspiRet = Number(ocr.kaspi.returns)||0; }
        if (ocr.halyk) { s.tHalyk = Number(ocr.halyk.gross)||0; s.tHalykRet = Number(ocr.halyk.returns)||0; }
        // ВАЛИДАЦИЯ: если Z-отчёт не распознан (нет ни одного канала продаж) — не строим кривой отчёт
        if (ocr.zreport) {
          const channelsSum = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0);
          if (channelsSum <= 0) {
            await sendTelegram(userId, '⚠️ Z-отчёт распознан некорректно (нулевые продажи по всем каналам). Перешли фото Z-отчёта чётче — без бликов, весь блок «Отчёт по видам оплат» в кадре.');
            cleanReply = stripTag(reply, 'SHIFT_CLOSE');
            { const _ck = String(userId); if (conversations[_ck] && conversations[_ck].length) conversations[_ck][conversations[_ck].length-1].content = '[Смена НЕ закрыта — расхождение/ошибка, требуется объяснение причины]'; return ''; }
          }
          // Контрольная сумма: распознанные виды оплат должны сойтись с печатным "Итого:"
          const itogo = Number(ocr.zreport.itogo) || 0;
          if (itogo > 0 && Math.abs(s.rostaCheck - itogo) > 1000) {
            await sendTelegram(userId, '⚠️ Z-отчёт распознан с ошибкой: сумма по видам оплат (' + s.rostaCheck.toLocaleString('ru-RU') + ' ₸) не сходится с «Итого» в чеке (' + itogo.toLocaleString('ru-RU') + ' ₸). Перешли фото Z-отчёта чётче.');
            for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ ' + (sellerName) + ': Z-отчёт не сошёлся при распознавании (' + s.rostaCheck.toLocaleString('ru-RU') + ' ≠ ' + itogo.toLocaleString('ru-RU') + '). Смена не закрыта.');
            cleanReply = stripTag(reply, 'SHIFT_CLOSE');
            { const _ck = String(userId); if (conversations[_ck] && conversations[_ck].length) conversations[_ck][conversations[_ck].length-1].content = '[Смена НЕ закрыта — расхождение/ошибка, требуется объяснение причины]'; return ''; }
          }
        }
        const shift = openShifts[String(userId)] || await loadOpenShift(userId) || {};
        // Защита от повторного/«призрачного» закрытия: если открытой смены нет — не закрываем (иначе считается по нулям)
        if (!openShifts[String(userId)] && !shift.seller && !shift.start_time) {
          delete pendingClose[String(userId)];
          await sendTelegram(userId, 'Смена уже закрыта или ещё не открыта. Чтобы начать новую — напиши «Начала смену».');
          return stripTag(reply, 'SHIFT_CLOSE');
        }
        // ИСТОЧНИК ИСТИНЫ по кассе открытия — сохранённая смена (введено на ШАГ 2 открытия), а не память чат-модели
        if (shift && shift.cash_open != null) s.cashOpen = Number(shift.cash_open) || 0;
        const today = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
        const closeTime = getTime();
        // Все 6 типов возвратов из Z-отчёта
        const rostaTotal = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0)-(s.rRetKaspi||0)-(s.rRetOnlineKaspi||0)-(s.rRetHalyk||0)-(s.rRetHalykOnline||0)-(s.rRetCash||0)-(s.rRetPersonal||0);
        const rostaCheck = s.rostaCheck || 0;
        let finalRevenue = rostaTotal;
        if (rostaCheck > 0 && Math.abs(rostaCheck - rostaTotal) > 1000) { finalRevenue = rostaCheck; }
        // Защита от нулевой выручки
        if (finalRevenue <= 0 && rostaCheck <= 0) { finalRevenue = 0; console.warn('SHIFT_CLOSE: finalRevenue=0, проверь данные'); }
        const kaspiNet = (s.tKaspi||0)-(s.tKaspiRet||0);
        const halykNet = (s.tHalyk||0)-(s.tHalykRet||0);
        // Продажи наличными: ГРОСС (строка «Наличные» из Z-отчёта) — для физической кассы и показа продавцу
        const cashSalesGross = (s.rCash||0);
        // NET (за вычетом возвратов наличными) — для сверки выручки план/факт
        const cashSales = (s.rCash||0) - (s.rRetCash||0);

        // ФИЗИЧЕСКАЯ КАССА: ожидаемая наличность = открытие + продажи наличными − инкассация − выплаты из кассы
        // (возвраты наличными НЕ вычитаем — по правилу учёта NANE: «начало смены + продажи»)
        const cashExpected = (s.cashOpen||0) + cashSalesGross - (s.inkasso||0) - (s.cashPayouts||0);
        const cashActualVal = s.cashActual || 0;
        const cashBoxDiff = cashActualVal - cashExpected;
        if (Math.abs(cashBoxDiff) > 500) {
          const sign = cashBoxDiff > 0 ? '+' : '';
          const dir = cashBoxDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
          const payoutStr = (s.cashPayouts||0) > 0 ? ' − выплаты ' + Number(s.cashPayouts||0).toLocaleString() : '';
          for (const ownerId of OWNER_IDS) {
            await sendTelegram(ownerId, '💰 РАСХОЖДЕНИЕ КАССЫ при закрытии!\n👤 ' + (shift.seller||sellerName) + '\n💰 Ожидалось: ' + Number(cashExpected).toLocaleString('ru-RU') + ' тг\n   (открытие ' + Number(s.cashOpen||0).toLocaleString() + ' + продажи наличными ' + Number(cashSalesGross).toLocaleString() + ' − инкассация ' + Number(s.inkasso||0).toLocaleString() + payoutStr + ')\n💰 Факт в кассе: ' + Number(cashActualVal).toLocaleString('ru-RU') + ' тг\n❌ ' + dir + ': ' + sign + Number(cashBoxDiff).toLocaleString('ru-RU') + ' тг');
          }
          await sendTelegram(userId, '⚠️ Расхождение кассы: ' + dir + ' ' + sign + Number(cashBoxDiff).toLocaleString('ru-RU') + ' тг\nОжидалось: ' + Number(cashExpected).toLocaleString('ru-RU') + ' тг (открытие ' + Number(s.cashOpen||0).toLocaleString() + ' + наличные продажи ' + Number(cashSalesGross).toLocaleString() + ')\nФакт: ' + Number(cashActualVal).toLocaleString('ru-RU') + ' тг');
        }
        const factTotal = kaspiNet + halykNet + cashSales + (s.rPersonal||0) + (s.rBonus||0);
        const diff = factTotal - rostaTotal;
        const totalRet = (s.rRetKaspi||0)+(s.rRetOnlineKaspi||0)+(s.rRetHalyk||0)+(s.rRetHalykOnline||0)+(s.rRetCash||0)+(s.rRetPersonal||0);
        const channelDiffs = [];
        // Сравниваем ЧИСТЫЕ суммы (после возвратов с обеих сторон)
        // Это правильно: и ROSTA и терминал могут иметь разные суммы возвратов
        const kaspiFactNet = (s.tKaspi||0) - (s.tKaspiRet||0);   // терминал чистые
        const kaspiROSTANet = (s.rKaspi||0) + (s.rOnline||0) - (s.rRetKaspi||0) - (s.rRetOnlineKaspi||0); // ROSTA чистые
        const halykFactNet = (s.tHalyk||0) - (s.tHalykRet||0);   // терминал чистые
        const halykROSTANet = (s.rHalyk||0) + (s.rHalykOnline||0) - (s.rRetHalyk||0) - (s.rRetHalykOnline||0); // ROSTA чистые
        const kaspiDiff = kaspiFactNet - kaspiROSTANet;
        const halykDiff = halykFactNet - halykROSTANet;
        if (Math.abs(kaspiDiff) > 500) channelDiffs.push({ channel: 'Kaspi', diff: kaspiDiff });
        if (Math.abs(halykDiff) > 500) channelDiffs.push({ channel: 'Halyk', diff: halykDiff });
        // Наличные НЕ сверяем как «канал терминала»: для них нет терминала, проверка — физический пересчёт кассы (cashBoxDiff выше)
        const allPrepaysRaw = await dbGetPrepays('all');
        // Учитываем ВСЕ предоплаты — и закрытые и открытые
        // Открытая предоплата тоже может объяснить расхождение (товар выдан сегодня)
        const todayClosedPrepays = allPrepaysRaw
          .map(p => ({ id: String(p.prep_id||''), client: String(p.client_name||''), amount: Number(p.amount||0), channel: String(p.channel||''), status: String(p.status||'') }));
        const prepayExplanations = [];
        const explainedDiffs = new Set();
        const chMatchFor = (channel) => (p => (channel === 'Kaspi' && (p.channel.toLowerCase().includes('kaspi')||p.channel.toLowerCase().includes('каспи'))) ||
                (channel === 'Halyk' && (p.channel.toLowerCase().includes('halyk')||p.channel.toLowerCase().includes('халык'))) ||
                (channel === 'Наличные' && (p.channel.toLowerCase().includes('нал')||p.channel.toLowerCase().includes('cash'))));
        // АВТО-сопоставление: предоплата объясняет расхождение в ОБЕ стороны (излишек ИЛИ недостача)
        channelDiffs.forEach(cd => {
          const TOL = 1000; // допуск сходимости по сумме
          const channelPrepays = todayClosedPrepays.filter(chMatchFor(cd.channel));
          const single = channelPrepays.filter(p => Math.abs(p.amount - Math.abs(cd.diff)) < TOL);
          const sumCh = channelPrepays.reduce((acc, p) => acc + p.amount, 0);
          const sumClose = Math.abs(sumCh - Math.abs(cd.diff)) < TOL;
          const byAmountAnyChannel = todayClosedPrepays.filter(p => Math.abs(p.amount - Math.abs(cd.diff)) < TOL);
          let matching = [];
          if (single.length > 0) matching = single;
          else if (sumClose && channelPrepays.length > 0) matching = channelPrepays;
          else if (byAmountAnyChannel.length > 0) matching = byAmountAnyChannel;
          if (matching.length > 0) { prepayExplanations.push({ channel: cd.channel, diff: cd.diff, prepays: matching }); explainedDiffs.add(cd.channel); }
        });
        // РУЧНОЕ применение: продавец назвал предоплату (ID или имя), которой объясняется расхождение по каналу.
        // Доверяем владельцу/продавцу: сумма может не совпадать в точности (аванс частичный) — фиксируем как объяснение.
        const applied = Array.isArray(s.prepayApplied) ? s.prepayApplied : [];
        applied.forEach(ap => {
          const ref = String(ap.ref || ap.id || ap.client || '').trim().toLowerCase();
          if (!ref) return;
          const found = todayClosedPrepays.find(p => p.id.toLowerCase() === ref || (p.client && p.client.toLowerCase().includes(ref)));
          if (!found) return;
          // канал: явно указан в ap.channel, иначе берём из самой предоплаты
          let ch = ap.channel || '';
          if (!ch) { const lc = found.channel.toLowerCase(); ch = (lc.includes('kaspi')||lc.includes('каспи'))?'Kaspi':(lc.includes('halyk')||lc.includes('халык'))?'Halyk':(lc.includes('нал')||lc.includes('cash'))?'Наличные':''; }
          // привязываем к расхождению этого канала (если оно есть), иначе к любому необъяснённому
          let target = channelDiffs.find(cd => cd.channel === ch && !explainedDiffs.has(cd.channel));
          if (!target) target = channelDiffs.find(cd => !explainedDiffs.has(cd.channel));
          if (target) {
            prepayExplanations.push({ channel: target.channel, diff: target.diff, prepays: [found], manual: true });
            explainedDiffs.add(target.channel);
          }
        });
        const unexplainedDiffs = channelDiffs.filter(cd => !explainedDiffs.has(cd.channel));
        const hasNotes = s.notes && s.notes.trim().length > 10;
        const cashProblem = Math.abs(cashBoxDiff) > 500;
        if ((unexplainedDiffs.length > 0 || cashProblem) && !hasNotes) {
          let blockMsg = '🚫 СМЕНА НЕ ЗАКРЫТА — расхождения!\n\n';
          if (cashProblem) {
            const csign = cashBoxDiff > 0 ? '+' : '';
            const cdir = cashBoxDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            blockMsg += '💵 КАССА: ' + cdir + ' ' + csign + Number(cashBoxDiff).toLocaleString('ru-RU') + ' тг\n';
            blockMsg += '   ожидалось ' + Number(cashExpected).toLocaleString('ru-RU') + ' (открытие ' + Number(s.cashOpen||0).toLocaleString('ru-RU') + ' + наличные продажи ' + Number(cashSalesGross).toLocaleString('ru-RU') + '), ты указал ' + Number(cashActualVal).toLocaleString('ru-RU') + '\n';
            blockMsg += '   ⮕ пересчитай кассу и пришли точную сумму одним числом.\n\n';
          }
          unexplainedDiffs.forEach(cd => {
            const sign = cd.diff > 0 ? '+' : '';
            const dir = cd.diff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            blockMsg += '❌ ' + cd.channel + ': ' + dir + ' ' + sign + Number(cd.diff).toLocaleString('ru-RU') + ' тг\n';
            if (cd.channel === 'Kaspi') {
              const rostaK = (s.rKaspi||0)+(s.rOnline||0)-(s.rRetKaspi||0)-(s.rRetOnlineKaspi||0);
              blockMsg += '   ROSTA ' + rostaK.toLocaleString('ru-RU') + ' (QR ' + (s.rKaspi||0).toLocaleString('ru-RU') + ' + онлайн ' + (s.rOnline||0).toLocaleString('ru-RU') + ((s.rRetKaspi||0)+(s.rRetOnlineKaspi||0)>0?' − возвраты '+((s.rRetKaspi||0)+(s.rRetOnlineKaspi||0)).toLocaleString('ru-RU'):'') + ') vs терминал ' + ((s.tKaspi||0)-(s.tKaspiRet||0)).toLocaleString('ru-RU') + '\n';
            } else if (cd.channel === 'Halyk') {
              const rostaH = (s.rHalyk||0)+(s.rHalykOnline||0)-(s.rRetHalyk||0)-(s.rRetHalykOnline||0);
              blockMsg += '   ROSTA ' + rostaH.toLocaleString('ru-RU') + ' (QR ' + (s.rHalyk||0).toLocaleString('ru-RU') + ' + онлайн ' + (s.rHalykOnline||0).toLocaleString('ru-RU') + ') vs терминал ' + ((s.tHalyk||0)-(s.tHalykRet||0)).toLocaleString('ru-RU') + '\n';
            }
          });
          if (unexplainedDiffs.length > 0) blockMsg += '\nПо терминалу: если из-за предоплаты — напиши «предоплата <имя клиента или ID>». Если другая причина — напиши её одной фразой, закрою с пометкой для руководителя.';
          else blockMsg += 'Если касса верна и расхождение объяснимо — напиши причину одной фразой, закрою с пометкой.';
          await sendTelegram(userId, blockMsg);
          // Владельцу — полный HTML-отчёт для контроля, даже если смена не закрыта
          const sellerForBlock = s.shiftStatus === 'second_close' ? (s.seller2 || sellerName) : (shift.seller || sellerName);
          try {
            const htmlBlock = generateShiftHTML({ sellerName: sellerForBlock, date: today, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs, prepayExplanations });
            const fnBlock = 'otchet_NE_ZAKRYTA_' + today.replace(/\./g,'_') + '_' + sellerForBlock + '.html';
            for (const ownerId of OWNER_IDS) {
              await sendTelegram(ownerId, '⚠️ Расхождение при закрытии — смена НЕ закрыта!\n👤 ' + sellerForBlock + '\nПродавец должен объяснить причину. Полный отчёт с аналитикой ниже 👇');
              await sendTelegramDocument(ownerId, fnBlock, htmlBlock, '📊 Отчёт (СМЕНА НЕ ЗАКРЫТА) — ' + sellerForBlock + ' · ' + today + ' · ' + closeTime);
            }
          } catch(e) {
            console.error('block report error:', e.message);
            for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Расхождение при закрытии!\n👤 ' + sellerForBlock);
          }
          cleanReply = stripTag(reply, 'SHIFT_CLOSE');
          pendingClose[String(userId)] = s; // запоминаем закрытие — продавец назовёт предоплату/причину и код достроит закрытие
          { const _ck = String(userId); if (conversations[_ck] && conversations[_ck].length) conversations[_ck][conversations[_ck].length-1].content = '[Смена НЕ закрыта — расхождение/ошибка, требуется объяснение причины]'; return ''; }
        }
        delete pendingClose[String(userId)]; // закрытие прошло — снимаем отложенное состояние
        // Записываем что первое закрытие состоялось — следующий будет вторым
        const todayKeyClose = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
        // Закрытие НЕ заблокировано (есть заметка/предоплата), но если расхождение по терминалу осталось необъяснённым предоплатой — не прячем, шлём владельцу
        if (unexplainedDiffs.length > 0) {
          for (const ownerId of OWNER_IDS) {
            let warn = '⚠️ Смена закрыта С РАСХОЖДЕНИЕМ\n👤 ' + (shift.seller||sellerName) + '\n';
            unexplainedDiffs.forEach(cd => { const sg = cd.diff>0?'+':''; const dr = cd.diff>0?'излишек':'недостача'; warn += '• ' + cd.channel + ': ' + dr + ' ' + sg + Number(cd.diff).toLocaleString('ru-RU') + ' тг\n'; });
            if (hasNotes) warn += '📝 Причина (со слов продавца): ' + s.notes;
            await sendTelegram(ownerId, warn);
          }
        }
        if (s.shiftStatus !== 'second_close') {
          firstCloseDone[todayKeyClose] = true;
        }
        const sellerFinal = s.shiftStatus === 'second_close' ? (s.seller2 || sellerName) : (shift.seller || sellerName);
        if (s.shiftStatus === 'second_close' && s.seller2) {
          const dateKey = today.split('.').reverse().join('-');
          await supabase.from('daily_sales').update({ seller2: s.seller2 }).eq('sale_date', dateKey);
        } else {
          await dbSaveSale(today, finalRevenue, sellerFinal, '');
        }
        if ((s.cashActual||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ ИНКАССАЦИИ\nНаличных: ' + Number(s.cashActual).toLocaleString() + ' тг');
        }
        const htmlReport = generateShiftHTML({ sellerName: sellerFinal, date: today, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs, prepayExplanations });
        const filename = 'otchet_' + today.replace(/\./g,'_') + '_' + sellerFinal + '.html';
        lastShiftReports[String(userId)] = { html: htmlReport, filename, caption: '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime };
        await saveLastReport(userId, htmlReport, filename, '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime);
        for (const ownerId of OWNER_IDS) {
          await sendTelegramDocument(ownerId, filename, htmlReport, '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime);
          // Пересылаем фото по порядку
          let photos = shiftPhotos[String(userId)] || {};
          // Для second_close — не требуем фото (усечённый чек-лист)
          if (s.shiftStatus === 'second_close' && Object.keys(photos).length === 0) {
            for (const [pid, pdata] of Object.entries(shiftPhotos)) {
              if (pid !== String(userId) && pdata && (pdata.zreport || pdata.kaspi || pdata.halyk)) {
                photos = pdata; break;
              }
            }
          }
          if (photos.zreport || photos.kaspi || photos.halyk) {
            await sendTelegram(ownerId, '📸 Фото смены — ' + sellerFinal + ' · ' + today);
            if (photos.zreport) await forwardPhoto(ownerId, photos.zreport, '📄 Z-отчёт ROSTA');
            if (photos.kaspi)   await forwardPhoto(ownerId, photos.kaspi,   '💳 Терминал Kaspi');
            if (photos.halyk)   await forwardPhoto(ownerId, photos.halyk,   '💳 Терминал Halyk');
            if (photos.extra)   await forwardPhoto(ownerId, photos.extra,   '📸 Доп. фото');
          } else {
            console.log('Фото не найдены. shiftPhotos:', JSON.stringify(shiftPhotos));
          }
        }
        delete shiftPhotos[String(userId)];
        delete shiftOCR[String(userId)];
        delete pendingClose[String(userId)];
        for (const [sellerId] of Object.entries(ALLOWED_MAP)) {
          if (!OWNER_IDS.includes(sellerId)) {
            await sendTelegramDocument(sellerId, 'den_' + today.replace(/\./g,'_') + '.html', htmlReport, '📊 Итоги дня ' + today);
          }
        }
        // Чёткое подтверждение продавцу (+ какая предоплата привязана)
        const prepInfo = prepayExplanations.length ? ('\n📌 Расхождение по ' + prepayExplanations.map(e => e.channel).join(', ') + ' отнесено к предоплате: ' + prepayExplanations.map(e => e.prepays.map(p => p.client + (p.amount ? ' (' + Number(p.amount).toLocaleString('ru-RU') + ' ₸)' : '')).join(', ')).join('; ')) : '';
        const noteInfo = (s.notes && s.notes.trim().length > 10) ? ('\n📝 Причина: ' + s.notes.trim()) : '';
        await sendTelegram(userId, '✅ Смена закрыта.' + prepInfo + noteInfo + '\nОтчёт отправлен. Хорошей работы!');
        delete openShifts[String(userId)];
        await deleteOpenShift(userId);
        if (s.shiftStatus === 'second_close') {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🔴 Смена закрыта (второй продавец)\n👤 ' + sellerFinal + '\n🕐 ' + closeTime);
        }
      }
    } catch(e) { console.error('SHIFT_CLOSE error:', e.message); }
    cleanReply = stripTag(reply, 'SHIFT_CLOSE');
  }

  if (reply.includes('CASH_ALERT:')) {
    try {
      const jsonStr = reply.match(/CASH_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) { const a = JSON.parse(jsonStr); for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ\nНаличных: ' + Number(a.amount).toLocaleString() + ' тг\n👤 ' + sellerName + '\n🕐 ' + getTime()); }
    } catch(e) {}
    cleanReply = reply.replace(/CASH_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('LATE_ALERT:')) {
    try {
      const jsonStr = reply.match(/LATE_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
        await dbSaveDiscipline(today, a.seller, 'Опоздание', a.time||getTime(), 'Открытие позже 11:00');
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + a.seller + '\n🕐 ' + (a.time||getTime()));
      }
    } catch(e) {}
    cleanReply = reply.replace(/LATE_ALERT:\{[^}]*\}/gs, '').replace(/LATE_ALERT:/g, '').trim();
  }

  if (reply.includes('SECOND_ARRIVE:')) {
    try {
      const jsonStr = reply.match(/SECOND_ARRIVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '✅ Второй продавец на месте\n👤 ' + a.seller + '\n🕐 ' + (a.time||getTime()));
      }
    } catch(e) {}
    cleanReply = reply.replace(/SECOND_ARRIVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('EXPENSE_NEW:')) {
    try {
      const jsonStr = reply.match(/EXPENSE_NEW:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const e = JSON.parse(jsonStr);
        const expDate = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
        pendingExpense[String(userId)] = { amount: e.amount, description: e.description, date: expDate };
        await sendTelegram(userId, '💸 Расход: ' + e.description + ' — ' + Number(e.amount).toLocaleString('ru-RU') + ' тг\n\nКуда записать?\n\n1. NANE PARIS\n2. Личный');
      }
    } catch(e2) {}
    cleanReply = reply.replace(/EXPENSE_NEW:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('EXPENSE_LIST:')) {
    try {
      const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      await showExpensesByMonth(userId, nowAlm.getMonth()+1, nowAlm.getFullYear(), 'month');
    } catch(e2) {}
    cleanReply = reply.replace(/EXPENSE_LIST:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('SALARY_CALC:')) {
    try {
      const jsonStr = reply.match(/SALARY_CALC:(\{.*?\})/s)?.[1];
      let month = new Date().getMonth()+1, year = new Date().getFullYear();
      if (jsonStr) { const p = JSON.parse(jsonStr); if (p.month) month=p.month; if (p.year) year=p.year; }
      await showSalaryReport(userId, month, year);
    } catch(e2) {}
    cleanReply = reply.replace(/SALARY_CALC:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('SALES_LIST:')) {
    try {
      const jsonStr = reply.match(/SALES_LIST:(\{.*?\})/s)?.[1];
      let month = new Date().getMonth()+1, year = new Date().getFullYear();
      if (jsonStr) { const p = JSON.parse(jsonStr); if (p.month) month=p.month; if (p.year) year=p.year; }
      const sales = await dbGetSales(month, year);
      const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      if (!sales || sales.length === 0) {
        await sendTelegram(userId, '📈 Продаж за ' + (monthNames[month]||month) + ' ' + year + ' нет.');
      } else {
        let total = 0, best = { revenue: 0, date: '' };
        let msg = '📈 Продажи — ' + (monthNames[month]||month) + ' ' + year + '\n\n';
        sales.forEach(s => {
          const d = s.sale_date ? s.sale_date.slice(8,10)+'.'+s.sale_date.slice(5,7) : '?';
          const sellers = [s.seller1, s.seller2].filter(Boolean).join('+');
          msg += d + ': ' + Number(s.revenue).toLocaleString('ru-RU') + ' тг' + (sellers?' · '+sellers:'') + '\n';
          total += Number(s.revenue);
          if (Number(s.revenue) > best.revenue) best = { revenue: Number(s.revenue), date: d };
        });
        msg += '\n📊 Итого: ' + total.toLocaleString('ru-RU') + ' тг';
        if (best.date) msg += '\n🏆 Лучший: ' + best.date + ' — ' + best.revenue.toLocaleString('ru-RU') + ' тг';
        await sendTelegram(userId, msg);
      }
    } catch(e2) {}
    cleanReply = reply.replace(/SALES_LIST:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_NOW')) {
    cleanReply = reply.replace(/TRAINING_NOW/g, '').trim();
    await sendWeeklyTraining(true);
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_TEST_NOW')) {
    cleanReply = reply.replace(/TRAINING_TEST_NOW/g, '').trim();
    // Запустить тест немедленно
    const sellers = Object.entries(ALLOWED_MAP).filter(([id]) => !OWNER_IDS.includes(id));
    let weekNum = 1;
    try {
      const { data } = await supabase.from('training_progress').select('week').order('week', { ascending: false }).limit(1);
      if (data && data.length > 0) weekNum = Math.min(data[0].week, NANE_LESSONS.length);
    } catch(e) {}
    const lesson = NANE_LESSONS[weekNum - 1];
    if (lesson) {
      for (const [sellerId] of sellers) {
        delete pendingTestAnswer[sellerId];
        await sendTelegram(sellerId, '🎯 ТЕСТ — Неделя ' + weekNum + '\n📖 ' + lesson.topic + '\n\nОтвечай развёрнуто, своими словами.\nПорог: 80% · Результат влияет на KPI.');
        await new Promise(r => setTimeout(r, 500));
        pendingTestAnswer[sellerId] = { weekNum, questionIndex: 0, answers: [] };
        await sendTelegram(sellerId, '🔸 Вопрос 1 из ' + lesson.questions.length + ':\n\n' + lesson.questions[0].q);
        await new Promise(r => setTimeout(r, 1000));
      }
      await sendTelegram(userId, '✅ Тест отправлен продавцам');
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('RANDOM_QUESTION_NOW')) {
    cleanReply = reply.replace(/RANDOM_QUESTION_NOW/g, '').trim();
    await sendRandomTrainingQuestion();
    await sendTelegram(userId, '✅ Случайный вопрос отправлен продавцам');
    if (!cleanReply) return '';
  }

  if (reply.includes('FINANCE_REPORT:')) {
    try {
      const jsonStr = reply.match(/FINANCE_REPORT:(\{.*?\})/s)?.[1];
      let month = new Date().getMonth()+1, year = new Date().getFullYear();
      if (jsonStr) { const p = JSON.parse(jsonStr); if (p.month) month=p.month; if (p.year) year=p.year; }
      await showFinanceReport(userId, month, year);
    } catch(e) {}
    cleanReply = reply.replace(/FINANCE_REPORT:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_PAUSE')) {
    trainingPaused = true;
    cleanReply = reply.replace(/TRAINING_PAUSE/g, '').trim();
    await sendTelegram(userId, '⏸ Обучение поставлено на паузу.');
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_RESUME')) {
    trainingPaused = false;
    cleanReply = reply.replace(/TRAINING_RESUME/g, '').trim();
    await sendTelegram(userId, '▶️ Обучение возобновлено.');
    if (!cleanReply) return '';
  }

  if (reply.includes('LESSON_CONFIRMED')) {
    try {
      const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
      await dbSaveDiscipline(today, sellerName, 'Урок изучен', getTime(), '✅ Выполнено в срок');
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '✅ ' + sellerName + ' подтвердила изучение урока · ' + getTime());
    } catch(e) {}
    cleanReply = reply.replace(/LESSON_CONFIRMED/g, '').trim();
  }

  if (reply.includes('TRAINING_RESULT:')) {
    try {
      const jsonStr = reply.match(/TRAINING_RESULT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const t = JSON.parse(jsonStr);
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
        const score = parseInt(t.score) || 0;
        const emoji = score >= 3 ? '✅' : score >= 2 ? '⚠️' : '❌';
        await dbSaveDiscipline(today, t.seller||sellerName, 'Обучение: '+(t.topic||''), getTime(), 'Результат: '+score+'/3 '+emoji);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '📚 Обучение завершено\n👤 '+(t.seller||sellerName)+'\n📖 '+(t.topic||'')+'\n🎯 '+score+'/3 '+emoji);
      }
    } catch(e) {}
    cleanReply = reply.replace(/TRAINING_RESULT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('EXPENSE_DELETE:')) {
    try {
      const deleted = await deleteLastExpense(userId);
      if (deleted) await sendTelegram(userId, '🗑 Удалена запись:\n'+(deleted[0]||'')+' · '+Number(deleted[2]||0).toLocaleString()+' тг');
      else await sendTelegram(userId, '❌ Нет записей для удаления.');
    } catch(e) {}
    cleanReply = reply.replace(/EXPENSE_DELETE:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('INKASSO_CHECK:')) {
    try {
      const jsonStr = reply.match(/INKASSO_CHECK:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const inkDiff = Math.abs((parseFloat(a.sellerAmount)||0)-(parseFloat(a.ownerAmount)||0));
        if (inkDiff > 500) { for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🚨 РАСХОЖДЕНИЕ ИНКАССАЦИИ!\nРасхождение: '+Number(inkDiff).toLocaleString()+' тг'); }
      }
    } catch(e) {}
    cleanReply = reply.replace(/INKASSO_CHECK:\{.*?\}/s, '').trim();
  }

  if (reply.includes('TERMINAL_ALERT:')) {
    try {
      const jsonStr = reply.match(/TERMINAL_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) { const a = JSON.parse(jsonStr); for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Терминал не работает\n👤 '+a.seller+'\n💳 '+a.terminal+'\n📝 '+a.reason); }
    } catch(e) {}
    cleanReply = reply.replace(/TERMINAL_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SECOND_LEAVE:')) {
    try {
      const jsonStr = reply.match(/SECOND_LEAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) { const a = JSON.parse(jsonStr); for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '👋 Второй продавец ушёл\n👤 '+a.seller+'\n🕐 '+(a.time||getTime())); }
    } catch(e) {}
    cleanReply = reply.replace(/SECOND_LEAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('KPI_SET:')) {
    try {
      const jsonStr = reply.match(/KPI_SET:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
        const month = p.month || nowA.getMonth()+1;
        const year = p.year || nowA.getFullYear();
        const score = parseInt(p.score);
        if (p.seller && score >= 0 && score <= 3) {
          await saveKPI(p.seller, score, month, year);
          await sendTelegram(userId, '✅ KPI выставлен\n👤 ' + p.seller + '\n⭐ ' + score + '/3\n💰 ' + (score*25000).toLocaleString('ru-RU') + ' тг');
        }
      }
    } catch(e) { console.error('KPI_SET error:', e.message); }
    cleanReply = reply.replace(/KPI_SET:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('WEEKLY_REPORT')) {
    cleanReply = reply.replace(/WEEKLY_REPORT/g, '').trim();
    await sendWeeklySalesReport();
    if (!cleanReply) return '';
  }

  return cleanReply;
}

async function deleteLastExpense(userId) {
  try {
    const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const rowsRaw = await dbGetExpenses(nowAlm.getMonth()+1, nowAlm.getFullYear(), false, userId);
    if (!rowsRaw || rowsRaw.length === 0) return null;
    const last = rowsRaw[rowsRaw.length - 1];
    await supabase.from('expenses').delete().eq('id', last.id);
    return [last.expense_date, last.category, last.amount, last.description];
  } catch(e) { return null; }
}

async function sendWeeklySalesReport() {
  try {
    const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const month = nowA.getMonth()+1, year = nowA.getFullYear();
    const sales = await dbGetSales(month, year);
    if (!sales || sales.length === 0) return;
    const weekAgo = new Date(nowA); weekAgo.setDate(nowA.getDate()-7);
    const weekSales = sales.filter(s => new Date(s.sale_date) >= weekAgo && new Date(s.sale_date).getFullYear() === year);
    const weekTotal = weekSales.reduce((sum,s) => sum+Number(s.revenue||0), 0);
    const avgDay = weekSales.length > 0 ? Math.round(weekTotal/weekSales.length) : 0;
    const monthTotal = sales.reduce((sum,s) => sum+Number(s.revenue||0), 0);
    const plan = PLAN_TOTAL;
    const pct = Math.round(monthTotal/plan*100);
    const remains = Math.max(0, plan-monthTotal);
    const daysLeft = new Date(year,month,0).getDate()-nowA.getDate();
    const dailyNeed = daysLeft > 0 ? Math.round(remains/daysLeft) : 0;
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    let msg = '📊 Еженедельный отчёт — '+monthNames[month]+'\n\n';
    msg += '📅 За неделю: '+weekTotal.toLocaleString('ru-RU')+' тг ('+weekSales.length+' дней)\n';
    msg += '📈 Средний день: '+avgDay.toLocaleString('ru-RU')+' тг\n\n';
    msg += '🎯 ПЛАН МЕСЯЦА\n';
    msg += '✅ Выполнено: '+monthTotal.toLocaleString('ru-RU')+' тг ('+pct+'%)\n';
    msg += '🎯 Осталось: '+remains.toLocaleString('ru-RU')+' тг\n';
    msg += '📅 Дней осталось: '+daysLeft+'\n';
    msg += '📌 Нужно в день: '+dailyNeed.toLocaleString('ru-RU')+' тг';
    for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, msg);
  } catch(e) { console.error('sendWeeklySalesReport error:', e.message); }
}

// Обёртка: сообщения одного userId обрабатываются строго по очереди (без гонок за общим состоянием)
function handleMessage(userId, messageText, photoFileId) {
  const key = String(userId);
  const prev = userLocks[key] || Promise.resolve();
  const run = prev.catch(() => {}).then(() => _handleMessageInner(userId, messageText, photoFileId));
  userLocks[key] = run.catch(() => {});
  return run;
}

async function _handleMessageInner(userId, messageText, photoFileId) {
  const senderName = ALLOWED_MAP[String(userId)];
  if (!senderName) { await sendTelegram(userId, '🔒 Доступ закрыт.'); return; }
  const isOwner = OWNER_IDS.includes(String(userId));
  const userKey = String(userId);

  // KPI команды
  if (isOwner && messageText) {
    const msgLK = messageText.toLowerCase().trim();
    const kpiMatch = msgLK.match(/kpi\s+(асель|зарина|луиза)\s+(\d)/i) || msgLK.match(/(асель|зарина|луиза).*kpi.*(\d)/i);
    if (kpiMatch) {
      const sellerRaw = kpiMatch[1];
      const score = parseInt(kpiMatch[2]);
      const sellerName = sellerRaw.charAt(0).toUpperCase() + sellerRaw.slice(1).toLowerCase();
      const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      if (score >= 0 && score <= 3) {
        await saveKPI(sellerName, score, nowA.getMonth()+1, nowA.getFullYear());
        await sendTelegram(userId, '✅ KPI выставлен\n👤 ' + sellerName + '\n⭐ ' + score + '/3\n💰 ' + (score*25000).toLocaleString('ru-RU') + ' тг');
        return;
      }
    }
  }

  // Приветствие владельца — показываем меню
  if (isOwner && messageText) {
    const msgLG = messageText.toLowerCase().trim();
    if (/^привет$|^здравствуй|^салем|^хай$|^hi$|^hello$|^добрый|^доброе/.test(msgLG)) {
      const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      const m = nowA.getMonth()+1;
      const mName = monthNames[m].toLowerCase();
      await sendTelegram(userId,
        '👋 Привет, Ермек!\n\n' +
        '📊 ОТЧЁТЫ\n• Продажи за ' + mName + '\n• Финансы за ' + mName + '\n• Дисциплина\n• Отчёт за ' + mName + '\n• Дашборд\n\n' +
        '💰 ФИНАНСЫ\n• Прибыль ' + nowA.toLocaleDateString('ru-RU') + ' 734798\n• Расходы\n• Потратил 5000 такси\n\n' +
        '👥 ПРОДАВЦЫ\n• KPI Асель 3\n• Зарплата за ' + mName + '\n\n' +
        '📋 ПРЕДОПЛАТЫ\n• Предоплаты\n• Новая предоплата'
      );
      return;
    }
  }

  // Дисциплина
  if (isOwner && messageText) {
    const msgLD = messageText.toLowerCase().trim();
    if (/дисциплин|опоздан|нарушен/.test(msgLD)) {
      const monthNamesD = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let dMonth = null;
      for (const [name, num] of Object.entries(monthNamesD)) { if (msgLD.includes(name)) { dMonth = num; break; } }
      const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      if (!dMonth) dMonth = nowA.getMonth()+1;
      const { data: discRows } = await supabase.from('discipline').select('*').order('event_date', { ascending: false });
      const rows = (discRows||[]).filter(r => { if (!r.event_date) return false; const d = new Date(r.event_date); return d.getMonth()+1 === dMonth && d.getFullYear() === nowA.getFullYear(); });
      const monthNames2 = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      if (rows.length === 0) { await sendTelegram(userId, '✅ Нарушений за ' + (monthNames2[dMonth]||dMonth) + ' нет.'); }
      else {
        let msg = '📋 Дисциплина — ' + (monthNames2[dMonth]||dMonth) + '\n━━━━━━━━━━━━━━━━━━━━\n\n';
        rows.forEach(r => { msg += '📅 ' + (r.event_date||'') + ' · ' + (r.seller_name||'') + '\n⚠️ ' + (r.event_type||'') + ' — ' + (r.event_time||'') + '\n' + (r.note?'📝 '+r.note+'\n':'') + '\n'; });
        msg += 'Итого: ' + rows.length;
        await sendTelegram(userId, msg);
      }
      return;
    }
  }

  // Полный отчёт
  if (isOwner && messageText) {
    const msgLO = messageText.toLowerCase().trim();
    if (/^отчёт|^отчет|полный отчёт|полный отчет/.test(msgLO)) {
      const monthNamesO = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let repMonth = new Date().getMonth()+1, repYear = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesO)) { if (msgLO.includes(name)) { repMonth = num; break; } }
      await sendTelegram(userId, '⏳ Формирую отчёт за ' + repMonth + '.' + repYear + '...');
      try {
        await generateFullReport(userId, repMonth, repYear);
      } catch(e) {
        console.error('generateFullReport CALL ERROR:', e.message, e.stack);
        await sendTelegram(userId, '❌ Ошибка отчёта: ' + e.message);
      }
      return;
    }
  }

  // Финансовый отчёт
  if (isOwner && messageText) {
    const msgLF = messageText.toLowerCase().trim();
    if (/^финанс|финансовый/.test(msgLF)) {
      const monthNamesF = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let finMonth = new Date().getMonth()+1, finYear = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesF)) { if (msgLF.includes(name)) { finMonth = num; break; } }
      await showFinanceReport(userId, finMonth, finYear);
      return;
    }
  }

  // Прибыль ROSTA
  if (isOwner && messageText) {
    const msgLR = messageText.toLowerCase().trim();
    if (/^прибыль/.test(msgLR)) {
      const monthNamesP = {январ:1,феврал:2,март:3,апрел:4,май:5,мая:5,июн:6,июль:7,июля:7,август:8,сентябр:9,октябр:10,ноябр:11,декабр:12};
      let profitDate, profitAmount;
      const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      const cleanP = msgLR.replace('прибыль', '').trim();
      const ddmmyyyy = cleanP.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      const ddmm = cleanP.match(/(\d{1,2})\.(\d{2})\b/);
      if (ddmmyyyy) { profitDate = ddmmyyyy[3]+'-'+ddmmyyyy[2]+'-'+ddmmyyyy[1]; }
      else if (ddmm) { profitDate = nowA.getFullYear()+'-'+ddmm[2].padStart(2,'0')+'-'+ddmm[1].padStart(2,'0'); }
      else {
        const parts = cleanP.split(/\s+/);
        const nums = parts.filter(p => /^\d+$/.test(p));
        const words = parts.filter(p => !/^\d+$/.test(p));
        if (words.includes('сегодня') || nums.length === 1) { profitDate = nowA.toISOString().split('T')[0]; }
        else if (nums.length >= 2) {
          const day = parseInt(nums[0]); let month = nowA.getMonth()+1;
          for (const [name, num] of Object.entries(monthNamesP)) { if (words.some(w => w.startsWith(name))) { month = num; break; } }
          profitDate = nowA.getFullYear()+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
        }
      }
      const withoutDate = cleanP.replace(/\d{1,2}[.\s]\d{2}[.\s]?\d{0,4}/g,' ').trim();
      const amountMatch = withoutDate.replace(/\s/g,'').match(/\d{4,}/g);
      profitAmount = amountMatch ? parseInt(amountMatch[amountMatch.length-1]) : 0;
      if (profitDate && profitAmount > 0) {
        const { error } = await supabase.from('daily_sales').update({ rosta_profit: profitAmount }).eq('sale_date', profitDate);
        if (!error) { await sendTelegram(userId, '✅ Прибыль записана\n📅 ' + profitDate + '\n💰 ' + profitAmount.toLocaleString('ru-RU') + ' тг'); }
        else {
          await supabase.from('daily_sales').upsert({ sale_date: profitDate, revenue: 0, rosta_profit: profitAmount, month: parseInt(profitDate.split('-')[1]), year: parseInt(profitDate.split('-')[0]) }, { onConflict: 'sale_date' });
          await sendTelegram(userId, '✅ Прибыль записана\n📅 ' + profitDate + '\n💰 ' + profitAmount.toLocaleString('ru-RU') + ' тг');
        }
        return;
      }
    }
  }

  // Зарплата
  if (isOwner && messageText) {
    const msgLZ = messageText.toLowerCase().trim();
    if (/зарплат|фот|расчёт зп|расчет зп/.test(msgLZ)) {
      const monthNamesZ = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let salMonth = new Date().getMonth()+1, salYear = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesZ)) { if (msgLZ.includes(name)) { salMonth = num; break; } }
      await showSalaryReport(userId, salMonth, salYear);
      return;
    }
  }

  // Продажи
  if (isOwner && messageText) {
    const msgLS = messageText.toLowerCase().trim();
    const monthNames2 = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
    if (/продаж|оборот|выручк/.test(msgLS)) {
      let month = new Date().getMonth()+1, year = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNames2)) { if (msgLS.includes(name)) { month = num; break; } }
      await handleSystemCommands('SALES_LIST:{"month":'+month+',"year":'+year+'}', userId, ALLOWED_MAP[String(userId)]||'Руководитель', messageText);
      return;
    }
  }

  // Расходы
  if (isOwner && messageText) {
    const msgL = messageText.toLowerCase().trim();
    if (/расход|затрат/.test(msgL) && !/внести|добавить|записать|потратил|трата|прибыль/.test(msgL)) {
      const monthNamesExp = {май:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let expMonth = new Date().getMonth()+1, expYear = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesExp)) { if (msgL.includes(name)) { expMonth = num; break; } }
      await showExpensesByMonth(userId, expMonth, expYear, 'month');
      return;
    }
  }

  // Предоплаты для продавцов (но НЕ когда закрытие ждёт объяснения — тогда обрабатывает перехват ниже)
  if (!isOwner && messageText && !pendingClose[userKey]) {
    const msgLP = messageText.toLowerCase().trim();
    if (/предоплат|prepay/.test(msgLP) && !/новая|создать|добавить|внести/.test(msgLP)) {
      const list = await loadPrepays('open');
      if (list.length === 0) { await sendTelegram(userId, '📋 Открытых предоплат нет.'); }
      else {
        let msg = '📋 Открытые предоплаты: ' + list.length + '\n\n';
        list.forEach((p, i) => { msg += '🟡 №'+(i+1)+' '+p.client+'\n'+(p.id?'🆔 '+p.id+'\n':'')+(p.items&&p.items.length?'👗 '+p.items.join(', ')+'\n':'')+'💰 Аванс: '+Number(p.amount).toLocaleString('ru-RU')+' тг\n\n'; });
        await sendTelegram(userId, msg);
        const htmlContent = generatePrepaysHTML(list, 'open');
        const filename = 'prepays_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
        await sendTelegramDocument(userId, filename, htmlContent, '📋 Предоплаты — открой в браузере');
      }
      return;
    }
  }

  // Перехватываем ответы на тест обучения
  if (!isOwner && messageText && pendingTestAnswer[String(userId)]) {
    const handled = await handleTrainingTestAnswer(userId, messageText);
    if (handled) return;
  }

  if (!conversations[userKey]) conversations[userKey] = await loadConversation(userId);
  conversations[userKey] = sanitizeMessages(conversations[userKey]);
  if (!openShifts[userKey]) { const dbShift = await loadOpenShift(userId); if (dbShift) openShifts[userKey] = dbShift; }

  // Проверка устаревшей смены
  if (openShifts[userKey] && openShifts[userKey].start_time) {
    const shiftDate = new Date(openShifts[userKey].start_time);
    const todayStr = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
    const shiftDateStr = shiftDate.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
    if (shiftDateStr !== todayStr) {
      delete openShifts[userKey];
      await deleteOpenShift(userId);
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Смена ' + senderName + ' от ' + shiftDateStr + ' не была закрыта! Автоматически сброшена.');
    }
  }

  const hasOpenShift = !!openShifts[userKey];
  const isSecondSellerFromShift = !!(openShifts[userKey] && openShifts[userKey].is_second);

  let isSecondSeller = isSecondSellerFromShift;
  let firstSellerName = '';
  if (!isOwner && !hasOpenShift) {
    const _today = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'});
    const _isToday = st => st && new Date(st).toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'}) === _today;
    for (const [otherId, shiftData] of Object.entries(openShifts)) {
      if (otherId !== userKey && shiftData && shiftData.seller && _isToday(shiftData.start_time)) { isSecondSeller = true; firstSellerName = shiftData.seller; break; }
    }
    if (!isSecondSeller) {
      try {
        const { data: allShifts } = await supabase.from('open_shifts').select('*').neq('phone', userKey);
        const todays = (allShifts || []).filter(sh => _isToday(sh.start_time));
        if (todays.length > 0) { isSecondSeller = true; firstSellerName = todays[0].seller || ''; }
      } catch(e) {}
    }
  }

  // ── Детерминированное завершение закрытия после расхождения ──
  // Если закрытие ждёт объяснения (pendingClose) и пришёл текст — код сам достраивает SHIFT_CLOSE,
  // НЕ полагаясь на то, что модель выдаст большой тег (она часто вместо этого просто «рассказывает»).
  if (pendingClose[userKey] && messageText && !photoFileId) {
    const text = messageText.trim();
    const lc = text.toLowerCase();
    const isQuestion = /\?\s*$/.test(text) || /^(дальше|что дальше|а что|как|почему|зачем|когда|куда)\b/i.test(lc);
    let prepayRef = null;
    try {
      const prepays = await dbGetPrepays('all');
      const m = (prepays || []).find(p => {
        const id = String(p.prep_id||'').toLowerCase();
        const cl = String(p.client_name||'').toLowerCase();
        return (id && lc.includes(id)) || (cl && cl.length > 2 && lc.includes(cl));
      });
      if (m) prepayRef = String(m.prep_id || m.client_name);
    } catch(e) {}
    // Пересчёт кассы: продавец прислал сумму (число), возможно с «наличные/касса». Это НЕ причина — это поправка cashActual.
    const digitsM = text.replace(/[\s\u00a0]/g, '').match(/\d{4,}/);
    const cashKeyword = /налич|касс|\bнал\b/i.test(lc);
    const residual = lc.replace(/[\d\s\u00a0.,]/g, '').replace(/налич\w*|касс\w*|тенге|тг|штук/gi, '').trim();
    const isCashEntry = !prepayRef && digitsM && (cashKeyword || residual.length <= 3);
    const mentionsPrepay = /предоплат|выкуп|аванс/i.test(lc);
    if (prepayRef || isCashEntry || (!mentionsPrepay && !isQuestion && text.length >= 6)) {
      const s2 = Object.assign({}, pendingClose[userKey]);
      if (prepayRef) s2.prepayApplied = [{ ref: prepayRef }];
      else if (isCashEntry) { s2.cashActual = Number(digitsM[0]); } // пересчёт кассы — без пометки, просто перепроверяем
      else s2.notes = ((s2.notes ? s2.notes + '; ' : '') + text);
      conversations[userKey] = conversations[userKey] || [];
      conversations[userKey].push({ role: 'user', content: messageText });
      const syntheticClose = 'SHIFT_CLOSE:' + JSON.stringify(s2);
      const cr = await handleSystemCommands(syntheticClose, userId, senderName, messageText);
      conversations[userKey].push({ role: 'assistant', content: cr && cr.trim() ? cr : 'Принято.' });
      if (conversations[userKey].length > 40) conversations[userKey] = conversations[userKey].slice(-40);
      if (cr && cr.trim()) await sendTelegram(userId, cr);
      return;
    }
    if (mentionsPrepay && !prepayRef) {
      // показываем список открытых предоплат, чтобы продавец выбрал (он не обязан помнить все)
      let ask;
      try {
        const list = await loadPrepays('open');
        if (!list.length) ask = 'Открытых предоплат нет. Если расхождение по другой причине — напиши её одной фразой, закрою с пометкой для руководителя.';
        else {
          ask = '📋 Открытые предоплаты (' + list.length + ').\nНапиши имя клиента или ID, чтобы привязать к расхождению:\n\n';
          list.forEach(p => { ask += '🟡 ' + p.client + (p.id ? ' — ' + p.id : '') + (p.amount ? ' · ' + Number(p.amount).toLocaleString('ru-RU') + ' ₸' : '') + '\n'; });
        }
      } catch(e) { ask = 'Напиши имя клиента или ID предоплаты (например: «Жулдыз» или «PREP-0106»).'; }
      conversations[userKey] = conversations[userKey] || [];
      conversations[userKey].push({ role: 'user', content: messageText });
      conversations[userKey].push({ role: 'assistant', content: ask });
      await sendTelegram(userId, ask);
      return;
    }
    // иначе (вопрос / слишком короткое) — пусть модель ответит и подскажет, что писать
  }

  let userContent;
  if (photoFileId) {
    try {
      await sendTelegram(userId, '📷 Читаю фото...');

      // Если продавец с открытой сменой присылает фото — это фото для закрытия
      if (!isOwner && hasOpenShift && !pendingGeoAction[userId]) {
        pendingGeoAction[userId] = 'close_shift';
      }

      // ══════════════════════════════════════════════════════════════
      // ИСПРАВЛЕНО: определяем тип ДО сохранения, потом сохраняем
      // ══════════════════════════════════════════════════════════════
      // Тип фото определяется ПО СОДЕРЖИМОМУ (надёжнее порядка прихода).
      const base64 = await downloadTelegramFile(photoFileId);
      const ocrResult = await readPhotoWithClaude(base64, 'auto');
      let photoType = 'unknown', isReshoot = false;
      try {
        const m = ocrResult.match(/\{[\s\S]*\}/);
        if (m) {
          if (!shiftOCR[userKey]) shiftOCR[userKey] = {};
          const parsed = JSON.parse(m[0]);
          const t = parsed.type;
          if (t === 'zreport') { photoType = 'zreport'; shiftOCR[userKey].zreport = parsed; }
          else if (t === 'kaspi_terminal') { photoType = 'kaspi_terminal'; shiftOCR[userKey].kaspi = parsed; }
          else if (t === 'halyk_terminal') { photoType = 'halyk_terminal'; shiftOCR[userKey].halyk = parsed; }
          if (photoType !== 'unknown') {
            const sp0 = shiftPhotos[userKey] || {};
            isReshoot = (photoType==='zreport'&&!!sp0.zreport)||(photoType==='kaspi_terminal'&&!!sp0.kaspi)||(photoType==='halyk_terminal'&&!!sp0.halyk);
            savePhotoByType(userId, photoType, photoFileId);
            await persistOCR(userId, photoType, parsed);
          }
          console.log('OCR тип по содержимому:', photoType, JSON.stringify(parsed));
        }
      } catch (e) { console.error('OCR parse error:', e.message, '| raw:', ocrResult); }
      // ── Пошаговый приём с подтверждением (детерминированно, без угадывания модели) ──
      const isClosing = !isOwner && (hasOpenShift || pendingGeoAction[userId] === 'close_shift');
      if (isClosing) {
        const LBL = { zreport:'Z-отчёт ROSTA', kaspi_terminal:'Kaspi терминал', halyk_terminal:'Halyk терминал' };
        const money = n => Number(n||0).toLocaleString('ru-RU') + ' \u20b8';
        if (photoType === 'unknown') {
          await sendTelegram(userId, '\u2753 Не пойму, что на фото. Это Z-отчёт ROSTA, Kaspi или Halyk терминал?\nПереснимите чётко: целиком, без бликов. Z-отчёт \u2014 со списком «Отчёт по видам оплат».');
          return;
        }
        const oc = shiftOCR[userKey] || {};
        let nums = '';
        if (photoType === 'zreport' && oc.zreport) {
          const d = oc.zreport;
          const sales = (d.kaspi_qr||0)+(d.online_kaspi||0)+(d.halyk_qr||0)+(d.online_halyk||0)+(d.cash||0)+(d.personal||0)+(d.bonus||0);
          const rets = (d.ret_kaspi_qr||0)+(d.ret_online_kaspi||0)+(d.ret_halyk_qr||0)+(d.ret_online_halyk||0)+(d.ret_cash||0)+(d.ret_personal||0);
          nums = 'продажи ' + money(sales) + ', возвраты ' + money(rets) + ', Итого ' + money(d.itogo || (sales-rets));
        } else {
          const d = photoType === 'kaspi_terminal' ? oc.kaspi : oc.halyk;
          if (d) nums = 'оплаты ' + money(d.gross) + ', возвраты ' + money(d.returns) + ', нетто ' + money(d.net != null ? d.net : (d.gross||0)-(d.returns||0));
        }
        const sp = shiftPhotos[userKey] || {};
        const have = [], miss = [];
        for (const [k, slot] of [['zreport','zreport'],['kaspi_terminal','kaspi'],['halyk_terminal','halyk']]) {
          (sp[slot] ? have : miss).push(LBL[k]);
        }
        let msg = (isReshoot ? '\ud83d\udd04 Обновила «' : '\u2705 Принято как «') + LBL[photoType] + '».\nРаспознала: ' + nums + '.\nЕсли цифры неверны \u2014 переснимите это фото.';
        msg += '\n\n\ud83d\udccb Собрано: ' + (have.length ? have.join(', ') : '\u2014');
        if (miss.length) {
          msg += '\n\u23f3 Жду: ' + miss.join(', ') + '.\nПришлите следующее фото.';
          await sendTelegram(userId, msg);
          conversations[userKey].push({ role:'user', content:'[Системно: принято фото «'+LBL[photoType]+'» ('+nums+'). Собрано: '+have.join(', ')+'. Жду: '+miss.join(', ')+'. НЕ проси уже принятые фото.]' });
          if (conversations[userKey].length > 40) conversations[userKey] = conversations[userKey].slice(-40);
          return;
        }
        const cashQ = 'Шаг — Наличные. Сколько наличных в кассе сейчас? Пересчитай и напиши сумму.';
        msg += '\n\n\u2705 Все 3 отчёта собраны. Перехожу к закрытию.\n\n' + cashQ;
        await sendTelegram(userId, msg);
        // Фиксируем в истории, что фото уже приняты и задан вопрос по кассе — чтобы модель НЕ переспрашивала фото
        conversations[userKey].push({ role: 'assistant', content: 'Все 3 отчёта (Z-отчёт, Kaspi, Halyk) приняты системой. ' + cashQ });
        if (conversations[userKey].length > 40) conversations[userKey] = conversations[userKey].slice(-40);
        return;
      } else {
        const contextText = photoType === 'zreport' ? 'Прочитала Z-отчет ROSTA:\n' + ocrResult
          : photoType === 'kaspi_terminal' ? 'Прочитала Kaspi терминал:\n' + ocrResult
          : photoType === 'halyk_terminal' ? 'Прочитала Halyk терминал:\n' + ocrResult
          : 'Прочитала фото:\n' + ocrResult;
        userContent = [{ type: 'text', text: messageText || 'Прочитай данные с фото.' }, { type: 'text', text: contextText }];
      }
    } catch(e) { userContent = messageText || 'Не удалось прочитать фото.'; }
  } else {
    userContent = messageText;
  }

  conversations[userKey].push({ role: 'user', content: userContent });
  if (conversations[userKey].length > 40) conversations[userKey] = conversations[userKey].slice(-40);

  try {
    let systemPrompt;
    if (isOwner) {
      const data = await loadOwnerData();
      systemPrompt = getOwnerPrompt(senderName, data);
    } else {
      // Второй продавец получает усечённый промпт ТОЛЬКО при утреннем приходе:
      // - нет своей смены (ещё не зарегистрирован) → isSecondSeller && !hasOpenShift
      // - ИЛИ смена только что создана с is_second=true и cash_open=0 (ещё не прошёл чек-лист)
      // При закрытии (cash_open > 0 или смена уже полноценная) — полный промпт
      const shiftData = openShifts[userKey];
      // isJustArrived: is_second И смена открыта менее 30 мин назад (ещё в процессе прихода)
      const shiftAge = shiftData && shiftData.start_time ? 
        (Date.now() - new Date(shiftData.start_time).getTime()) / 60000 : 999;
      const isJustArrived = shiftData && shiftData.is_second && !Number(shiftData.cash_open) && shiftAge < 30;
      // Проверяем — закрыл ли уже кто-то смену сегодня (второй закрывающий = усечённый)
      const todayKey2 = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
      const todayISO2 = todayKey2.split('.').reverse().join('-');
      let isSecondClosing = hasOpenShift && firstCloseDone[todayKey2] === true;
      // Дополнительно проверяем Supabase если память сбросилась после рестарта
      if (hasOpenShift && !isSecondClosing) {
        try {
          const { data: todaySale } = await supabase.from('daily_sales').select('seller1').eq('sale_date', todayISO2).maybeSingle();
          if (todaySale && todaySale.seller1) isSecondClosing = true;
        } catch(e) {}
      }
      const isSecondForPrompt = (!hasOpenShift && isSecondSeller) || isJustArrived || isSecondClosing;
      systemPrompt = getSellerPrompt(senderName, 'NANE PARIS Астана', hasOpenShift, isSecondForPrompt, firstSellerName);
    }
    let msgsForApi = sanitizeMessages(conversations[userKey]);
    if (msgsForApi.length === 0) msgsForApi = [{ role: 'user', content: messageText || 'Продолжай.' }];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      system: systemPrompt, messages: msgsForApi
    });
    const reply = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text.trim()).filter(t => t.length > 0).join('\n').trim();
    if (!reply) { await sendTelegram(userId, 'Произошла ошибка. Попробуй еще раз.'); return; }
    conversations[userKey].push({ role: 'assistant', content: reply });
    await saveMessages(userId, userContent, reply);
    const cleanReply = await handleSystemCommands(reply, userId, senderName, messageText);
    if (cleanReply && cleanReply.trim()) await sendTelegram(userId, cleanReply);
  } catch(e) {
    console.error('Claude error:', e.message, e.status || '', JSON.stringify(e.error || {}).slice(0, 300));
    await sendTelegram(userId, 'Произошла ошибка. Попробуй еще раз.');
    try { for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '\u26a0\ufe0f Диагностика Томи: ' + (e.message || 'неизвестно') + (e.status ? ' [' + e.status + ']' : '')); } catch(_) {}
  }
}

async function loadOwnerData() {
  const prepays_raw = await dbGetPrepays('open');
  const openPrepays = prepays_raw.map(p => ({ id: p.prep_id, date: p.prep_date, client: p.client_name, phone: p.phone, item: p.item, channel: p.channel, amount: p.amount, balance: p.balance }));
  return { openPrepays };
}

async function loadPrepays(type) {
  const rawData = await dbGetPrepays(type === 'open' ? 'open' : type === 'closed' ? 'closed' : 'all');
  const list = rawData.map(p => ({
    id: p.prep_id, date: p.prep_date ? String(p.prep_date) : '',
    client: p.client_name || '', phone: p.phone || '', channel: p.channel || '—',
    amount: Number(p.amount || 0), balance: Number(p.balance || 0),
    status: p.status || '🟡 Открыта', items: p.item ? [p.item] : [], notes: p.notes || ''
  }));
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  return list;
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const message = body.message || body.edited_message;
    if (!message) return;
    const userId = message.chat.id;
    const messageText = message.text || message.caption || '';
    const photoFileId = message.photo ? message.photo[message.photo.length - 1].file_id : null;
    const senderName = ALLOWED_MAP[String(userId)];

    if (message.location) {
      const lat = message.location.latitude;
      const lon = message.location.longitude;
      const distance = calcDistance(lat, lon, SHOP_LAT, SHOP_LON);
      if (distance > SHOP_RADIUS) {
        if (senderName) {
          await sendTelegram(userId, '❌ Геолокация не принята.\nТы в ' + distance + ' м от магазина.\nПодойди ближе и отправь снова.');
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Попытка не из магазина!\n👤 ' + senderName + '\n📍 ' + distance + ' м');
        }
        return;
      }
      let geoOtherShift = false;
      for (const [otherId, sd] of Object.entries(openShifts)) {
        if (otherId !== String(userId) && sd && sd.seller) { geoOtherShift = true; break; }
      }
      if (!geoOtherShift) {
        try {
          const { data: oth } = await supabase.from('open_shifts').select('*').neq('phone', String(userId));
          if (oth && oth.length > 0) geoOtherShift = true;
        } catch(e) {}
      }
      const ownShift = openShifts[String(userId)] || await loadOpenShift(userId);
      const isOwnerGeo = OWNER_IDS.includes(String(userId));
      let action;
      if (pendingGeoAction[userId]) {
        action = pendingGeoAction[userId];
      } else if (ownShift) {
        // Есть своя смена — всегда закрытие, игнорируем чужие смены
        action = 'close_shift';
      } else if (!isOwnerGeo && geoOtherShift) {
        // Нет своей смены, есть чужая, не владелец — приход второго продавца
        action = 'second_arrive';
      } else {
        action = 'open_shift';
      }
      delete pendingGeoAction[userId];
      if (action === 'second_arrive') {
        const sName = ALLOWED_MAP[String(userId)] || 'Продавец';
        const tStr = getTime();
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '✅ Второй продавец на месте\n👤 ' + sName + '\n🕐 ' + tStr);
        await sendTelegram(userId, '✅ Геолокация принята. Хорошей смены, ' + sName + '!');
      } else if (action === 'open_shift') {
        delete conversations[String(userId)];
        await handleMessage(userId, '📍 ' + distance + ' м от магазина. ок', null);
      } else {
        await handleMessage(userId, '📍 ' + distance + ' м от магазина. закрытие ок', null);
      }
      return;
    }

    if (messageText) {
      const lower = messageText.toLowerCase();
      // ДА/НЕТ от владельца на повторное открытие
      if (OWNER_IDS.includes(String(userId))) {
        for (const [sellerUserId, approval] of Object.entries(pendingReopenApprovals)) {
          if (approval.waitingForOwner) {
            if (lower === 'да' || lower === 'yes') {
              approval.waitingForOwner = false;
              delete openShifts[sellerUserId];
              await deleteOpenShift(sellerUserId);
              delete conversations[sellerUserId];
              await supabase.from('conversations').delete().eq('phone', String(sellerUserId));
              clearChecklistTimer(sellerUserId);
              delete pendingReopenApprovals[sellerUserId];
              await sendTelegram(sellerUserId, '✅ Руководитель разрешил повторное открытие.\nНапиши "Начала смену" чтобы начать.');
              await sendTelegram(userId, '✅ Разрешение выдано.');
              return;
            } else if (lower === 'нет' || lower === 'no') {
              delete pendingReopenApprovals[sellerUserId];
              await sendTelegram(sellerUserId, '❌ Руководитель не разрешил повторное открытие.');
              await sendTelegram(userId, '❌ Отказано.');
              return;
            }
          }
        }
      }

      if (lower.includes('начала смену') || lower.includes('открываю смену') || lower.includes('начинаю смену')) {
        if (pendingReopenApprovals[String(userId)] && pendingReopenApprovals[String(userId)].waitingForOwner) {
          await sendTelegram(userId, '⏳ Запрос уже отправлен. Ожидай ответа.');
          return;
        }
        let existingShift = openShifts[String(userId)];
        if (!existingShift) { const dbShift = await loadOpenShift(userId); if (dbShift) existingShift = dbShift; }
        // Проверка истории убрана — она не фильтрует по дате и вызывала ложные блоки
        if (existingShift) {
          const sellerNameLocal = ALLOWED_MAP[String(userId)] || 'Продавец';
          pendingReopenApprovals[String(userId)] = { sellerName: sellerNameLocal, waitingForOwner: true, timestamp: Date.now() };
          await sendTelegram(userId, '⚠️ Смена уже открыта. Повторное открытие требует разрешения руководителя. Ожидай.');
          for (const ownerId of OWNER_IDS) {
            await sendTelegram(ownerId, '🔐 ЗАПРОС ПОВТОРНОГО ОТКРЫТИЯ\n\n👤 ' + sellerNameLocal + '\n\nОтветь ДА или НЕТ.\n(Без ответа через 10 мин — отклонено)');
          }
          setTimeout(async () => {
            if (pendingReopenApprovals[String(userId)] && pendingReopenApprovals[String(userId)].waitingForOwner) {
              delete pendingReopenApprovals[String(userId)];
              await sendTelegram(userId, '⏰ Руководитель не ответил. Повторное открытие отклонено.');
            }
          }, 10 * 60 * 1000);
          return;
        }
        // Смены нет — открываем чисто
        delete conversations[String(userId)];
        try { await supabase.from('conversations').delete().eq('phone', String(userId)); } catch(e) {}
        // Сбрасываем фото предыдущей смены
        delete shiftPhotos[String(userId)];
        delete shiftOCR[String(userId)];
        pendingGeoAction[userId] = 'open_shift';
        const sellerName = ALLOWED_MAP[String(userId)] || 'Продавец';
        startChecklistTimer(userId, sellerName, getTime());
        let isSecondSellerCheck = false;
        const todayStrCheck = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'});
        for (const [otherId, shiftData] of Object.entries(openShifts)) {
          if (otherId !== String(userId) && shiftData && shiftData.seller) {
            // Проверяем что смена сегодняшняя
            const shiftDateStr = shiftData.start_time ? new Date(shiftData.start_time).toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'}) : '';
            if (shiftDateStr === todayStrCheck) { isSecondSellerCheck = true; break; }
          }
        }
        if (!isSecondSellerCheck) {
          try {
            const { data: otherShifts } = await supabase.from('open_shifts').select('*').neq('phone', String(userId));
            if (otherShifts && otherShifts.length > 0) {
              // Считаем только сегодняшние смены (не вчерашние/тестовые)
              const todayStr = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'});
              const todayShifts = otherShifts.filter(s => {
                if (!s.start_time) return false;
                const shiftDate = new Date(s.start_time).toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'});
                return shiftDate === todayStr;
              });
              if (todayShifts.length > 0) isSecondSellerCheck = true;
            }
          } catch(e) {}
        }
        await saveOpenShift(userId, { seller: sellerName, shop: 'NANE PARIS', cash_open: 0, start_time: new Date().toISOString(), is_second: isSecondSellerCheck });
        openShifts[String(userId)] = { seller: sellerName, shop: 'NANE PARIS', cash_open: 0, start_time: new Date().toISOString(), is_second: isSecondSellerCheck };
        const checklistFirstQ = isSecondSellerCheck
          ? 'Привет! Ты второй продавец сегодня.\n\nШАГ 0 — Внешний вид: макияж готов? одежда в порядке?'
          : 'Отлично! Начинаем чек-лист открытия.\n\nШАГ 0 — Внешний вид: макияж готов? одежда в порядке?';
        const checklistStartMsg = isSecondSellerCheck
          ? 'Второй продавец начинает смену. Упрощённый чек-лист.'
          : 'Продавец начинает смену. Начинаем чек-лист открытия с шага 0.';
        conversations[String(userId)] = [
          { role: 'user', content: checklistStartMsg },
          { role: 'assistant', content: checklistFirstQ }
        ];
        await saveMessages(userId, checklistStartMsg, checklistFirstQ);
        await sendTelegram(userId, checklistFirstQ);
        return;
      } else if (lower.includes('закрываю смену') || lower.includes('закрытие смены') || lower.includes('закрыть смену') || lower.includes('закрываю') || lower.includes('закрытие')) {
        pendingGeoAction[userId] = 'close_shift';
        // Старт закрытия — детерминированно просим ПЕРВОЕ фото. Сбрасываем прошлый сбор, чтобы не «слетало» в короткий чек-лист.
        const _uk = String(userId);
        delete shiftPhotos[_uk]; delete shiftOCR[_uk]; delete pendingClose[_uk];
        const startMsg = 'Начинаем закрытие смены.\n\nШаг 1 — пришли фото Z-отчёта ROSTA (первое фото).';
        if (!conversations[_uk]) conversations[_uk] = await loadConversation(userId);
        conversations[_uk] = sanitizeMessages(conversations[_uk] || []);
        conversations[_uk].push({ role: 'user', content: messageText });
        conversations[_uk].push({ role: 'assistant', content: startMsg });
        if (conversations[_uk].length > 40) conversations[_uk] = conversations[_uk].slice(-40);
        await saveMessages(userId, messageText, startMsg);
        await sendTelegram(userId, startMsg);
        return;
      }
    }

    if (!messageText && !photoFileId) return;
    await handleMessage(userId, messageText, photoFileId);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'TOMI NANE PARIS Telegram', version: '4.4' }));

function startChecklistTimer(userId, sellerName, startTime) {
  if (checklistTimers[userId]) { clearTimeout(checklistTimers[userId].timeout15); clearTimeout(checklistTimers[userId].timeout20); }
  const startTimeStr = startTime || getTime();
  const timeout15 = setTimeout(async () => {
    if (openShifts[String(userId)] && openShifts[String(userId)].start_time) {
      const diffMin = (new Date() - new Date(openShifts[String(userId)].start_time)) / 60000;
      if (diffMin < 20) return;
    }
    await sendTelegram(userId, '⏰ ' + sellerName + ', прошло 15 минут — чек-лист ещё не закрыт!');
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
    await dbSaveDiscipline(today, sellerName, 'Таймаут чек-листа', getTime(), 'Не закрыт за 15 минут');
    for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Чек-лист не закрыт за 15 минут!\n👤 ' + sellerName + '\n🕐 Начала в ' + startTimeStr);
    checklistTimers[userId].timeout20 = setTimeout(async () => {
      if (openShifts[String(userId)]) return;
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🚨 Чек-лист до сих пор не закрыт!\n👤 ' + sellerName);
    }, 5 * 60 * 1000);
  }, 15 * 60 * 1000);
  checklistTimers[userId] = { timeout15, timeout20: null };
}

function clearChecklistTimer(userId) {
  if (checklistTimers[userId]) {
    if (checklistTimers[userId].timeout15) clearTimeout(checklistTimers[userId].timeout15);
    if (checklistTimers[userId].timeout20) clearTimeout(checklistTimers[userId].timeout20);
    delete checklistTimers[userId];
  }
}

async function saveReminder(userId, text, remindAt) {
  try { await supabase.from('reminders').insert({ user_id: String(userId), text, remind_at: remindAt, done: false }); } catch(e) {}
}

async function checkReminders() {
  try {
    const now = new Date().toISOString();
    const { data } = await supabase.from('reminders').select('*').eq('done', false).lte('remind_at', now);
    if (!data || data.length === 0) return;
    for (const r of data) { await sendTelegram(r.user_id, '⏰ Напоминание: ' + r.text); await supabase.from('reminders').update({ done: true }).eq('id', r.id); }
  } catch(e) {}
}

async function showFinanceReport(userId, month, year) {
  try {
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const sales = await dbGetSales(month, year);
    if (!sales || sales.length === 0) { await sendTelegram(userId, '📊 Нет данных за ' + (monthNames[month]||month) + ' ' + year); return; }
    const TAX = 0.03;
    let totalRevenue = 0, totalProfit = 0, totalTax = 0, dailyFot = 0;
    const getPct = r => r>=1000000?0.027:r>=750000?0.022:r>=500000?0.017:0.012;
    let msg = '📊 ФИНАНСЫ — ' + (monthNames[month]||month) + ' ' + year + '\n━━━━━━━━━━━━━━━━━━━━\n\n';
    sales.forEach(s => {
      const rev = Number(s.revenue||0), profit = Number(s.rosta_profit||0), tax = Math.round(rev*TAX);
      totalRevenue += rev; totalProfit += profit; totalTax += tax;
      const daySellers = [s.seller1, s.seller2].filter(Boolean);
      daySellers.forEach(() => { dailyFot += 14000+rev*getPct(rev); if(rev>=2000000)dailyFot+=40000; else if(rev>=700000)dailyFot+=5000; });
      const day = s.sale_date ? s.sale_date.slice(8,10)+'.'+s.sale_date.slice(5,7) : '?';
      msg += day+' · '+rev.toLocaleString('ru-RU')+' тг'+(profit>0?' · прибыль: '+profit.toLocaleString('ru-RU')+' тг':'')+'\n';
    });
    const totalFot = Math.round(dailyFot);
    const netProfit = totalProfit>0 ? totalProfit-totalTax-totalFot : 0;
    msg += '\n━━━━━━━━━━━━━━━━━━━━\n💼 Оборот: '+totalRevenue.toLocaleString('ru-RU')+' тг\n';
    if (totalProfit>0) {
      msg += '📈 Прибыль ROSTA: '+totalProfit.toLocaleString('ru-RU')+' тг\n';
      msg += '🏛 Налог 3%: '+totalTax.toLocaleString('ru-RU')+' тг\n';
      msg += '👥 ФОТ: '+totalFot.toLocaleString('ru-RU')+' тг\n';
      msg += '💰 Чистая: '+netProfit.toLocaleString('ru-RU')+' тг\n';
      msg += '📊 ФОТ%: '+(totalRevenue>0?(totalFot/totalRevenue*100).toFixed(1):0)+'%';
    } else { msg += '\n⚠️ Введи прибыль ROSTA командой:\n«Прибыль [дата] [сумма]»'; }
    await sendTelegram(userId, msg);
  } catch(e) { console.error('showFinanceReport error:', e.message); }
}

async function showExpensesByMonth(userId, month, year, period) {
  try {
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const naneRaw = await dbGetExpenses(month, year, false, userId);
    const personalRaw = await dbGetExpenses(month, year, true, userId);
    if (naneRaw.length === 0 && personalRaw.length === 0) { await sendTelegram(userId, '📊 Расходов за ' + (monthNames[month]||month) + ' ' + year + ' нет.'); return; }
    let naneTotal = 0, personalTotal = 0;
    const naneBycat = {}, persBycat = {};
    naneRaw.forEach(e => { const c=e.category||'Прочее'; if(!naneBycat[c]) naneBycat[c]={sum:0,items:[]}; naneBycat[c].sum+=Number(e.amount); naneBycat[c].items.push((e.description||'')+'—'+Number(e.amount).toLocaleString('ru-RU')+' тг'); naneTotal+=Number(e.amount); });
    personalRaw.forEach(e => { const c=e.category||'Прочее'; if(!persBycat[c]) persBycat[c]={sum:0,items:[]}; persBycat[c].sum+=Number(e.amount); persBycat[c].items.push((e.description||'')+'—'+Number(e.amount).toLocaleString('ru-RU')+' тг'); personalTotal+=Number(e.amount); });
    let msg = '📊 Расходы — ' + (monthNames[month]||month) + ' ' + year + '\n\n';
    if (naneRaw.length > 0) {
      msg += '🏪 NANE PARIS: '+naneTotal.toLocaleString('ru-RU')+' тг\n';
      Object.entries(naneBycat).forEach(([cat,data]) => { msg+='  📁 '+cat+': '+data.sum.toLocaleString('ru-RU')+' тг\n'; data.items.forEach(i => { msg+='    · '+i+'\n'; }); });
      msg += '\n';
    }
    if (personalRaw.length > 0) {
      msg += '👤 Личные: '+personalTotal.toLocaleString('ru-RU')+' тг\n';
      Object.entries(persBycat).forEach(([cat,data]) => { msg+='  📁 '+cat+': '+data.sum.toLocaleString('ru-RU')+' тг\n'; data.items.forEach(i => { msg+='    · '+i+'\n'; }); });
      msg += '\n';
    }
    msg += '💰 Всего: '+(naneTotal+personalTotal).toLocaleString('ru-RU')+' тг';
    await sendTelegram(userId, msg);
  } catch(e) {}
}

const NANE_LESSONS = [
  {
    week: 1,
    topic: 'Полный курс NANE — бренд, сервис, продажи',
    lesson: `📚 NANE АКАДЕМИЯ ПРОДАЖ — ПОЛНЫЙ КУРС

🏷 БРЕНД И МИССИЯ
Миссия: помочь каждой покупательнице создать гардероб, который отражает её личность и стиль жизни.
Мы — премиальный женский бутик в Астане. Корея и Европа. Не fast fashion — осознанная мода.

⭐ 5 ЦЕННОСТЕЙ NANE
1. Уважение — каждая клиентка важна, нет «просто смотрящих»
2. Экспертиза — мы знаем моду, ткани и образы лучше клиента
3. Честность — не продаём то, что не идёт, лучше потерять сделку
4. Внимание — замечаем настроение, запоминаем имена
5. Красота — всё что делаем красиво: зал, одежда, наша речь

👗 ВНЕШНИЙ ВИД
✅ Одежда в стиле NANE, чистая, выглаженная
✅ Аккуратный маникюр, макияж, волосы убраны, бейдж
✅ Закрытая обувь, нейтральный парфюм
❌ Спортивная одежда, кроссовки, телефон в руках, жвачка

👩 ПОРТРЕТ КЛИЕНТА
Женщина 25–50 лет, Астана, доход средний+, ценит качество и время.
Мотивы: хочет выглядеть хорошо на работе/мероприятии, обновляет гардероб, покупает подарок себе, реагирует на эмоцию, ищет базу гардероба, пришла по рекомендации.

3 типа покупательниц:
🔵 Тип А «Знает что хочет» — дай 2-3 варианта, быстро и точно, без лишних слов
🟡 Тип Б «Ищет вдохновение» — показывай образы целиком, мягко веди, открыта к предложениям
🔴 Тип В «Сомневается» — аргументируй ценностью, не давить, цена важна

❌ ФРАЗЫ-ТАБУ → ✅ ЗАМЕНА
«Чем могу помочь?» → «Вы что-то конкретное ищете?»
«Это дорого» → «Носится 3-4 сезона — очень выгодно»
«Не знаю» → «Сейчас уточню для вас»
«Нету» → «Этой нет, но есть похожая — покажу?»
«Вам не идёт» → «Давайте попробуем другой фасон»
«Подождите» → «Одну секунду, я уже занимаюсь»

👋 ПЕРВЫЙ КОНТАКТ — 5 ШАГОВ
1. Приветствие (0-30 сек): контакт глазами + улыбка + «Добрый день, добро пожаловать»
2. Пауза 2-3 мин: не идти следом, дать осмотреться
3. Первый контакт: «Вы ищете что-то конкретное или хотите посмотреть новинки?»
4. Если «просто смотрю»: «Конечно, смотрите спокойно. Если понадоблюсь — я здесь»
5. Выявление потребности: «Это для повода или на каждый день?» «Есть любимые цвета?»

👑 ПОСТОЯННЫЙ КЛИЕНТ
Помни имя — обращайся при каждом визите
Помни предпочтения: любимые цвета, фасоны, отказы
Не предлагай то, что уже есть
VIP: сообщай о новинках первой, откладывай вещи без просьбы

👗 ПРИМЕРОЧНАЯ
1. Лично проводить к примерочной, не просто указать жестом
2. Принести размеры сразу, предложить 44 и 46
3. Через 3-5 мин: «Как вам? Принести другой размер?»
4. Оставаться рядом, не уходить из зоны видимости
5. Принять вещи лично — не оставлять на полу

🧵 ТКАНИ И УХОД
Вискоза — мягкая, дышащая. «Приятная к телу, особенно летом» Уход: не отжимать, гладить через ткань
Жаккард — плотная, держит форму. «Выглядит очень дорого»
Трикотаж — тянется. «Сидит по фигуре, не сковывает»
Полиэстер — не мнётся. «Не нужно гладить, всегда аккуратно»
Эко-кожа — структурированная. «Стильно, лёгкий уход»
Если не знаешь состав → «Сейчас уточню на ярлыке»

⚠️ СЛОЖНЫЕ СИТУАЦИИ
Недовольный клиент: выслушать → признать («Я понимаю, это неприятно») → не оправдываться → решение → поблагодарить
Нет товара: похожая модель → сроки поставки → записать контакт. Никогда просто «нету»!
Возврат: не принимать решение самостоятельно — позвать старшего
Кража: не обвинять публично → подойти и предложить помощь → сообщить в Томи → не задерживать
Клиенту плохо: усадить, воду, позвать коллегу, вызвать 103, не оставлять одного

🚨 ЭКСТРЕННЫЕ СИТУАЦИИ
Пожар/задымление: вывести клиентов, вызвать 101, не возвращаться за вещами
Конфликт между клиентами: не вмешиваться физически, предложить воды, вызвать руководство

🏪 ОПЕРАЦИОННЫЕ СТАНДАРТЫ
Приход: за 15 мин до открытия, внешний вид, обойти зал (примерочные, зеркала, ценники), проверить кассу и терминалы, открыть Томи
В течение дня: каждые 30 мин обход, после каждого клиента убрать примерочную, ценники на всех вещах
Закрытие: порядок в зале, Z-отчёт, фото терминалов, форма в Томи

━━━━━━━━━━━━━━━━━
Изучи до пятницы — будет тест 🎯\n\n⚠️ Результат теста влияет на KPI:\n✅ Тест сдан (≥80%) — KPI засчитывается\n❌ Тест не сдан или пропущен — KPI не засчитывается`,
    questions: [
      { q: 'Назови миссию NANE и 5 ценностей', key: 'помочь гардероб личность уважение экспертиза честность внимание красота' },
      { q: 'Как приветствовать клиента при входе и что делать если он говорит «просто смотрю»?', key: 'контакт глазами улыбка приветствие пауза конечно смотрите здесь' },
      { q: 'Назови 3 фразы-табу и их замены', key: 'чем могу нету дорого конкретное похожая сезона' },
      { q: 'Опиши стандарт работы с примерочной (3 шага)', key: 'лично проводить размер спросить принять вещи' },
      { q: 'Клиент хочет вещь которой нет. Твои действия?', key: 'похожая сроки контакт нету нельзя' },
      { q: 'Что делать при подозрении на кражу?', key: 'не обвинять подойти помощь томи не задерживать' },
      { q: 'Опиши типы покупательниц (A, Б, В)', key: 'знает хочет вдохновение сомневается' },
      { q: 'Назови стандарт открытия смены (4 шага)', key: 'внешний вид зал касса терминалы томи' },
      { q: 'Клиент вернулся с претензией. Твои действия?', key: 'выслушать признать не оправдываться старший поблагодарить' },
      { q: 'Как работать с постоянным клиентом?', key: 'имя предпочтения покупки vip новинки' }
    ]
  }
];

// Рандомные вопросы для поддержания знаний (после обучения)
const RANDOM_QUESTIONS = [
  'Клиент говорит «дорого». Что отвечаешь?',
  'Как правильно приветствовать клиента при входе?',
  'Назови 5 ценностей NANE',
  'Чем отличается Тип А от Типа Б покупательниц?',
  'Что делать если клиент хочет вернуть товар?',
  'Как ухаживать за вискозой?',
  'Клиент говорит «просто смотрю». Что отвечаешь?',
  'Назови 3 фразы-табу и их замены',
  'Что делать при подозрении на кражу?',
  'Опиши стандарт примерочной зоны',
  'Как встречать постоянного клиента?',
  'Что делать если клиенту стало плохо в магазине?',
  'Как описать жаккард клиенту?',
  'Что проверить при открытии смены?',
  'Как правильно закончить примерку если вещь не подошла?'
];

// Состояние обучения (в памяти, сбрасывается при рестарте)
function generateLessonHTML(lesson, weekNum) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NANE Академия — Неделя ${weekNum}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ede8;color:#1a1a1a;padding:20px 16px}.container{max-width:560px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}.brand{font-size:20px;font-weight:600;letter-spacing:.04em}.brand-sub{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.1em;margin-top:2px}.header-right{text-align:right;font-size:13px;color:#555}.header-right strong{color:#1a1a1a;display:block}.status{background:#eaf3de;border:0.5px solid #c0dd97;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px;margin-bottom:20px}.status-dot{width:8px;height:8px;border-radius:50%;background:#639922;flex-shrink:0}.status-text{font-size:13px;font-weight:500;color:#3B6D11}.sec{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.12em;margin:18px 0 8px}.card{background:#fff;border:0.5px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px}.row{padding:10px 14px;border-bottom:0.5px solid #f0ece6;font-size:12px}.row:last-child{border:none}.row-label{font-weight:500;color:#1a1a1a;margin-bottom:3px}.row-text{color:#555;line-height:1.6}.taboo-row{padding:10px 14px;border-bottom:0.5px solid #f0ece6;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px}.taboo-row:last-child{border:none}.taboo-bad{color:#E24B4A;text-decoration:line-through;flex:1}.taboo-good{color:#3B6D11;font-weight:500;flex:1;text-align:right}.type-row{padding:10px 14px;border-bottom:0.5px solid #f0ece6;display:flex;align-items:center;gap:10px}.type-row:last-child{border:none}.type-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.type-title{font-size:12px;font-weight:500;color:#1a1a1a}.type-sub{font-size:11px;color:#888;margin-top:1px}.step-row{padding:10px 14px;border-bottom:0.5px solid #f0ece6;font-size:12px;color:#555;display:flex;gap:8px}.step-row:last-child{border:none}.step-num{color:#3B6D11;font-weight:600;flex-shrink:0}.fabric-row{padding:10px 14px;border-bottom:0.5px solid #f0ece6}.fabric-row:last-child{border:none}.fabric-name{font-size:12px;font-weight:500;color:#1a1a1a}.fabric-desc{font-size:11px;color:#888;margin-top:2px}.situation-row{padding:10px 14px;border-bottom:0.5px solid #f0ece6}.situation-row:last-child{border:none}.situation-title{font-size:12px;font-weight:500}.situation-desc{font-size:11px;color:#888;margin-top:2px;line-height:1.5}.footer{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:20px}.footer-card{border-radius:8px;padding:10px;text-align:center}.footer-label{font-size:10px;margin-bottom:2px}.footer-value{font-size:12px;font-weight:600}</style></head>
<body><div class="container">

<div class="header">
  <div><div class="brand">NANÉ PARIS</div><div class="brand-sub">Академия продаж</div></div>
  <div class="header-right"><strong>Неделя ${weekNum}</strong>читается за 7 мин</div>
</div>
<div class="status"><div class="status-dot"></div><span class="status-text">${lesson.topic}</span></div>

<div class="sec">Бренд и миссия</div>
<div class="card">
  <div class="row"><div class="row-label">Миссия</div><div class="row-text">Помочь каждой покупательнице создать гардероб, который отражает её личность и стиль жизни.</div></div>
  <div class="row"><div class="row-label">5 ценностей</div><div class="row-text">Уважение · Экспертиза · Честность · Внимание · Красота</div></div>
  <div class="row"><div class="row-label">Позиционирование</div><div class="row-text">Корея и Европа. Премиальный бутик Астаны. Не fast fashion — осознанная мода.</div></div>
</div>

<div class="sec">Внешний вид</div>
<div class="card">
  <div class="row"><div class="row-label" style="color:#3B6D11">✅ Обязательно</div><div class="row-text">Одежда в стиле NANE · аккуратный маникюр и макияж · волосы убраны · бейдж · нейтральный парфюм</div></div>
  <div class="row"><div class="row-label" style="color:#E24B4A">❌ Запрещено</div><div class="row-text">Спортивная одежда · кроссовки · телефон в руках · жвачка</div></div>
</div>

<div class="sec">Типы клиентов</div>
<div class="card">
  <div class="type-row"><div class="type-dot" style="background:#378ADD"></div><div><div class="type-title">Тип А — знает что хочет</div><div class="type-sub">2-3 варианта, быстро и точно, без лишних слов</div></div></div>
  <div class="type-row"><div class="type-dot" style="background:#EF9F27"></div><div><div class="type-title">Тип Б — ищет вдохновение</div><div class="type-sub">Показывай образы целиком, мягко веди, открыта к предложениям</div></div></div>
  <div class="type-row"><div class="type-dot" style="background:#E24B4A"></div><div><div class="type-title">Тип В — сомневается</div><div class="type-sub">Аргументируй ценностью, не давить, цена важна</div></div></div>
  <div class="row"><div class="row-label">Мотивы покупки</div><div class="row-text">Выглядеть хорошо на работе · обновить гардероб · подарок себе · эмоция от вещи · база гардероба · рекомендация подруги</div></div>
</div>

<div class="sec">Фразы-табу → замена</div>
<div class="card">
  <div class="taboo-row"><span class="taboo-bad">«Чем могу помочь?»</span><span class="taboo-good">«Что-то конкретное ищете?»</span></div>
  <div class="taboo-row"><span class="taboo-bad">«Это дорого»</span><span class="taboo-good">«Носится 3-4 сезона»</span></div>
  <div class="taboo-row"><span class="taboo-bad">«Не знаю»</span><span class="taboo-good">«Сейчас уточню»</span></div>
  <div class="taboo-row"><span class="taboo-bad">«Нету»</span><span class="taboo-good">«Есть похожая — покажу?»</span></div>
  <div class="taboo-row"><span class="taboo-bad">«Вам не идёт»</span><span class="taboo-good">«Попробуем другой фасон»</span></div>
</div>

<div class="sec">Первый контакт — 5 шагов</div>
<div class="card">
  <div class="step-row"><span class="step-num">1.</span><span>Приветствие 0-30 сек: контакт глазами + улыбка + «Добрый день»</span></div>
  <div class="step-row"><span class="step-num">2.</span><span>Пауза 2-3 мин — не идти следом, дать осмотреться</span></div>
  <div class="step-row"><span class="step-num">3.</span><span>«Вы ищете что-то конкретное или хотите посмотреть новинки?»</span></div>
  <div class="step-row"><span class="step-num">4.</span><span>Если «просто смотрю» → «Конечно, смотрите спокойно. Я здесь»</span></div>
  <div class="step-row"><span class="step-num">5.</span><span>Выявление потребности: «Это для повода?» «Есть любимые цвета?»</span></div>
</div>

<div class="sec">Постоянный клиент</div>
<div class="card">
  <div class="row"><div class="row-label">Помни</div><div class="row-text">Имя · предпочтения (цвета, фасоны) · последние покупки</div></div>
  <div class="row"><div class="row-label">VIP-сервис</div><div class="row-text">Сообщай о новинках первой · откладывай вещи без просьбы · не заставляй ждать</div></div>
</div>

<div class="sec">Примерочная</div>
<div class="card">
  <div class="step-row"><span class="step-num">1.</span><span>Лично проводить к примерочной, не просто указать жестом</span></div>
  <div class="step-row"><span class="step-num">2.</span><span>Принести размеры сразу, предложить 44 и 46</span></div>
  <div class="step-row"><span class="step-num">3.</span><span>Через 3-5 мин: «Как вам? Принести другой размер?»</span></div>
  <div class="step-row"><span class="step-num">4.</span><span>Оставаться рядом — не уходить из зоны видимости</span></div>
  <div class="step-row"><span class="step-num">5.</span><span>Принять вещи лично — не оставлять на полу кабины</span></div>
</div>

<div class="sec">Ткани и уход</div>
<div class="card">
  <div class="fabric-row"><div class="fabric-name">Вискоза</div><div class="fabric-desc">Мягкая, дышащая — «Приятная к телу, особенно летом» · не отжимать, гладить через ткань</div></div>
  <div class="fabric-row"><div class="fabric-name">Жаккард</div><div class="fabric-desc">Плотная, держит форму — «Выглядит очень дорого»</div></div>
  <div class="fabric-row"><div class="fabric-name">Трикотаж</div><div class="fabric-desc">Тянется, комфортный — «Сидит по фигуре, не сковывает»</div></div>
  <div class="fabric-row"><div class="fabric-name">Полиэстер</div><div class="fabric-desc">Практичный, не мнётся — «Не нужно гладить, всегда аккуратно»</div></div>
  <div class="fabric-row"><div class="fabric-name">Не знаешь?</div><div class="fabric-desc">«Сейчас уточню на ярлыке» — никогда не угадывай</div></div>
</div>

<div class="sec">Сложные ситуации</div>
<div class="card">
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Недовольный клиент</div><div class="situation-desc">Выслушать → «Я понимаю, это неприятно» → не оправдываться → решение → поблагодарить за обратную связь</div></div>
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Нет товара</div><div class="situation-desc">Похожая модель → сроки поставки → записать контакт. Никогда просто «нету»!</div></div>
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Возврат</div><div class="situation-desc">Не принимать решение самостоятельно — позвать старшего. Выслушать спокойно.</div></div>
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Кража</div><div class="situation-desc">Не обвинять публично → подойти и предложить помощь → сообщить в Томи → не задерживать</div></div>
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Клиенту плохо</div><div class="situation-desc">Усадить · принести воду · позвать коллегу · вызвать 103 · не оставлять одного</div></div>
  <div class="situation-row"><div class="situation-title" style="color:#E24B4A">Пожар/ЧС</div><div class="situation-desc">Вывести клиентов → вызвать 101 → не возвращаться за вещами → сообщить руководству</div></div>
</div>

<div class="sec">Операционные стандарты</div>
<div class="card">
  <div class="row"><div class="row-label">Открытие смены</div><div class="row-text">За 15 мин до открытия · внешний вид · обойти зал (примерочные, зеркала, ценники) · проверить кассу и терминалы · открыть Томи</div></div>
  <div class="row"><div class="row-label">В течение дня</div><div class="row-text">Каждые 30 мин обход · после каждого клиента убрать примерочную · ценники на всех вещах</div></div>
  <div class="row"><div class="row-label">Закрытие смены</div><div class="row-text">Порядок в зале · Z-отчёт (фото) · фото терминалов Kaspi и Halyk · форма в Томи</div></div>
</div>

<div style="background:#fffbe6;border:0.5px solid #FAC775;border-radius:10px;padding:12px 14px;margin-top:20px;margin-bottom:10px">
  <div style="font-size:12px;font-weight:500;color:#854F0B;margin-bottom:8px">⚠️ Результат теста влияет на KPI</div>
  <div style="font-size:12px;color:#555;margin-bottom:4px">✅ Тест сдан (≥80%) — KPI засчитывается</div>
  <div style="font-size:12px;color:#555">❌ Тест не сдан или пропущен — KPI не засчитывается</div>
</div>

<div class="footer">
  <div class="footer-card" style="background:#eaf3de;border:0.5px solid #c0dd97">
    <div class="footer-label" style="color:#639922">Урок</div>
    <div class="footer-value" style="color:#3B6D11">Неделя ${weekNum}</div>
  </div>
  <div class="footer-card" style="background:#faeeda;border:0.5px solid #FAC775">
    <div class="footer-label" style="color:#854F0B">Тест</div>
    <div class="footer-value" style="color:#854F0B">В пятницу</div>
  </div>
  <div class="footer-card" style="background:#f7f4ef;border:0.5px solid #e8e4de">
    <div class="footer-label" style="color:#aaa">Вопросов</div>
    <div class="footer-value" style="color:#1a1a1a">${lesson.questions.length} шт</div>
  </div>
</div>

</div></body></html>`;
}


const trainingState = {};
const pendingTestAnswer = {};
let trainingPaused = false;
let currentTrainingWeek = 0;

async function sendWeeklyTraining(forceLesson) {
  try {
    if (trainingPaused && !forceLesson) return;
    const sellers = Object.entries(ALLOWED_MAP).filter(([id]) => !OWNER_IDS.includes(id));
    if (sellers.length === 0) return;
    const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const dayOfWeek = nowA.getDay();
    const isTest = !forceLesson && dayOfWeek === 5;
    const isLesson = forceLesson || dayOfWeek === 1;
    if (!isLesson && !isTest) return;
    let weekNum = 1;
    try {
      const { data } = await supabase.from('training_progress').select('week').order('week', { ascending: false }).limit(1);
      if (data && data.length > 0) weekNum = data[0].week;
    } catch(e) {}
    if (isLesson) {
      if (weekNum > NANE_LESSONS.length) { await sendRandomTrainingQuestion(); return; }
      const lesson = NANE_LESSONS[weekNum - 1];
      const lessonHtml = generateLessonHTML(lesson, weekNum);
      const lessonFilename = 'urok_nedelya_' + weekNum + '.html';
      const lessonCaption = '📚 NANE Академия — Неделя ' + weekNum + ' · Открой в браузере';
      for (const [sellerId] of sellers) {
        await sendTelegramDocument(sellerId, lessonFilename, lessonHtml, lessonCaption);
        trainingState[sellerId] = { week: weekNum, phase: 'learning', completed: false };
        await new Promise(r => setTimeout(r, 1000));
      }
      try { await supabase.from('training_progress').upsert({ week: weekNum, sent_at: new Date().toISOString() }, { onConflict: 'week' }); } catch(e) {}
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '📚 Урок недели ' + weekNum + ' отправлен\n📖 ' + lesson.topic + '\n👥 Продавцов: ' + sellers.length);
      if (!forceLesson) currentTrainingWeek = weekNum;
    }
    if (isTest) {
      if (weekNum > NANE_LESSONS.length) { await sendRandomTrainingQuestion(); return; }
      const lesson = NANE_LESSONS[weekNum - 1];
      const testIntro = '🎯 ТЕСТ — Неделя ' + weekNum + '\n📖 ' + lesson.topic + '\n\nОтвечай развёрнуто, своими словами.\n\n';
      for (const [sellerId] of sellers) {
        // Сбрасываем возможные старые данные
        delete pendingTestAnswer[sellerId];
        // Отправляем интро
        await sendTelegram(sellerId, testIntro);
        await new Promise(r => setTimeout(r, 500));
        // Инициализируем тест
        pendingTestAnswer[sellerId] = { weekNum, questionIndex: 0, answers: [] };
        trainingState[sellerId] = { ...(trainingState[sellerId] || {}), phase: 'testing', week: weekNum };
        // Отправляем первый вопрос
        await sendTelegram(sellerId, '🔸 Вопрос 1 из ' + lesson.questions.length + ':\n\n' + lesson.questions[0].q);
        await new Promise(r => setTimeout(r, 1000));
      }
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🎯 Тест недели ' + weekNum + ' отправлен продавцам\n📖 ' + lesson.topic);
      if (weekNum === NANE_LESSONS.length) {
        try { await supabase.from('training_progress').upsert({ week: weekNum + 1, sent_at: new Date().toISOString() }, { onConflict: 'week' }); } catch(e) {}
      }
    }
  } catch(e) { console.error('sendWeeklyTraining error:', e.message); }
}

async function handleTrainingTestAnswer(userId, messageText) {
  const pending = pendingTestAnswer[String(userId)];
  if (!pending) return false;
  const { weekNum, questionIndex, answers } = pending;
  const lesson = NANE_LESSONS[weekNum - 1];
  if (!lesson) return false;
  answers.push(messageText);
  const nextIndex = questionIndex + 1;
  if (nextIndex < lesson.questions.length) {
    pendingTestAnswer[String(userId)].questionIndex = nextIndex;
    pendingTestAnswer[String(userId)].answers = answers;
    await sendTelegram(userId, '🔸 Вопрос ' + (nextIndex + 1) + ' из ' + lesson.questions.length + ':\n\n' + lesson.questions[nextIndex].q);
    return true;
  }
  delete pendingTestAnswer[String(userId)];
  await sendTelegram(userId, '⏳ Проверяю ответы...');
  let score = 0;
  const evaluation = [];
  for (let i = 0; i < lesson.questions.length; i++) {
    const q = lesson.questions[i];
    const answer = answers[i] || '';
    const keywords = q.key.split(' ');
    const answerLower = answer.toLowerCase();
    const matched = keywords.filter(kw => answerLower.includes(kw)).length;
    // Порог 30% ключевых слов (минимум 1 совпадение)
    const threshold = Math.max(1, Math.ceil(keywords.length * 0.3));
    const isCorrect = matched >= threshold;
    if (isCorrect) score++;
    evaluation.push({ q: q.q, correct: isCorrect });
  }
  const total = lesson.questions.length;
  const pct = Math.round(score / total * 100);
  const passed = pct >= 80;
  const emoji = passed ? '✅' : '❌';
  let resultMsg = emoji + ' Тест завершён!\n\n';
  resultMsg += '📊 Результат: ' + score + '/' + total + ' (' + pct + '%)\n';
  resultMsg += passed ? '✅ Тест сдан! KPI за обучение засчитывается.' : '❌ Тест не сдан. Порог 80% не достигнут.\n⚠️ KPI за обучение не засчитывается — повтори материал и сдай в следующую пятницу.';
  await sendTelegram(userId, resultMsg);
  if (!passed) await sendTelegram(userId, '📖 Перечитай урок и попробуй ещё раз в следующую пятницу.');
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
  const sellerName = ALLOWED_MAP[String(userId)] || 'Продавец';
  await dbSaveDiscipline(today, sellerName, 'Тест неделя ' + weekNum, getTime(), score + '/' + total + ' ' + emoji + ' ' + (passed ? 'Сдан' : 'Не сдан'));
  let ownerMsg = '📊 Результат теста\n👤 ' + sellerName + '\n📖 ' + lesson.topic + '\n\n';
  ownerMsg += '🎯 Балл: ' + score + '/' + total + ' (' + pct + '%) ' + emoji + '\n\n';
  // Детальный разбор каждого вопроса с ответом продавца и правильным ответом
  evaluation.forEach((e, i) => {
    const q = lesson.questions[i];
    const sellerAnswer = answers[i] || '(нет ответа)';
    ownerMsg += (e.correct ? '✅' : '❌') + ' ' + (i+1) + '. ' + e.q + '\n';
    ownerMsg += '💬 Ответ: ' + sellerAnswer.slice(0, 100) + '\n';
    if (!e.correct) ownerMsg += '📌 Ключевые слова: ' + (q.key || '').split(' ').slice(0, 5).join(', ') + '\n';
    ownerMsg += '\n';
  });
  // Разбиваем на части если длинное
  const parts = [];
  for (let i = 0; i < ownerMsg.length; i += 3500) parts.push(ownerMsg.slice(i, i + 3500));
  for (const ownerId of OWNER_IDS) {
    for (const part of parts) await sendTelegram(ownerId, part);
  }
  if (trainingState[String(userId)]) trainingState[String(userId)].completed = passed && weekNum === NANE_LESSONS.length;
  return true;
}

async function sendRandomTrainingQuestion() {
  try {
    const sellers = Object.entries(ALLOWED_MAP).filter(([id]) => !OWNER_IDS.includes(id));
    if (sellers.length === 0) return;
    const randomQ = RANDOM_QUESTIONS[Math.floor(Math.random() * RANDOM_QUESTIONS.length)];
    const msg = '🧠 ТРЕНИРОВКА ПАМЯТИ\n\nБыстрый вопрос:\n\n' + randomQ + '\n\n_(Ответь своими словами)_';
    for (const [sellerId] of sellers) { await sendTelegram(sellerId, msg); await new Promise(r => setTimeout(r, 1000)); }
  } catch(e) { console.error('sendRandomTrainingQuestion error:', e.message); }
}

function scheduleRandomQuestions() {
  const scheduleNext = () => {
    const delayMs = (28 + Math.random() * 32) * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
        const hour = nowA.getHours(), day = nowA.getDay();
        if (day >= 1 && day <= 6 && hour >= 11 && hour < 19) {
          let hasCompleted = false;
          try {
            const { data } = await supabase.from('training_progress').select('week').order('week', { ascending: false }).limit(1);
            if (data && data.length > 0 && data[0].week > NANE_LESSONS.length) hasCompleted = true;
          } catch(e) {}
          if (hasCompleted && !trainingPaused) await sendRandomTrainingQuestion();
        }
      } catch(e) {}
      scheduleNext();
    }, delayMs);
  };
  scheduleNext();
}


async function sendMorningDigest() {
  try {
    const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const month = nowA.getMonth()+1, year = nowA.getFullYear();
    const sales = await dbGetSales(month, year);
    const prepays = await dbGetPrepays('open');
    const monthTotal = (sales||[]).reduce((sum,s) => sum+Number(s.revenue||0), 0);
    const plan = PLAN_TOTAL;
    const pct = Math.round(monthTotal/plan*100);
    const remains = Math.max(0, plan-monthTotal);
    const daysLeft = new Date(year,month,0).getDate()-nowA.getDate();
    const dailyNeed = daysLeft > 0 ? Math.round(remains/daysLeft) : 0;
    const totalDebt = prepays.reduce((s,p) => s+Number(p.balance||0), 0);
    const todayDateStr = nowA.toLocaleDateString('ru-RU', { weekday:'long', day:'numeric', month:'long' });
    let msg = '☀️ Доброе утро, Ермек!\n' + todayDateStr.charAt(0).toUpperCase() + todayDateStr.slice(1) + '\n\n';
    msg += '📈 ПЛАН МЕСЯЦА\n✅ Выполнено: ' + monthTotal.toLocaleString('ru-RU') + ' тг (' + pct + '%)\n';
    msg += '🎯 Осталось: ' + remains.toLocaleString('ru-RU') + ' тг\n';
    msg += '📌 Нужно в день: ' + dailyNeed.toLocaleString('ru-RU') + ' тг\n\n';
    msg += '💳 ПРЕДОПЛАТЫ\n';
    msg += prepays.length > 0 ? '📋 Открытых: '+prepays.length+' шт\n💵 Долг: '+totalDebt.toLocaleString('ru-RU')+' тг' : '✅ Открытых нет';
    msg += '\n\nХорошего дня! 💪';
    for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, msg);
  } catch(e) { console.error('Ошибка дайджеста:', e.message); }
}

function generatePrepaysHTML(list, type) {
  const title = type === 'open' ? 'Открытые предоплаты' : 'Закрытые предоплаты';
  const totalDebt = list.filter(p => !p.status.includes('закрыт')).reduce((s,p) => s+(p.balance||0), 0);
  const totalAmount = list.reduce((s,p) => s+(p.amount||0), 0);
  const fmt = n => Number(n||0).toLocaleString('ru-RU') + ' ₸';
  const cards = list.map((p,i) => {
    const isClosed = p.status.includes('закрыт');
    const initials = p.client.split(' ').filter(Boolean).map(w=>w[0]).join('').toUpperCase().slice(0,2);
    return `<div style="background:#fff;border:1px solid #e8e8e4;border-radius:12px;padding:14px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:36px;height:36px;border-radius:50%;background:${isClosed?'#eaf3de':'#faeeda'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:${isClosed?'#3B6D11':'#854F0B'};">${initials}</div>
        <div><div style="font-size:14px;font-weight:600;">${i+1}. ${p.client}</div><div style="font-size:11px;color:#888;">${p.id||''} · ${p.date||''}</div></div>
        <div style="margin-left:auto;background:${isClosed?'#eaf3de':'#faeeda'};color:${isClosed?'#3B6D11':'#854F0B'};font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;">${isClosed?'✅ Закрыта':'🟡 Открыта'}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="background:#f5f5f0;border-radius:8px;padding:8px;text-align:center;"><div style="font-size:10px;color:#888;">Аванс</div><div style="font-size:14px;font-weight:600;">${fmt(p.amount)}</div></div>
        <div style="background:${p.balance>0?'#fcebeb':'#eaf3de'};border-radius:8px;padding:8px;text-align:center;"><div style="font-size:10px;color:#888;">Долг</div><div style="font-size:14px;font-weight:600;color:${p.balance>0?'#A32D2D':'#1D9E75'};">${p.balance>0?fmt(p.balance):'Оплачено'}</div></div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#888;">💳 ${p.channel}</div>
    </div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f0;padding:16px}.container{max-width:680px;margin:0 auto}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 16px}.stat{background:#efefea;border-radius:8px;padding:10px}.stat-label{font-size:10px;color:#888;margin-bottom:3px}.stat-value{font-size:16px;font-weight:600}</style></head><body><div class="container"><div style="font-size:18px;font-weight:700;">NANÉ PARIS</div><div style="font-size:11px;color:#888;text-transform:uppercase;">${title} · ${list.length} шт</div><div class="stats"><div class="stat"><div class="stat-label">Позиций</div><div class="stat-value">${list.length}</div></div><div class="stat"><div class="stat-label">Авансы</div><div class="stat-value">${fmt(totalAmount)}</div></div><div class="stat"><div class="stat-label">Долги</div><div class="stat-value" style="color:${totalDebt>0?'#E24B4A':'#1D9E75'}">${fmt(totalDebt)}</div></div></div>${cards}</div></body></html>`;
}

function generateShiftHTML(data) {
  const { sellerName, date, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs, prepayExplanations } = data;
  // Касса: продажи наличными ГРОСС («Наличные» из Z-отчёта), ожидаемая = открытие + наличные − инкассация − выплаты
  const cashSalesGross = (s.rCash||0);
  const cashExpectedHtml = (s.cashOpen||0) + cashSalesGross - (s.inkasso||0) - (s.cashPayouts||0);
  // Каналы: показываем возвраты и чистый ROSTA, чтобы арифметика билась визуально
  const kaspiRet = (s.rRetKaspi||0)+(s.rRetOnlineKaspi||0);
  const kaspiRostaNet = (s.rKaspi||0)+(s.rOnline||0)-kaspiRet;
  const kaspiDiffHtml = (kaspiNet||0) - kaspiRostaNet;
  const halykRet = (s.rRetHalyk||0)+(s.rRetHalykOnline||0);
  const halykRostaNet = (s.rHalyk||0)+(s.rHalykOnline||0)-halykRet;
  const halykDiffHtml = (halykNet||0) - halykRostaNet;
  const dColor = d => Math.abs(d)>500 ? '#E24B4A' : '#1D9E75';
  const dSign = d => d>0 ? '+' : '';
  const _explCh = new Set((prepayExplanations||[]).map(p => p.channel));
  const _unexpl = (channelDiffs||[]).filter(cd => Math.abs(cd.diff) >= 500 && !_explCh.has(cd.channel));
  const isOk = Math.abs(diff) < 500 || _unexpl.length === 0;
  const _explainedNonzero = isOk && Math.abs(diff) >= 500;
  const isDanger = !isOk;
  const statusBg   = isOk ? '#eaf3de' : '#fcebeb';
  const statusBorder = isOk ? '#c0dd97' : '#F7C1C1';
  const statusDot  = isOk ? '#639922' : '#E24B4A';
  const statusText = !isOk ? 'РАСХОЖДЕНИЕ — требует внимания' : (_explainedNonzero ? 'Расхождение объяснено предоплатой — смена закрыта' : 'Все каналы сходятся — смена закрыта корректно');
  const statusColor = isOk ? '#3B6D11' : '#A32D2D';
  const diffColor  = diff >= 0 ? '#1D9E75' : '#E24B4A';
  const diffSign   = diff >= 0 ? '+' : '';
  const fmt = n => Number(n||0).toLocaleString('ru-RU') + ' ₸';
  const grossSales = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0);
  const totalRetAll = (s.rRetKaspi||0)+(s.rRetOnlineKaspi||0)+(s.rRetHalyk||0)+(s.rRetHalykOnline||0)+(s.rRetCash||0)+(s.rRetPersonal||0);

  // Расшифровка расхождений
  let diffDetails = '';
  if (isDanger && channelDiffs && channelDiffs.length > 0) {
    diffDetails = '<div style="background:#fff8f8;border:1px solid #F7C1C1;border-radius:8px;padding:14px;margin-bottom:16px;"><div style="font-size:13px;font-weight:600;color:#A32D2D;margin-bottom:10px;">Расшифровка расхождений</div>';
    channelDiffs.forEach(cd => {
      const sign = cd.diff > 0 ? '+' : '';
      const color = cd.diff > 0 ? '#1D9E75' : '#E24B4A';
      const direction = cd.diff > 0 ? 'излишек' : 'недостача';
      diffDetails += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid #fde8e8;"><span style="color:#555;">' + cd.channel + '</span><span style="color:' + color + ';font-weight:600;">' + sign + fmt(cd.diff) + ' (' + direction + ')</span></div>';
    });
    diffDetails += '</div>';
  }

  // Пояснения предоплатами
  let prepaySection = '';
  if (prepayExplanations && prepayExplanations.length > 0) {
    prepaySection = '<div style="background:#eaf3de;border:1px solid #c0dd97;border-radius:8px;padding:14px;margin-bottom:16px;"><div style="font-size:13px;font-weight:600;color:#3B6D11;margin-bottom:10px;">✅ Расхождение объяснено предоплатами</div>';
    prepayExplanations.forEach(pe => {
      const sign = pe.diff > 0 ? '+' : '';
      prepaySection += '<div style="font-size:12px;padding:5px 0;border-bottom:1px solid #c0dd97;"><span style="color:#555;font-weight:600;">' + pe.channel + ': ' + sign + Number(pe.diff).toLocaleString() + ' ₸</span></div>';
      pe.prepays.forEach(p => { prepaySection += '<div style="font-size:12px;padding:4px 0 4px 12px;color:#3B6D11;">→ ' + p.client + ' — ' + Number(p.amount).toLocaleString() + ' ₸</div>'; });
    });
    prepaySection += '</div>';
  }

  // Пояснения к расхождениям (notes)
  let notesSection = '';
  if (s.notes && s.notes.trim().length > 0) {
    notesSection = '<div style="background:#fffbe6;border:1px solid #FAC775;border-radius:8px;padding:14px;margin-bottom:16px;"><div style="font-size:13px;font-weight:600;color:#854F0B;margin-bottom:8px;">📝 Пояснения к расхождениям</div><div style="font-size:12px;color:#555;line-height:1.6;">' + s.notes.replace(/;/g, '<br>') + '</div></div>';
  }

  // Статусы каналов внизу
  // Сравниваем ЧИСТЫЕ суммы (после возвратов с обеих сторон)
  const kaspiDiff = ((s.tKaspi||0)-(s.tKaspiRet||0)) - ((s.rKaspi||0)+(s.rOnline||0)-(s.rRetKaspi||0)-(s.rRetOnlineKaspi||0));
  const halykDiff = ((s.tHalyk||0)-(s.tHalykRet||0)) - ((s.rHalyk||0)+(s.rHalykOnline||0)-(s.rRetHalyk||0)-(s.rRetHalykOnline||0));
  const channelStatus = [
    { label: 'Kaspi',    ok: Math.abs(kaspiDiff) <= 500 },
    { label: 'Halyk',    ok: Math.abs(halykDiff) <= 500 },
    { label: 'Наличные', ok: true }
  ].map(ch => '<div style="background:' + (ch.ok?'#eaf3de':'#fcebeb') + ';border:1px solid ' + (ch.ok?'#c0dd97':'#F7C1C1') + ';border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:#888;margin-bottom:4px;">' + ch.label + '</div><div style="font-size:13px;font-weight:600;color:' + (ch.ok?'#3B6D11':'#A32D2D') + '">' + (ch.ok?'Сходится':'Расхождение') + '</div></div>').join('');

  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ede8;color:#1a1a1a;padding:20px 16px}.container{max-width:680px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}.brand{font-size:22px;font-weight:600;letter-spacing:0.04em}.brand-sub{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-top:2px}.header-right{text-align:right;font-size:13px;color:#555}.header-right strong{color:#1a1a1a;display:block;font-size:14px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:24px}.metric{background:#efefea;border-radius:8px;padding:12px}.metric-label{font-size:10px;color:#888;margin-bottom:4px}.metric-value{font-size:16px;font-weight:600}.card{background:#fff;border:1px solid #e8e8e4;border-radius:12px;padding:14px}.card-title{display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:13px;font-weight:600}.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.row{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid #f0f0ec}.row:last-child{border:none}.row-label{color:#888}.row-value{font-weight:500}.row-total{display:flex;justify-content:space-between;font-size:13px;font-weight:600;padding:8px 0 0}.sec{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px}.signature{border-top:1px solid #ccc;margin-top:8px;padding-top:4px;font-size:12px;color:#888}`;

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт смены — ${sellerName}</title><style>${css}</style></head><body><div class="container">
<div class="header"><div><div class="brand">NANÉ PARIS</div><div class="brand-sub">Отчёт смены</div></div><div class="header-right"><strong>${date}</strong>${sellerName} · закрыто в ${closeTime}</div></div>
<div style="background:${statusBg};border:1px solid ${statusBorder};border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px;margin-bottom:20px;"><div style="width:8px;height:8px;border-radius:50%;background:${statusDot};flex-shrink:0;"></div><span style="font-size:13px;font-weight:600;color:${statusColor};">${statusText}</span></div>
<div class="sec">Эффективность дня</div>
<div class="grid4">
<div class="metric"><div class="metric-label">Валовые продажи</div><div class="metric-value">${fmt(grossSales)}</div></div>
<div class="metric"><div class="metric-label">Возвраты</div><div class="metric-value" style="color:${totalRetAll>0?'#E24B4A':'#888'}">${totalRetAll>0?'-'+fmt(totalRetAll):fmt(0)}</div></div>
<div class="metric"><div class="metric-label">Чистые продажи</div><div class="metric-value">${fmt(rostaTotal)}</div></div>
<div class="metric"><div class="metric-label">Получено денег</div><div class="metric-value">${fmt(factTotal)}</div></div>
</div>
${diffDetails}${prepaySection}${notesSection}
<div class="sec">Каналы продаж</div>
<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
<div class="card"><div class="card-title"><div class="dot" style="background:#378ADD"></div>Kaspi</div><div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rKaspi)}</span></div><div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rOnline)}</span></div>${kaspiRet>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ROSTA)</span><span class="row-value" style="color:#E24B4A">-'+fmt(kaspiRet)+'</span></div>':''}<div class="row"><span class="row-label" style="font-weight:600">Чистый ROSTA</span><span class="row-value" style="font-weight:600">${fmt(kaspiRostaNet)}</span></div><div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tKaspi)}</span></div>${(s.tKaspiRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат терминал</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tKaspiRet)+'</span></div>':''}<div class="row-total"><span>Разница (ФАКТ − ROSTA)</span><span style="color:${dColor(kaspiDiffHtml)}">${dSign(kaspiDiffHtml)}${fmt(kaspiDiffHtml)}</span></div></div>
<div class="card"><div class="card-title"><div class="dot" style="background:#7F77DD"></div>Halyk</div><div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rHalyk)}</span></div><div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rHalykOnline)}</span></div>${halykRet>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ROSTA)</span><span class="row-value" style="color:#E24B4A">-'+fmt(halykRet)+'</span></div>':''}<div class="row"><span class="row-label" style="font-weight:600">Чистый ROSTA</span><span class="row-value" style="font-weight:600">${fmt(halykRostaNet)}</span></div><div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tHalyk)}</span></div>${(s.tHalykRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат терминал</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tHalykRet)+'</span></div>':''}<div class="row-total"><span>Разница (ФАКТ − ROSTA)</span><span style="color:${dColor(halykDiffHtml)}">${dSign(halykDiffHtml)}${fmt(halykDiffHtml)}</span></div></div>
<div class="card"><div class="card-title"><div class="dot" style="background:#1D9E75"></div>Прочие</div><div class="row"><span class="row-label">Наличные</span><span class="row-value">${fmt(s.rCash)}</span></div>${(s.rPersonal||0)>0?'<div class="row"><span class="row-label">Личная карта</span><span class="row-value">'+fmt(s.rPersonal)+'</span></div>':''}<div class="row-total"><span>Итого</span><span>${fmt((s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0))}</span></div></div>
</div>
<div class="sec">Касса и сверка</div>
<div class="grid2">
<div class="card"><div class="card-title">💵 Касса</div><div class="row"><span class="row-label">Открытие</span><span class="row-value">${fmt(s.cashOpen)}</span></div><div class="row"><span class="row-label">Закрытие (факт)</span><span class="row-value">${fmt(s.cashActual)}</span></div><div class="row"><span class="row-label">Продажи нал (ROSTA)</span><span class="row-value">${fmt(cashSalesGross)}</span></div>${(s.inkasso||0)>0?'<div class="row"><span class="row-label">Инкассация</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.inkasso)+'</span></div>':''}${(s.cashPayouts||0)>0?'<div class="row"><span class="row-label">Выплаты из кассы</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.cashPayouts)+'</span></div>':''}<div class="row"><span class="row-label">Ожидалось в кассе</span><span class="row-value">${fmt(cashExpectedHtml)}</span></div>${(s.cashActual||0)>0?'<div class="row"><span class="row-label">Факт в кассе</span><span class="row-value" style="color:'+( Math.abs((s.cashActual||0)-cashExpectedHtml)>500 ? "#E24B4A":"#1D9E75")+'">'+fmt(s.cashActual||0)+'</span></div>':''}<div class="row-total"><span>Расхождение кассы</span><span style="color:${Math.abs((s.cashActual||0)-cashExpectedHtml)>500?'#E24B4A':'#1D9E75'}">${((s.cashActual||0)-cashExpectedHtml)>0?'+':''}${fmt((s.cashActual||0)-cashExpectedHtml)}</span></div></div>
<div class="card"><div class="card-title">🔍 Сверка</div><div class="row"><span class="row-label">ROSTA</span><span class="row-value">${fmt(rostaTotal)}</span></div><div class="row"><span class="row-label">ФАКТ</span><span class="row-value">${fmt(factTotal)}</span></div><div class="row"><span class="row-label">Разница</span><span class="row-value" style="color:${diffColor};font-weight:600;">${diffSign}${fmt(diff)}</span></div></div>
</div>
<div class="grid3">${channelStatus}</div>
<div style="font-size:11px;color:#aaa;text-align:center;margin-top:4px;">Подпись продавца: ${sellerName} <span style="display:inline-block;width:120px;border-bottom:1px solid #ccc;margin-left:8px;"></span></div>
</div></body></html>`;
}

async function generateDashboardHTML() {
  try {
    const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const curMonth = nowAlm.getMonth()+1, curYear = nowAlm.getFullYear();
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const salesData = await dbGetSales(curMonth, curYear);
    const sellerSales = { 'Асель':0, 'Зарина':0, 'Луиза':0 };
    let totalFact = 0;
    salesData.forEach(s => {
      const rev = Number(s.revenue||0);
      totalFact += rev;
      const sellers = [s.seller1,s.seller2].filter(Boolean);
      if (sellers.length > 0) { const share = rev/sellers.length; sellers.forEach(name => { if (sellerSales[name]!==undefined) sellerSales[name]+=share; }); }
    });
    const plan = PLAN_TOTAL;
    const personalPlans = { 'Асель':8550000, 'Зарина':10350000, 'Луиза':8100000 };
    const salaryCalc = await calcSalary(curMonth, curYear);
    const sc = salaryCalc ? salaryCalc.sellers : {};
    const totalFot = salaryCalc ? salaryCalc.totalFot : 0;
    const fmt = n => Math.round(Number(n||0)).toLocaleString('ru-RU');
    const totalPct = Math.round(totalFact/plan*100);
    const sellers = ['Асель','Зарина','Луиза'];
    const sellerRows = sellers.map(name => {
      const fact = Math.round(sellerSales[name]||0);
      const pl = personalPlans[name]||0;
      const pct = pl>0 ? Math.round(fact/pl*100) : 0;
      const left = Math.max(0,pl-fact);
      const s = sc[name]||{};
      return { name, fact, plan: pl, pct, left, total: s.total||0, ke: s.ke||0, procent: s.pct||0 };
    });
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NANÉ PARIS Дашборд</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0ede8;padding:16px}.c{max-width:680px;margin:0 auto}.brand{font-size:20px;font-weight:700;letter-spacing:.07em}.sub{font-size:11px;color:#888;text-transform:uppercase;margin-top:2px}.sec{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.1em;margin:16px 0 8px}.card{background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;margin-bottom:10px}.kl{font-size:11px;color:#999}.kv{font-size:22px;font-weight:700}.ks{font-size:12px;color:#aaa;margin-top:3px}.pb{background:#ebe8e2;border-radius:20px;height:7px;overflow:hidden;margin:8px 0 4px}.pf{height:7px;border-radius:20px}.row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid #f5f5f0}.row:last-child{border:none}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}</style></head><body><div class="c">
<div style="margin-bottom:18px;"><div class="brand">NANÉ PARIS</div><div class="sub">Дашборд · ${monthNames[curMonth]} ${curYear}</div><div style="font-size:11px;color:#aaa;margin-top:2px;">Обновлено: ${getNow()}</div></div>
<div class="sec">Продавцы — план</div>
${sellerRows.map(s => `<div class="card"><div style="display:flex;justify-content:space-between;"><div style="font-size:14px;font-weight:600;">${s.name}</div><div style="font-size:18px;font-weight:700;color:${s.pct>=100?'#1a8a5a':s.pct>=80?'#b06a10':'#c0392b'}">${s.pct}%</div></div><div style="font-size:12px;color:#999;margin:2px 0 8px;">${fmt(s.fact)} ₸ из ${fmt(s.plan)} ₸</div><div class="pb"><div class="pf" style="width:${Math.min(s.pct,100)}%;background:${s.pct>=100?'#27ae60':s.pct>=80?'#e67e22':'#e74c3c'}"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;"><div style="background:#f7f4ef;border-radius:8px;padding:8px;"><div style="font-size:10px;color:#aaa;">Осталось</div><div style="font-size:13px;font-weight:500;">${fmt(s.left)} ₸</div></div></div></div>`).join('')}
<div class="sec">Магазин</div>
<div class="grid2"><div class="card"><div class="kl">Оборот (факт)</div><div class="kv">${fmt(totalFact)} ₸</div><div class="ks">из ${fmt(plan)} ₸</div></div><div class="card"><div class="kl">Выполнение плана</div><div class="kv" style="color:${totalPct>=100?'#1a8a5a':totalPct>=80?'#b06a10':'#c0392b'}">${totalPct}%</div></div></div>
<div class="card"><div class="kl">Прогресс к плану</div><div class="pb"><div class="pf" style="width:${Math.min(totalPct,100)}%;background:${totalPct>=100?'#27ae60':totalPct>=80?'#e67e22':'#e74c3c'}"></div></div></div>
<div class="card"><div class="kl">ФОТ к выплате</div><div class="kv">${fmt(totalFot)} ₸</div></div>
</div></body></html>`;
  } catch(e) { console.error('generateDashboardHTML error:', e.message); return null; }
}

async function generateFullReport(userId, month, year) {
  try {
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const mName = monthNames[month] || month;
    const fmt = n => { n = Math.round(n||0); if (n===0) return '—'; return n.toLocaleString('ru-RU'); };
    const fmtZ = n => Math.round(n||0).toLocaleString('ru-RU'); // fmt without dash for zeros

    const [sales, expenses, kpiData] = await Promise.all([
      dbGetSales(month, year),
      dbGetExpenses(month, year, false, userId),
      getKPI(month, year)
    ]);
    if (!sales || sales.length === 0) { await sendTelegram(userId, '📊 Нет данных за ' + mName + ' ' + year); return; }

    const KE=14000, TAX=0.03, BONUS_PLAN=30000, KPI_ONE=25000;
    const getPct = r => r>=1000000?0.027:r>=750000?0.022:r>=500000?0.017:0.012;
    const plans = SELLER_PLANS;
    const sellers = ['Асель','Зарина','Луиза'];
    const COLORS = {
      'Асель': {bg:'#fdf0ec',tx:'#a03020',hd:'#c87060',css:'ca'},
      'Зарина': {bg:'#ecf5f0',tx:'#1a6040',hd:'#5a8e70',css:'cz'},
      'Луиза':  {bg:'#f0ecf8',tx:'#402880',hd:'#7060a8',css:'cl'}
    };

    const selD = {};
    sellers.forEach(s => { selD[s] = {shifts:0, sales:0, pct:0, bonusGood:0, bonusRec:0}; });
    let totalRev=0, totalProfit=0, totalTax=0;

    // Построчные данные по дням
    const dayRows = sales.map((s, i) => {
      const rev = Number(s.revenue||0);
      const profit = Number(s.rosta_profit||0);
      const tax = Math.round(rev * TAX);
      totalRev += rev; totalProfit += profit; totalTax += tax;
      const dS = [s.seller1, s.seller2].filter(b => b && sellers.includes(b));
      const dayPct = rev * getPct(rev);
      let dayFot = 0;
      let af=0, ap=0, zf=0, zp=0, lf=0, lp=0;
      dS.forEach(name => {
        selD[name].shifts++;
        selD[name].sales += rev / dS.length;
        selD[name].pct += dayPct;
        dayFot += KE + dayPct;
        if (rev >= 2000000) { selD[name].bonusRec += 40000; dayFot += 40000; }
        else if (rev >= 700000) { selD[name].bonusGood += 5000; dayFot += 5000; }
        if (name === 'Асель')  { af = KE; ap = Math.round(dayPct); }
        if (name === 'Зарина') { zf = KE; zp = Math.round(dayPct); }
        if (name === 'Луиза')  { lf = KE; lp = Math.round(dayPct); }
      });
      const d = s.sale_date ? s.sale_date.slice(8,10)+'.'+s.sale_date.slice(5,7) : '?';
      const type = rev>=2000000?'str':rev>=700000?'good':'';
      const C1 = COLORS[s.seller1]; const C2 = COLORS[s.seller2];
      const st1 = C1?'background:'+C1.bg+';color:'+C1.tx+';font-weight:700':'';
      const st2 = C2?'background:'+C2.bg+';color:'+C2.tx+';font-weight:700':'';
      return {i,d,rev,profit,tax,dayFot:Math.round(dayFot),s1:s.seller1||'—',s2:s.seller2||'—',
        pctRate:(getPct(rev)*100).toFixed(1)+'%',type,af,ap,zf,zp,lf,lp,st1,st2,
        C1,C2};
    });

    // Зарплата
    let totalFot = 0;
    const salRows = sellers.map(name => {
      const sd = selD[name];
      if (sd.shifts === 0) return null;
      const ke = sd.shifts * KE;
      const pct = Math.round(sd.pct);
      const bonusPlan = sd.sales >= (plans[name]||0) ? BONUS_PLAN : 0;
      const kpi = (kpiData[name] !== undefined ? kpiData[name] : 3) * KPI_ONE;
      const total = ke + pct + sd.bonusGood + sd.bonusRec + bonusPlan + kpi;
      totalFot += total;
      return {name, shifts:sd.shifts, ke, pct, bonusGood:sd.bonusGood, bonusRec:sd.bonusRec,
        bonusPlan, kpi, total, planDone:sd.sales>=(plans[name]||0), salesAmt:Math.round(sd.sales)};
    }).filter(Boolean);

    const expTotal = expenses.reduce((s,e) => s + Number(e.amount||0), 0);
    const netProfit = totalProfit > 0 ? totalProfit - totalTax - totalFot : 0;
    const fotPct = totalRev > 0 ? (totalFot/totalRev*100).toFixed(1) : '0';
    const planTotal = PLAN_TOTAL;
    const dt = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'});

    // ── CSS ──
    const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;background:#f5f0eb;color:#1a1a1a}
.hdr{background:#1a1a1a;color:white;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
.tabs{display:flex;background:#ebe5dd;border-bottom:2px solid #d5cfc7;padding:0 12px;overflow-x:auto;gap:0}
.tab{padding:9px 14px;cursor:pointer;font-size:10px;font-weight:700;color:#8a847c;border-bottom:3px solid transparent;margin-bottom:-2px;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em}
.tab.on{color:#1a1a1a;border-bottom-color:#c8a97a}
.pane{display:none;padding:16px;background:white}.pane.on{display:block}
.kards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.kard{background:#f5f0eb;border:1px solid #d5cfc7;border-radius:8px;padding:12px 14px}
.kl{font-size:9px;color:#8a847c;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
.kv{font-size:18px;font-weight:700;line-height:1.2}.ks{font-size:10px;color:#8a847c;margin-top:3px}
.pb{background:#e8e2da;border-radius:2px;height:5px;margin-top:7px}.pf{height:100%;border-radius:2px}
.sellers{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.seller{background:white;border:1px solid #d5cfc7;border-radius:8px;overflow:hidden}
.sh{padding:10px 14px;color:white;display:flex;justify-content:space-between;align-items:center}
.sb{padding:10px 14px}.sr{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0ece6;font-size:11px}
.sr:last-child{border:0;font-weight:700;font-size:12px;margin-top:4px}
.tw{overflow-x:auto;margin-bottom:16px}
table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:11px;border:1.5px solid #aaa}
th{background:#1a1a1a;color:white;padding:7px 8px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border:1px solid #333}
th.l{text-align:left}td{padding:5px 8px;border:1px solid #ccc;text-align:right;vertical-align:middle}
td.l{text-align:left}td.c{text-align:center}tr:hover td{filter:brightness(0.97)}
tr.good{background:#eef5ee}tr.str{background:#fff8e8}tr.tot{background:#1a1a1a;color:white;font-weight:700}tr.tot td{border-color:#333}
.ga{background:#c87060;color:white;border:1px solid #a05040;text-align:center;font-size:10px;font-weight:700;padding:4px}
.gz{background:#5a8e70;color:white;border:1px solid #3a6e50;text-align:center;font-size:10px;font-weight:700;padding:4px}
.gl{background:#7060a8;color:white;border:1px solid #5040a0;text-align:center;font-size:10px;font-weight:700;padding:4px}
.gf{background:#1a5080;color:white;border:1px solid #0a3060;text-align:center;font-size:10px;font-weight:700;padding:4px}
.gn{background:#2a2a2a;color:white;border:1px solid #444;text-align:center;font-size:10px;font-weight:700;padding:4px}
.ca{background:#fdf0ec}.cz{background:#ecf5f0}.cl{background:#f0ecf8}
.sec{font-size:12px;font-weight:700;color:#1a1a1a;margin:20px 0 10px;padding-bottom:6px;border-bottom:2px solid #c8a97a;text-transform:uppercase;letter-spacing:.06em}
.note{background:#fff8e8;border:1px solid #e8d5a0;border-radius:6px;padding:10px 14px;font-size:11px;color:#6b5500;margin-top:12px}
@media(max-width:600px){.sellers{grid-template-columns:1fr}.kards{grid-template-columns:repeat(2,1fr)}}`;

    // ── ВКЛАДКА 1: ДАШБОРД ──
    let dash = '<div class="sec">Продавцы — прогресс к личному плану</div><div class="sellers">';
    sellers.forEach(name => {
      const sd = selD[name]; if (sd.shifts === 0) return;
      const C = COLORS[name];
      const p = plans[name]||0;
      const pct = p > 0 ? sd.sales/p*100 : 0;
      const salRow = salRows.find(r => r.name === name) || {};
      dash += `<div class="seller"><div class="sh" style="background:${C.hd}"><div style="font-size:13px;font-weight:700">${name}</div><div style="font-size:14px;font-weight:700">${pct.toFixed(0)}%</div></div>
<div class="sb"><div class="sr"><span>Смен</span><span><b>${sd.shifts}</b></span></div>
<div class="sr"><span>Оборот</span><span>${fmtZ(sd.sales)} тг</span></div>
<div class="sr"><span>До плана</span><span style="color:${pct>=100?'#2e7d32':'#c62828'}">${fmtZ(Math.max(0,p-sd.sales))} тг</span></div>
<div class="pb" style="margin:8px 0 4px"><div class="pf" style="width:${Math.min(100,pct).toFixed(0)}%;background:${pct>=100?'#2e7d32':'#c8a97a'}"></div></div>
<div class="sr" style="margin-top:8px;border-top:1px solid #ebe8e2;padding-top:6px"></div></div></div>`;
    });
    dash += `</div><div class="sec">Итоги магазина</div><div class="kards">
<div class="kard"><div class="kl">Оборот (факт)</div><div class="kv">${fmtZ(totalRev)} тг</div><div class="ks">план ${fmtZ(planTotal)} тг</div><div class="pb"><div class="pf" style="width:${Math.min(100,totalRev/planTotal*100).toFixed(0)}%;background:#c8a97a"></div></div></div>
<div class="kard"><div class="kl">Выполнение</div><div class="kv" style="color:${totalRev>=planTotal?'#2e7d32':'#c62828'}">${(totalRev/planTotal*100).toFixed(1)}%</div></div>
<div class="kard"><div class="kl">Дней продаж</div><div class="kv">${sales.length}</div></div>
<div class="kard"><div class="kl">ФОТ итого</div><div class="kv">${fmtZ(totalFot)} тг</div><div class="ks">${fotPct}% от оборота</div></div>
<div class="kard"><div class="kl">Налог 3%</div><div class="kv">${fmtZ(totalTax)} тг</div></div>
${totalProfit>0?'<div class="kard"><div class="kl">Прибыль ROSTA</div><div class="kv">'+fmtZ(totalProfit)+' тг</div></div><div class="kard"><div class="kl">Чистая прибыль</div><div class="kv" style="color:#2e7d32">'+fmtZ(netProfit)+' тг</div></div>':''}
</div>`;

    // ── ВКЛАДКА 2: ПО ДНЯМ ──
    let sAF=0,sAP=0,sZF=0,sZP=0,sLF=0,sLP=0,sTotalFot=0;
    let dRows = dayRows.map(d => {
      sAF+=d.af; sAP+=d.ap; sZF+=d.zf; sZP+=d.zp; sLF+=d.lf; sLP+=d.lp; sTotalFot+=d.dayFot;
      return `<tr class="${d.type}"><td class="c">${d.i+1}</td><td class="l">${d.d}</td><td><b>${fmtZ(d.rev)}</b></td>
<td class="l" style="${d.st1}">${d.s1}</td><td class="l" style="${d.st2}">${d.s2}</td>
<td class="c"><b>${d.pctRate}</b></td>
<td class="ca">${d.af?fmtZ(d.af):'—'}</td><td class="ca">${d.ap?fmtZ(d.ap):'—'}</td>
<td class="cz">${d.zf?fmtZ(d.zf):'—'}</td><td class="cz">${d.zp?fmtZ(d.zp):'—'}</td>
<td class="cl">${d.lf?fmtZ(d.lf):'—'}</td><td class="cl">${d.lp?fmtZ(d.lp):'—'}</td>
<td><b>${fmtZ(d.dayFot)}</b></td><td>${d.profit>0?fmtZ(d.profit):'—'}</td>
<td>${fmtZ(d.tax)}</td><td class="c"><b>${(d.dayFot/Math.max(d.rev,1)*100).toFixed(1)}%</b></td></tr>`;
    }).join('');
    console.log('generateFullReport: dayRows count:', dayRows.length, 'salRows:', salRows.length, 'expenses:', expenses.length);
    const dHtml = `<div class="tw"><table><thead>
<tr><th colspan="2" class="gn l">Смена</th><th class="gn">Оборот</th><th colspan="3" class="gn">Расчёт</th><th colspan="2" class="ga">Асель</th><th colspan="2" class="gz">Зарина</th><th colspan="2" class="gl">Луиза</th><th colspan="4" class="gf">Финансы</th></tr>
<tr><th>#</th><th class="l">Дата</th><th>Оборот (тг)</th><th class="l">Продавец 1</th><th class="l">Продавец 2</th><th>% ставка</th>
<th style="background:#c87060">Фикс</th><th style="background:#c87060">%</th>
<th style="background:#5a8e70">Фикс</th><th style="background:#5a8e70">%</th>
<th style="background:#7060a8">Фикс</th><th style="background:#7060a8">%</th>
<th>ФОТ день</th><th>Прибыль</th><th>Налог</th><th>ФОТ %</th></tr></thead>
<tbody>${dRows}
<tr class="tot"><td></td><td class="l">ИТОГО</td><td>${fmtZ(totalRev)}</td><td></td><td></td><td class="c">${fotPct}%</td>
<td>${fmtZ(sAF)}</td><td>${fmtZ(sAP)}</td><td>${fmtZ(sZF)}</td><td>${fmtZ(sZP)}</td><td>${fmtZ(sLF)}</td><td>${fmtZ(sLP)}</td>
<td>${fmtZ(sTotalFot)}</td><td>${totalProfit>0?fmtZ(totalProfit):'—'}</td><td>${fmtZ(totalTax)}</td><td class="c">${fotPct}%</td></tr>
</tbody></table></div>`;

    // ── ВКЛАДКА 3: ИТОГИ / ЗАРПЛАТА ──
    const salaryRows = salRows.map(r => {
      const C = COLORS[r.name] || {css:'',tx:'#333'};
      return `<tr><td class="l ${C.css}"><b style="color:${C.tx}">${r.name}</b> (${r.shifts} смен)</td>
<td class="${C.css}">${fmtZ(r.ke)}</td><td class="${C.css}">${fmtZ(r.pct)}</td>
<td class="${C.css}">${r.bonusGood?fmtZ(r.bonusGood):'—'}</td>
<td class="${C.css}">${r.bonusRec?fmtZ(r.bonusRec):'—'}</td>
<td class="${C.css}">${r.planDone?'✅ '+fmtZ(r.bonusPlan):'❌ нет'}</td>
<td class="${C.css}">${fmtZ(r.kpi)}</td>
<td class="${C.css}"><b style="color:#2e7d32">${fmtZ(r.total)}</b></td></tr>`;
    }).join('');
    const iHtml = `<div class="kards">
<div class="kard"><div class="kl">Оборот</div><div class="kv">${fmtZ(totalRev)} тг</div></div>
<div class="kard"><div class="kl">ФОТ итого</div><div class="kv">${fmtZ(totalFot)} тг</div><div class="ks">${fotPct}%</div></div>
<div class="kard"><div class="kl">Налог 3%</div><div class="kv">${fmtZ(totalTax)} тг</div></div>
${totalProfit>0?'<div class="kard"><div class="kl">Прибыль ROSTA</div><div class="kv">'+fmtZ(totalProfit)+' тг</div></div><div class="kard"><div class="kl">Чистая</div><div class="kv" style="color:#2e7d32">'+fmtZ(netProfit)+' тг</div></div>':''}
</div>
<div class="sec">Выплаты продавцам</div>
<div class="tw"><table><thead><tr>
<th class="l">Продавец</th><th>КЕ (фикс)</th><th>% продаж</th><th>Бонус день</th><th>Рекорд</th><th>Бонус план</th><th>KPI</th><th>ИТОГО</th>
</tr></thead><tbody>${salaryRows}
<tr class="tot"><td class="l">ИТОГО ФОТ</td><td colspan="6"></td><td>${fmtZ(totalFot)}</td></tr>
</tbody></table></div>`;

    // ── ВКЛАДКА 4: РАСХОДЫ ──
    let eHtml = '';
    if (expenses.length > 0) {
      const expRows = expenses.map(e => `<tr><td class="l">${e.expense_date||'—'}</td><td class="l">${e.category||'—'}</td><td>${fmtZ(e.amount)}</td><td class="l">${e.description||'—'}</td></tr>`).join('');
      eHtml = `<div class="kards"><div class="kard"><div class="kl">Всего расходов</div><div class="kv">${fmtZ(expTotal)} тг</div></div><div class="kard"><div class="kl">Позиций</div><div class="kv">${expenses.length}</div></div></div>
<div class="tw"><table><thead><tr><th class="l">Дата</th><th class="l">Категория</th><th>Сумма</th><th class="l">Описание</th></tr></thead>
<tbody>${expRows}<tr class="tot"><td colspan="2" class="l">Итого</td><td>${fmtZ(expTotal)}</td><td></td></tr></tbody></table></div>`;
    } else {
      eHtml = '<p style="color:#8a847c;padding:20px;text-align:center">Расходов за ' + mName + ' ' + year + ' нет</p>';
    }

    // ── ВКЛАДКА 5: ФИНАНСЫ ──
    const finRows = dayRows.map(d => `<tr><td class="l">${d.d}</td><td>${fmtZ(d.rev)}</td><td>${d.profit>0?fmtZ(d.profit):'—'}</td><td>${fmtZ(d.tax)}</td><td>${fmtZ(d.dayFot)}</td><td>${d.profit>0?fmtZ(d.profit-d.dayFot-d.tax):'—'}</td><td class="c">${(d.dayFot/Math.max(d.rev,1)*100).toFixed(1)}%</td></tr>`).join('');
    let fHtml = `<div class="tw"><table><thead><tr>
<th class="l">Дата</th><th>Оборот</th><th>Прибыль ROSTA</th><th>Налог 3%</th><th>ФОТ день</th><th>Приб−ФОТ−нал</th><th>ФОТ %</th>
</tr></thead><tbody>${finRows}
<tr class="tot"><td class="l">ИТОГО</td><td>${fmtZ(totalRev)}</td><td>${totalProfit>0?fmtZ(totalProfit):'—'}</td><td>${fmtZ(totalTax)}</td><td>${fmtZ(totalFot)}</td><td>${totalProfit>0?fmtZ(netProfit):'—'}</td><td class="c">${fotPct}%</td></tr>
</tbody></table></div>`;
    if (!totalProfit) { fHtml += '<div class="note">Введи прибыль ROSTA командой: «Прибыль [дата] [сумма]»</div>'; }

    // ── ВКЛАДКА 6: ШПАРГАЛКА ──
    const shp = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
<div><div class="sec">Шкала % от оборота смены</div>
<div class="tw"><table><thead><tr><th class="l">Оборот смены</th><th>% каждому</th></tr></thead>
<tbody><tr><td class="l">до 500 000 тг</td><td class="c"><b>1,2%</b></td></tr>
<tr><td class="l">500 000 – 750 000</td><td class="c"><b>1,7%</b></td></tr>
<tr><td class="l">750 000 – 1 000 000</td><td class="c"><b>2,2%</b></td></tr>
<tr><td class="l">от 1 000 000</td><td class="c"><b>2,7%</b></td></tr>
</tbody></table></div></div>
<div><div class="sec">Бонусы</div>
<div class="tw"><table><thead><tr><th class="l">Оборот</th><th>Бонус</th></tr></thead>
<tbody><tr><td class="l">≥ 700 000 тг</td><td>+5 000 тг</td></tr>
<tr><td class="l">≥ 2 000 000 тг</td><td>+40 000 тг</td></tr>
<tr><td class="l">Выполнение личного плана</td><td>+30 000 тг</td></tr>
</tbody></table></div>
<div class="note" style="margin-top:10px">КЕ = 14 000 тг/смена<br>Налог = 3% от оборота<br>KPI = 25 000 × 3 = 75 000 тг макс</div></div></div>`;

    // ── СБОРКА HTML ──
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NANE PARIS ${mName} ${year}</title><style>${css}</style></head><body>
<div class="hdr"><div><div style="font-size:18px;font-weight:700;letter-spacing:.1em">NANE PARIS</div><div style="font-size:10px;opacity:.5">${mName} ${year}</div></div><div style="font-size:10px;opacity:.4">Астана · ${dt}</div></div>
<div class="tabs">
<div class="tab on" onclick="sw('dash',this)">📊 Дашборд</div>
<div class="tab" onclick="sw('days',this)">📅 По дням</div>
<div class="tab" onclick="sw('itogi',this)">💰 Зарплата</div>
<div class="tab" onclick="sw('exp',this)">💸 Расходы</div>
<div class="tab" onclick="sw('fin',this)">📈 Финансы</div>
<div class="tab" onclick="sw('shp',this)">📌 Шпаргалка</div>
</div>
<div id="tab-dash" class="pane on">${dash}</div>
<div id="tab-days" class="pane">${dHtml}</div>
<div id="tab-itogi" class="pane">${iHtml}</div>
<div id="tab-exp" class="pane">${eHtml}</div>
<div id="tab-fin" class="pane">${fHtml}</div>
<div id="tab-shp" class="pane">${shp}</div>
<script>function sw(id,el){document.querySelectorAll('.pane').forEach(p=>p.classList.remove('on'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));document.getElementById('tab-'+id).classList.add('on');el.classList.add('on');}</script>
</body></html>`;

    const filename = 'otchet_' + mName.toLowerCase() + '_' + year + '.html';
    await sendTelegramDocument(userId, filename, html, '📊 Отчёт ' + mName + ' ' + year + ' — открой в браузере');
  } catch(e) { console.error('generateFullReport error:', e.message); await sendTelegram(userId, '❌ Ошибка: ' + e.message); }
}

function startDailyScheduler() {
  setInterval(() => { checkReminders(); }, 60000);
  setInterval(() => {
    const now = new Date();
    const almatyTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const hours = almatyTime.getHours();
    const minutes = almatyTime.getMinutes();
    if (hours === 9 && minutes === 0) {
      const todayKey = almatyTime.toDateString();
      if (startDailyScheduler.lastRun !== todayKey) {
        startDailyScheduler.lastRun = todayKey;
        sendMorningDigest();
        if (almatyTime.getDay() === 1) { sendWeeklyTraining(false); sendWeeklySalesReport(); }
        if (almatyTime.getDay() === 5) { sendWeeklyTraining(false); }
      }
    }
  }, 30000);
  console.log('Планировщик запущен — дайджест каждый день в 09:00');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Томи Telegram v4.4 запущена на порту ' + PORT);
  await restoreOpenShifts();
  startDailyScheduler();
  scheduleRandomQuestions();
  const webhookUrl = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/webhook';
  const body = JSON.stringify({ url: webhookUrl });
  https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/setWebhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => console.log('Webhook установлен:', data)); }).end(body);
});
