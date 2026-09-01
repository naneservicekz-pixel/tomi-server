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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ushpahkehvrfcqnbnpmu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
const pendingExpense = {};
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
    const KE_MAP = { 'Зарина': 14000, 'Далира': 10000 };
    const TAX_PCT = 0.03;
    const BONUS_PLAN = 30000;
    const KPI_ONE = 25000;
    const personalPlans = { 'Зарина': 13500000, 'Далира': 13500000 };
    const getPct = (amount) => {
      if (amount >= 1000000) return 0.027;
      if (amount >= 750000)  return 0.022;
      if (amount >= 500000)  return 0.017;
      return 0.012;
    };
    const kpiScores = await getKPI(month, year);
    const sellers = ['Зарина', 'Далира'];
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
      const ke = d.shifts * (KE_MAP[s] || 14000);
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

async function loadConversation(userId) {
  try {
    const { data } = await supabase.from('conversations').select('role, content').eq('phone', String(userId)).order('created_at', { ascending: true }).limit(40);
    if (!data || data.length === 0) return [];
    return data.map(r => ({ role: r.role, content: r.content }));
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
  let prompt = photoType === 'zreport'
    ? 'Это Z-отчет из ROSTA. Верни ТОЛЬКО JSON без пояснений:\n{"kaspi_qr":0,"online_kaspi":0,"halyk_qr":0,"online_halyk":0,"cash":0,"personal":0,"bonus":0,"ret_kaspi_qr":0,"ret_online_kaspi":0,"ret_halyk_qr":0,"ret_online_halyk":0,"ret_cash":0,"ret_personal":0}\nВАЖНО:\n- ret_kaspi_qr = возврат "Kaspi QR (Возврат)"\n- ret_online_kaspi = возврат "Онлайн Каспи (Возврат)"\n- ret_halyk_qr = возврат "Halyk QR (Возврат)"\n- ret_online_halyk = возврат "Онлайн Халык (Возврат)"\n- ret_cash = возврат "Наличные (Возврат)"\n- ret_personal = возврат "Личная карта (Возврат)"\n- Все значения ПОЛОЖИТЕЛЬНЫЕ (знак минус НЕ ставить). Проверь: сумма продаж минус все возвраты должна совпасть с ИТОГО Z-отчёта.'
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
  return response.content[0].text;
}

// ══════════════════════════════════════════════════════════════════════
// ИСПРАВЛЕНО v4.4: сохранение фото строго по порядку прихода
// Фото 1 = Z-отчёт ROSTA
// Фото 2 = Kaspi терминал
// Фото 3 = Halyk терминал
// ══════════════════════════════════════════════════════════════════════

function savePhotoByOrder(userId, photoFileId) {
  if (!shiftPhotos[String(userId)]) shiftPhotos[String(userId)] = {};
  const photos = shiftPhotos[String(userId)];
  let savedAs = '';
  if (!photos.zreport) {
    photos.zreport = photoFileId;
    savedAs = 'zreport (фото 1)';
  } else if (!photos.kaspi) {
    photos.kaspi = photoFileId;
    savedAs = 'kaspi (фото 2)';
  } else if (!photos.halyk) {
    photos.halyk = photoFileId;
    savedAs = 'halyk (фото 3)';
  } else {
    photos.extra = photoFileId;
    savedAs = 'extra (фото 4+)';
  }
  console.log('Photo saved as:', savedAs, 'for user:', userId, '| shiftPhotos:', JSON.stringify(photos));
  return savedAs;
}

function getPhotoTypeByOrder(userId) {
  const photos = shiftPhotos[String(userId)] || {};
  if (!photos.zreport) return 'zreport';
  if (!photos.kaspi) return 'kaspi_terminal';
  return 'halyk_terminal';
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
    'ЗАКРЫТИЕ СМЕНЫ — СТРОГИЙ ПОРЯДОК ФОТО (КРИТИЧЕСКИ ВАЖНО):\n' +
    'Фото запрашивай СТРОГО по одному, в этом порядке:\n\n' +
    'ШАГ 1 — Z-ОТЧЕТ ROSTA:\nСкажи: "Пришли фото Z-отчёта ROSTA (первое фото)."\n' +
    'ЖДИ фото. Когда получила — читай данные:\n' +
    '- "Kaspi QR" → rKaspi, "Онлайн Каспи" → rOnline\n' +
    '- "Halyk QR" → rHalyk, "Онлайн Халык" → rHalykOnline\n' +
    '- "Наличные" → rCash\n' +
    '- Возвраты: "Kaspi QR" → rRetKaspi, "Онлайн Каспи" → rRetOnlineKaspi\n' +
    '- Возвраты: "Halyk QR" → rRetHalyk, "Онлайн Халык" → rRetHalykOnline\n' +
    '- Возвраты: "Наличные" → rRetCash, "Личная карта" → rRetPersonal\n' +
    '- rostaCheck = строка ИТОГО из Z-отчёта\n\n' +
    'ШАГ 2 — KASPI ТЕРМИНАЛ:\nСкажи: "Теперь пришли фото отчёта Kaspi терминала (второе фото)."\n' +
    'ЖДИ фото. Когда получила — сравни с ROSTA. Расхождение >500 тг — СТОП, спроси причину.\n\n' +
    'ШАГ 3 — HALYK ТЕРМИНАЛ:\nСкажи: "Теперь пришли фото отчёта Halyk терминала (третье фото)."\n' +
    'ЖДИ фото. Когда получила — сравни с ROSTA. Расхождение >500 тг — СТОП, спроси причину.\n\n' +
    'ВАЖНО: НЕ проси два фото сразу. Каждое фото — отдельным сообщением после получения предыдущего.\n' +
    'ВАЖНО: НЕ называй фото "второе фото Halyk" или "ещё одно фото" — только Z-отчёт, Kaspi, Halyk.\n\n' +
    'ШАГ 4 — НАЛИЧНЫЕ: спроси "Сколько наличных в кассе сейчас? Пересчитай." Запомни как cashActual.\n' +
    '  (Томи сравнит с: открытие + продажи нал из ROSTA − инкассация)\n' +
    'ШАГ 5 — ЛИЧНАЯ КАРТА. ШАГ 6 — ИНКАССАЦИЯ.\n' +
    'ШАГ 7 — ЗАЛ. ШАГ 8 — ГОСТЕВАЯ.\n' +
    'ШАГ 9 — ГЕОЛОКАЦИЯ: после геолокации выдай SHIFT_CLOSE.\n' +
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

async function handleSystemCommands(reply, userId, sellerName, messageText) {
  let cleanReply = reply;

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
      const jsonStr = reply.match(/SHIFT_OPEN:(\{.*?\})/s)?.[1];
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
      const jsonStr = reply.match(/SHIFT_CLOSE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);
        const shift = openShifts[String(userId)] || await loadOpenShift(userId) || {};
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
        // cashSales = продажи наличными из ROSTA (источник истины)
        const cashSales = (s.rCash||0) - (s.rRetCash||0);
        
        // СВЕРКА КАССЫ: cashOpen + rCash = ожидаемый остаток в кассе
        // cashActual = сколько продавец физически пересчитал
        // Если есть инкассация — вычитаем её из ожидаемого
        const cashExpected = (s.cashOpen||0) + (s.rCash||0) - (s.rRetCash||0) - (s.inkasso||0);
        const cashActualVal = s.cashActual || 0;
        const cashBoxDiff = cashActualVal - cashExpected;
        if (Math.abs(cashBoxDiff) > 500) {
          const sign = cashBoxDiff > 0 ? '+' : '';
          const dir = cashBoxDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
          for (const ownerId of OWNER_IDS) {
            await sendTelegram(ownerId, '💰 РАСХОЖДЕНИЕ КАССЫ при закрытии!\n👤 ' + (shift.seller||sellerName) + '\n💰 Ожидалось: ' + Number(cashExpected).toLocaleString('ru-RU') + ' тг\n   (открытие ' + Number(s.cashOpen||0).toLocaleString() + ' + продажи ' + Number(cashSales).toLocaleString() + ' − инкассация ' + Number(s.inkasso||0).toLocaleString() + ')\n💰 Факт в кассе: ' + Number(cashActualVal).toLocaleString('ru-RU') + ' тг\n❌ ' + dir + ': ' + sign + Number(cashBoxDiff).toLocaleString('ru-RU') + ' тг');
          }
          await sendTelegram(userId, '⚠️ Расхождение кассы: ' + dir + ' ' + sign + Number(cashBoxDiff).toLocaleString('ru-RU') + ' тг\nОжидалось: ' + Number(cashExpected).toLocaleString('ru-RU') + ' тг\nФакт: ' + Number(cashActualVal).toLocaleString('ru-RU') + ' тг');
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
        const cashDiff = cashSales - (s.rCash||0);
        if (Math.abs(kaspiDiff) > 500) channelDiffs.push({ channel: 'Kaspi', diff: kaspiDiff });
        if (Math.abs(halykDiff) > 500) channelDiffs.push({ channel: 'Halyk', diff: halykDiff });
        if (Math.abs(cashDiff) > 500) channelDiffs.push({ channel: 'Наличные', diff: cashDiff });
        const allPrepaysRaw = await dbGetPrepays('all');
        // Учитываем ВСЕ предоплаты — и закрытые и открытые
        // Открытая предоплата тоже может объяснить расхождение (товар выдан сегодня)
        const todayClosedPrepays = allPrepaysRaw
          .map(p => ({ id: String(p.prep_id||''), client: String(p.client_name||''), amount: Number(p.amount||0), channel: String(p.channel||''), status: String(p.status||'') }));
        const prepayExplanations = [];
        const explainedDiffs = new Set();
        channelDiffs.forEach(cd => {
          if (cd.diff > 0) {
            const matching = todayClosedPrepays.filter(p => {
              const chMatch = (cd.channel === 'Kaspi' && (p.channel.toLowerCase().includes('kaspi')||p.channel.toLowerCase().includes('каспи'))) ||
                (cd.channel === 'Halyk' && (p.channel.toLowerCase().includes('halyk')||p.channel.toLowerCase().includes('халык'))) ||
                (cd.channel === 'Наличные' && (p.channel.toLowerCase().includes('нал')||p.channel.toLowerCase().includes('cash')));
              return chMatch || Math.abs(p.amount - Math.abs(cd.diff)) < 1000;
            });
            if (matching.length > 0) { prepayExplanations.push({ channel: cd.channel, diff: cd.diff, prepays: matching }); explainedDiffs.add(cd.channel); }
          }
        });
        const unexplainedDiffs = channelDiffs.filter(cd => !explainedDiffs.has(cd.channel));
        const hasNotes = s.notes && s.notes.trim().length > 10;
        if (unexplainedDiffs.length > 0 && !hasNotes && prepayExplanations.length === 0) {
          let blockMsg = '🚫 СМЕНА НЕ ЗАКРЫТА — необъяснённые расхождения!\n\n';
          unexplainedDiffs.forEach(cd => {
            const sign = cd.diff > 0 ? '+' : '';
            const dir = cd.diff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            blockMsg += '❌ ' + cd.channel + ': ' + dir + ' ' + sign + Number(cd.diff).toLocaleString() + ' тг\n';
          });
          blockMsg += '\nОбъясни причину и закрой смену снова.';
          await sendTelegram(userId, blockMsg);
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Расхождение при закрытии!\n👤 ' + (shift.seller || sellerName));
          cleanReply = reply.replace(/SHIFT_CLOSE:\{.*?\}/s, '').trim();
          return cleanReply || '';
        }
        // Записываем что первое закрытие состоялось — следующий будет вторым
        const todayKeyClose = new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric'});
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
        for (const [sellerId] of Object.entries(ALLOWED_MAP)) {
          if (!OWNER_IDS.includes(sellerId)) {
            await sendTelegramDocument(sellerId, 'den_' + today.replace(/\./g,'_') + '.html', htmlReport, '📊 Итоги дня ' + today);
          }
        }
        delete openShifts[String(userId)];
        await deleteOpenShift(userId);
        if (s.shiftStatus === 'second_close') {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🔴 Смена закрыта (второй продавец)\n👤 ' + sellerFinal + '\n🕐 ' + closeTime);
        }
      }
    } catch(e) { console.error('SHIFT_CLOSE error:', e.message); }
    cleanReply = reply.replace(/SHIFT_CLOSE:\{.*?\}/s, '').trim();
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
    const plan = 27000000;
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

async function handleMessage(userId, messageText, photoFileId) {
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
          await supabase.from('daily_sales').insert([{ sale_date: profitDate, revenue: 0, rosta_profit: profitAmount, month: parseInt(profitDate.split('-')[1]), year: parseInt(profitDate.split('-')[0]) }]);
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

  // Предоплаты для продавцов
  if (!isOwner && messageText) {
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
    for (const [otherId, shiftData] of Object.entries(openShifts)) {
      if (otherId !== userKey && shiftData && shiftData.seller) { isSecondSeller = true; firstSellerName = shiftData.seller; break; }
    }
    if (!isSecondSeller) {
      try {
        const { data: allShifts } = await supabase.from('open_shifts').select('*').neq('phone', userKey);
        if (allShifts && allShifts.length > 0) { isSecondSeller = true; firstSellerName = allShifts[0].seller || ''; }
      } catch(e) {}
    }
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
      const photoType = getPhotoTypeByOrder(userId);  // сначала смотрим порядок
      savePhotoByOrder(userId, photoFileId);           // потом сохраняем

      const base64 = await downloadTelegramFile(photoFileId);
      const ocrResult = await readPhotoWithClaude(base64, photoType);
      const contextText = photoType === 'zreport' ? 'Прочитала Z-отчет ROSTA:\n' + ocrResult
        : photoType === 'kaspi_terminal' ? 'Прочитала Kaspi терминал:\n' + ocrResult
        : photoType === 'halyk_terminal' ? 'Прочитала Halyk терминал:\n' + ocrResult
        : 'Прочитала фото:\n' + ocrResult;
      userContent = [{ type: 'text', text: messageText || 'Прочитай данные с фото.' }, { type: 'text', text: contextText }];
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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      system: systemPrompt, messages: conversations[userKey]
    });
    const reply = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text.trim()).filter(t => t.length > 0).join('\n').trim();
    if (!reply) { await sendTelegram(userId, 'Произошла ошибка. Попробуй еще раз.'); return; }
    conversations[userKey].push({ role: 'assistant', content: reply });
    await saveMessages(userId, userContent, reply);
    const cleanReply = await handleSystemCommands(reply, userId, senderName, messageText);
    if (cleanReply && cleanReply.trim()) await sendTelegram(userId, cleanReply);
  } catch(e) {
    console.error('Claude error:', e.message);
    await sendTelegram(userId, 'Произошла ошибка. Попробуй еще раз.');
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

// ── Proxy endpoints для веб-формы (без anon ключа в HTML) ──────────
app.options('/api/db/:table', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.sendStatus(200);
});

app.get('/api/db/:table', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { table } = req.params;
    const query = new URLSearchParams(req.query).toString();
    const url = `${SUPABASE_URL}/rest/v1/${table}${query?'?'+query:''}`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/db/:table', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { table } = req.params;
    const query = new URLSearchParams(req.query).toString();
    const url = `${SUPABASE_URL}/rest/v1/${table}${query?'?'+query:''}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/db/:table', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { table } = req.params;
    const query = new URLSearchParams(req.query).toString();
    const url = `${SUPABASE_URL}/rest/v1/${table}${query?'?'+query:''}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/db/:table', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { table } = req.params;
    const query = new URLSearchParams(req.query).toString();
    const url = `${SUPABASE_URL}/rest/v1/${table}${query?'?'+query:''}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API для веб-формы продавца ─────────────────────────────────────
app.options('/api/shift-report', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.sendStatus(200);
});

app.post('/api/shift-report', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const s = req.body;
    const fmt = n => Math.round(n||0).toLocaleString('ru-RU');
    const parse = v => { const n=parseFloat(String(v||'').replace(/\s/g,'').replace(',','.')); return isNaN(n)?0:n; };

    const rostaTotal = parse(s.rKaspi)+parse(s.rOnline)+parse(s.rHalyk)+parse(s.rHalykOnline)+
                       parse(s.rCash)+parse(s.rPersonal)+parse(s.rBonus)-
                       parse(s.rRetKaspi)-parse(s.rRetHalyk)-parse(s.rRetCash);
    const kaspiNet   = parse(s.tKaspi)-parse(s.tKaspiRet);
    const halykNet   = parse(s.tHalyk)-parse(s.tHalykRet);
    const cashActual = parse(s.cashActual);
    const cashOpen   = parse(s.cashOpen);
    const inkasso    = parse(s.inkasso);
    const cashSales  = parse(s.rCash)>0 ? parse(s.rCash)-parse(s.rRetCash) : Math.max(0, cashActual>0 ? cashActual-cashOpen+parse(s.cashPayouts)+inkasso : 0);
    const personalFact = parse(s.tPersonal)>0 ? parse(s.tPersonal) : parse(s.rPersonal)||0;
    const factTotal  = kaspiNet+halykNet+cashSales+personalFact+parse(s.rBonus);
    const diff       = factTotal-rostaTotal;
    const isOk       = Math.abs(diff)<500;
    const date       = s.date||new Date().toISOString().slice(0,10);
    const d          = date.slice(8,10)+'.'+date.slice(5,7)+'.'+date.slice(0,4);
    const diffSign   = diff>0?'+':'';

    // Генерируем красивый HTML отчёт для отправки в Telegram
    const prepayAdj = s.prepayTotal || 0;
    const adjDiff = diff < 0 ? diff + prepayAdj : diff - prepayAdj;
    const adjOk = Math.abs(adjDiff) < 500;
    const prepayExplained = prepayAdj > 0 && adjOk && !isOk;

    const htmlReport = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5eb;padding:16px;color:#1a1a1a}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:10px;border:1px solid rgba(0,0,0,0.08)}
.header{background:#1a1a1a;border-radius:12px;padding:16px 18px;margin-bottom:10px;color:#fff}
.label{font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#888;margin-bottom:8px}
.big{font-size:22px;font-weight:700;margin-bottom:10px}
.row{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
.muted{color:#555}.bold{font-weight:700}
.red{color:#c62828}.green{color:#22c55e}
.result{border-radius:12px;padding:14px 16px;margin-bottom:10px;text-align:center}
.result.ok{background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3)}
.result.fail{background:rgba(251,113,113,0.08);border:1px solid rgba(251,113,113,0.25)}
.prepay-card{border-left:3px solid #1D9E75;padding-left:12px;margin-top:8px}
.prepay-name{font-weight:700;font-size:14px}
.prepay-amount{font-size:16px;font-weight:700;color:#0F6E56;margin:4px 0}
.meta{font-size:11px;color:#888;margin-top:2px}
</style></head><body>
<div class="header">
  <div style="font-size:10px;opacity:0.45;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:4px">NANE PARIS · Отчёт смены</div>
  <div style="font-size:18px;font-weight:700">${s.seller||'?'}</div>
  <div style="font-size:13px;opacity:0.5;margin-top:2px">${d}</div>
</div>

<div class="card">
  <div class="label">ROSTA</div>
  <div class="big">${fmt(rostaTotal)} ₸</div>
  ${parse(s.rKaspi)?`<div class="row"><span class="muted">Kaspi QR</span><span class="bold">${fmt(parse(s.rKaspi))} ₸</span></div>`:''}
  ${parse(s.rOnline)?`<div class="row"><span class="muted">Онлайн Kaspi</span><span class="bold">${fmt(parse(s.rOnline))} ₸</span></div>`:''}
  ${parse(s.rHalyk)?`<div class="row"><span class="muted">Halyk QR</span><span class="bold">${fmt(parse(s.rHalyk))} ₸</span></div>`:''}
  ${parse(s.rHalykOnline)?`<div class="row"><span class="muted">Онлайн Halyk</span><span class="bold">${fmt(parse(s.rHalykOnline))} ₸</span></div>`:''}
  ${parse(s.rCash)?`<div class="row"><span class="muted">Наличные</span><span class="bold">${fmt(parse(s.rCash))} ₸</span></div>`:''}
  ${parse(s.rPersonal)?`<div class="row"><span class="muted">Личная карта</span><span class="bold">${fmt(parse(s.rPersonal))} ₸</span></div>`:''}
  ${parse(s.rBonus)?`<div class="row"><span class="muted">Бонусы</span><span class="bold">${fmt(parse(s.rBonus))} ₸</span></div>`:''}
  ${parse(s.rRetKaspi)?`<div class="row"><span class="red">Возврат Kaspi</span><span class="red bold">−${fmt(parse(s.rRetKaspi))} ₸</span></div>`:''}
  ${parse(s.rRetHalyk)?`<div class="row"><span class="red">Возврат Halyk</span><span class="red bold">−${fmt(parse(s.rRetHalyk))} ₸</span></div>`:''}
</div>

<div class="card">
  <div class="label">Терминалы (факт)</div>
  ${kaspiNet?`<div class="row"><span class="muted">Kaspi</span><span class="bold">${fmt(kaspiNet)} ₸</span></div>`:''}
  ${halykNet?`<div class="row"><span class="muted">Halyk</span><span class="bold">${fmt(halykNet)} ₸</span></div>`:''}
  ${personalFact?`<div class="row"><span class="muted">Личная карта</span><span class="bold">${fmt(personalFact)} ₸</span></div>`:''}
</div>

${(cashOpen||cashActual)?`<div class="card">
  <div class="label">Касса</div>
  ${cashOpen?`<div class="row"><span class="muted">Открытие</span><span class="bold">${fmt(cashOpen)} ₸</span></div>`:''}
  ${cashActual?`<div class="row"><span class="muted">Закрытие</span><span class="bold">${fmt(cashActual)} ₸</span></div>`:''}
  ${inkasso?`<div class="row"><span class="muted">Инкассация</span><span class="red bold">−${fmt(inkasso)} ₸</span></div>`:''}
</div>`:''}

${prepayAdj>0&&s.prepayClients&&s.prepayClients.length>0?`<div class="card">
  <div class="label">Предоплаты клиентов</div>
  ${s.prepayClients.map(c=>`
  <div class="prepay-card" style="margin-bottom:10px">
    <div class="prepay-name">${c.name||'Клиент'}</div>
    ${c.phone?`<div class="meta">📱 ${c.phone}</div>`:''}
    <div class="prepay-amount">${fmt(parse(c.amount))} ₸</div>
    ${c.item?`<div class="meta">👗 ${c.item}</div>`:''}
    ${c.channel?`<div class="meta">💳 ${c.channel}</div>`:''}
    ${c.id?`<div class="meta" style="color:#ccc">${c.id}</div>`:''}
  </div>`).join('')}
</div>`:prepayAdj>0?`<div class="card">
  <div class="label">Предоплаты клиентов</div>
  <div class="prepay-card">
    <div class="prepay-amount">${fmt(prepayAdj)} ₸</div>
    <div class="meta">Подтянуто при закрытии смены</div>
  </div>
</div>`:''}

<div class="result ${adjOk?'ok':'fail'}">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <div style="text-align:center;flex:1"><div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px">ROSTA</div><div style="font-size:16px;font-weight:700">${fmt(rostaTotal)} ₸</div></div>
    <div style="text-align:center;flex:1"><div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px">Факт</div><div style="font-size:16px;font-weight:700">${fmt(factTotal)} ₸</div></div>
  </div>
  ${prepayAdj>0?`<div style="font-size:13px;color:#0F6E56;font-weight:700;margin-bottom:6px;text-align:center">💳 Предоплата: +${fmt(prepayAdj)} ₸</div>`:''}
  <div style="font-size:18px;font-weight:700;color:${adjOk?'#22c55e':'#fb7171'};text-align:center">
    ${adjOk?'✅ Всё сходится':prepayExplained?'✅ Объяснено предоплатой':`⚠️ Расхождение: ${diffSign}${fmt(Math.abs(adjDiff))} ₸`}
  </div>
  ${prepayExplained?`<div style="font-size:12px;color:#0F6E56;text-align:center;margin-top:4px">Расхождение ${fmt(Math.abs(diff))} ₸ закрыто предоплатой</div>`:''}
</div>

${s.reasonKaspi||s.reasonHalyk||s.reasonCash?`<div class="card"><div class="label">Пояснения</div>
  ${s.reasonKaspi?`<div class="row"><span class="muted">Kaspi</span><span>${s.reasonKaspi}</span></div>`:''}
  ${s.reasonHalyk?`<div class="row"><span class="muted">Halyk</span><span>${s.reasonHalyk}</span></div>`:''}
  ${s.reasonCash?`<div class="row"><span class="muted">Нал</span><span>${s.reasonCash}</span></div>`:''}
</div>`:''}

${s.notes?`<div class="card"><div class="label">Примечания</div><div style="font-size:13px">${s.notes}</div></div>`:''}

<div style="font-size:11px;color:#aaa;text-align:center;margin-top:8px">Отправлено из веб-формы · ${d}</div>
</body></html>`;

    const SELLER_IDS = ['1043646480', '396513117', '823616796']; // Айнур, Зарина, Далира

    for (const ownerId of OWNER_IDS) {
      // Отправляем HTML отчёт
      await sendTelegramDocument(ownerId, `shift_${s.seller||'report'}_${date}.html`, htmlReport, `📋 Закрытие смены — ${s.seller||'?'} · ${d}`);

      // Отправляем фото если есть
      if (s.photos) {
        const photoLabels = { z: '📄 Z-отчёт ROSTA', kaspi: '💳 Kaspi терминал', halyk: '💳 Halyk терминал' };
        for (const [key, label] of Object.entries(photoLabels)) {
          if (s.photos[key]) {
            try {
              const imgBuffer = Buffer.from(s.photos[key], 'base64');
              const body = JSON.stringify({
                chat_id: ownerId,
                caption: label + ` · ${s.seller||'?'} · ${d}`,
                photo: 'attach://photo.jpg'
              });
              await new Promise((resolve) => {
                const https = require('https');
                const boundary = '----FormBoundary';
                const imgData = Buffer.from(s.photos[key], 'base64');
                const formHeader = `--${boundary}
Content-Disposition: form-data; name="chat_id"

${ownerId}
--${boundary}
Content-Disposition: form-data; name="caption"

${label} · ${s.seller||'?'} · ${d}
--${boundary}
Content-Disposition: form-data; name="photo"; filename="photo.jpg"
Content-Type: image/jpeg

`;
                const formFooter = `
--${boundary}--`;
                const formBody = Buffer.concat([Buffer.from(formHeader), imgData, Buffer.from(formFooter)]);
                const req = https.request({
                  hostname: 'api.telegram.org',
                  path: `/bot${TELEGRAM_TOKEN}/sendPhoto`,
                  method: 'POST',
                  headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': formBody.length
                  }
                }, res => { res.on('data', () => {}); res.on('end', resolve); });
                req.on('error', resolve);
                req.write(formBody);
                req.end();
              });
            } catch(e) { console.error('Photo send error:', e.message); }
          }
        }
      }
    }
    // Отправляем полный HTML отчёт всем продавцам
    try {
      for (const sellerId of SELLER_IDS) {
        await sendTelegramDocument(sellerId, `shift_${s.seller||'report'}_${date}.html`, htmlReport, `📋 Закрытие смены — ${s.seller||'?'} · ${d}`);
      }
    } catch(e) { console.error('Seller notify error:', e.message); }

    res.json({ ok: true });
  } catch(e) {
    console.error('/api/shift-report error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.options('/api/ocr', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.sendStatus(200);
});

app.post('/api/ocr', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { base64, mimeType, prompt } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: mimeType||'image/jpeg', data: base64 }
        }, {
          type: 'text',
          text: prompt
        }]
      }]
    });
    const text = response.content[0].text;
    res.json({ ok: true, text });
  } catch(e) {
    console.error('/api/ocr error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Webhook Telegram ────────────────────────────────────────────────
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
      }
    }

    if (!messageText && !photoFileId) return;
    await handleMessage(userId, messageText, photoFileId);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'TOMI NANE PARIS Telegram', version: '4.4' }));

// Утилита: удалить запись из open_shifts по phone (через GET для совместимости)
app.get('/api/clear-shift/:phone', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const phone = req.params.phone;
    const url = `${SUPABASE_URL}/rest/v1/open_shifts?phone=eq.${encodeURIComponent(phone)}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ ok: true, deleted: phone });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Веб-форма продавца/владельца ────────────────────────────────────
app.get('/tomi', (req, res) => {
  const htmlB64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InJ1Ij4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAsIG1heGltdW0tc2NhbGU9MS4wIj4KPHRpdGxlPk5BTkUgUEFSSVMg4oCUINCi0L7QvNC4PC90aXRsZT4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1ETStTYW5zOndnaHRAMzAwOzQwMDs1MDA7NzAwJmZhbWlseT1Db3Jtb3JhbnQrR2FyYW1vbmQ6aXRhbCx3Z2h0QDEsNDAwOzEsNjAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3JlYWN0LzE4LjIuMC91bWQvcmVhY3QucHJvZHVjdGlvbi5taW4uanMiPjwvc2NyaXB0Pgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvcmVhY3QtZG9tLzE4LjIuMC91bWQvcmVhY3QtZG9tLnByb2R1Y3Rpb24ubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL2JhYmVsLXN0YW5kYWxvbmUvNy4yMy4yL2JhYmVsLm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KKntib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luOjA7cGFkZGluZzowfQpib2R5e2JhY2tncm91bmQ6I0ZGRkZGMDtmb250LWZhbWlseTonRE0gU2Fucycsc2Fucy1zZXJpZjtjb2xvcjojMWExYTFhO21pbi1oZWlnaHQ6MTAwdmh9CmlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250LWZhbWlseTppbmhlcml0fQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjRweH06Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6cmdiYSgwLDAsMCwwLjE1KTtib3JkZXItcmFkaXVzOjJweH0KaW5wdXRbdHlwZT1kYXRlXTo6LXdlYmtpdC1jYWxlbmRhci1waWNrZXItaW5kaWNhdG9ye2ZpbHRlcjppbnZlcnQoMC4zKX0KQG1lZGlhIHByaW50ey5uby1wcmludHtkaXNwbGF5Om5vbmUhaW1wb3J0YW50fX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBpZD0icm9vdCI+PC9kaXY+CjxzY3JpcHQgdHlwZT0idGV4dC9iYWJlbCI+Cgpjb25zdCB7dXNlU3RhdGUsdXNlRWZmZWN0LHVzZUNhbGxiYWNrfT1SZWFjdDsKCi8vIOKUgOKUgCDQmtC+0L3RhNC40LPRg9GA0LDRhtC40Y8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN1cGFiYXNlINC30LDQv9GA0L7RgdGLINC40LTRg9GCINGH0LXRgNC10LcgUmFpbHdheSDigJQg0LrQu9GO0YfQuCDQvdC1INC90YPQttC90Ysg0LIgSFRNTApjb25zdCBBUElfVVJMICAgICAgID0gImh0dHBzOi8vdG9taS1zZXJ2ZXItcHJvZHVjdGlvbi1jNmQ3LnVwLnJhaWx3YXkuYXBwIjsKY29uc3QgU0VMTEVSUyAgICAgICA9IFsi0JfQsNGA0LjQvdCwIiwi0JTQsNC70LjRgNCwIl07CmNvbnN0IE9XTkVSX1BBU1MgICAgPSAibmFuZTIwMjYiOwpjb25zdCBTRUxMRVJfUEFTUyAgID0gIm5hbmUxMjM0IjsKCi8vIOKUgOKUgCBIZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApjb25zdCBmbXQgID0gbiA9PiBNYXRoLnJvdW5kKG58fDApLnRvTG9jYWxlU3RyaW5nKCJydS1SVSIpOwpjb25zdCBwYXJzZSA9IHYgPT4geyBjb25zdCBuPXBhcnNlRmxvYXQoU3RyaW5nKHZ8fCIiKS5yZXBsYWNlKC9ccy9nLCIiKS5yZXBsYWNlKCIsIiwiLiIpKTsgcmV0dXJuIGlzTmFOKG4pPzA6bjsgfTsKY29uc3QgdG9kYXlTdHIgPSAoKSA9PiB7CiAgY29uc3Qgbm93PW5ldyBEYXRlKCksIGE9bmV3IERhdGUobm93LmdldFRpbWUoKSs1KjYwKjYwKjEwMDApOwogIHJldHVybiBhLmdldFVUQ0Z1bGxZZWFyKCkrIi0iK1N0cmluZyhhLmdldFVUQ01vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpKyItIitTdHJpbmcoYS5nZXRVVENEYXRlKCkpLnBhZFN0YXJ0KDIsIjAiKTsKfTsKY29uc3QgZm10RGF0ZSA9IHMgPT4geyBpZighcylyZXR1cm4iIjsgY29uc3RbeSxtLGRdPXMuc3BsaXQoIi0iKTsgcmV0dXJuYCR7ZH0uJHttfS4ke3l9YDsgfTsKCi8vIOKUgOKUgCDQl9Cw0L/RgNC+0YHRiyDRh9C10YDQtdC3IFJhaWx3YXkgcHJveHkgKNCx0LXQtyBTdXBhYmFzZSDQutC70Y7Rh9CwINCyIEhUTUwpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBzYkZldGNoKHRhYmxlLCBtZXRob2Q9IkdFVCIsIGJvZHk9bnVsbCwgZmlsdGVyPSIiKSB7CiAgY29uc3QgdXJsID0gYCR7QVBJX1VSTH0vYXBpL2RiLyR7dGFibGV9JHtmaWx0ZXJ9YDsKICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsKICAgIG1ldGhvZDogbWV0aG9kPT09IlBBVENIIiA/ICJQQVRDSCIgOiBtZXRob2Q9PT0iUE9TVCIgPyAiUE9TVCIgOiAiR0VUIiwKICAgIGhlYWRlcnM6IHsiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24ifSwKICAgIGJvZHk6IGJvZHkgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IG51bGwKICB9KTsKICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGF3YWl0IHJlcy50ZXh0KCkpOwogIHJldHVybiByZXMuc3RhdHVzID09PSAyMDQgPyBudWxsIDogcmVzLmpzb24oKTsKfQoKLy8g4pSA4pSAINCh0YLQuNC70Lgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmNvbnN0IEZTID0ge3dpZHRoOiIxMDAlIixiYWNrZ3JvdW5kOiJyZ2JhKDAsMCwwLDAuMDMpIixib3JkZXI6IjEuNXB4IHNvbGlkICMxYTFhMWEiLGJvcmRlclJhZGl1czoiNnB4IiwKICBjb2xvcjoiIzFhMWExYSIsZm9udFNpemU6IjE1cHgiLHBhZGRpbmc6IjExcHggMTNweCIsb3V0bGluZToibm9uZSIsZm9udEZhbWlseToiaW5oZXJpdCJ9Owpjb25zdCBMUyA9IHtmb250U2l6ZToiMTFweCIsbGV0dGVyU3BhY2luZzoiMC4xMmVtIixjb2xvcjoiIzU1NSIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIiwKICBtYXJnaW5Cb3R0b206IjVweCIsZGlzcGxheToiYmxvY2siLGZvbnRXZWlnaHQ6IjYwMCJ9Owpjb25zdCBCVE4gPSB7d2lkdGg6IjEwMCUiLHBhZGRpbmc6IjE1cHgiLGJvcmRlclJhZGl1czoiMTBweCIsYm9yZGVyOiJub25lIixiYWNrZ3JvdW5kOiIjMWExYTFhIiwKICBjb2xvcjoiI0ZGRkZGMCIsZm9udFNpemU6IjE0cHgiLGZvbnRXZWlnaHQ6IjcwMCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0IixsZXR0ZXJTcGFjaW5nOiIwLjA1ZW0ifTsKCi8vIOKUgOKUgCDQmtC+0LzQv9C+0L3QtdC90YI6INC/0L7Qu9C1INGBINGE0L7RgNC80LDRgtC40YDQvtCy0LDQvdC40LXQvCDRgdGD0LzQvNGLIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBNb25leUZpZWxkKHtsYWJlbCx2YWx1ZSxvbkNoYW5nZSxsb2NrZWQsb25VbmxvY2ssaGludH0pewogIGNvbnN0IFtmb2N1c2VkLHNldEZvY3VzZWRdPXVzZVN0YXRlKGZhbHNlKTsKICBjb25zdCBkaXNwbGF5ID0gZm9jdXNlZCA/IHZhbHVlIDogKHZhbHVlPT09IiI/IiI6cGFyc2UodmFsdWUpLnRvTG9jYWxlU3RyaW5nKCJydS1SVSIpKyIg4oK4Iik7CiAgcmV0dXJuIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjEzcHgifX0+CiAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciIsbWFyZ2luQm90dG9tOiI0cHgifX0+CiAgICAgIDxsYWJlbCBzdHlsZT17TFN9PntsYWJlbH08L2xhYmVsPgogICAgICB7bG9ja2VkJiY8YnV0dG9uIG9uQ2xpY2s9e29uVW5sb2NrfSBzdHlsZT17e2ZvbnRTaXplOiIxMHB4IixwYWRkaW5nOiIycHggOHB4Iixib3JkZXJSYWRpdXM6IjRweCIsCiAgICAgICAgYm9yZGVyOiIxcHggc29saWQgcmdiYSgxODAsMTMwLDAsMC40KSIsYmFja2dyb3VuZDoicmdiYSgyNTUsMjAwLDAsMC4xKSIsY29sb3I6IiM2YjRmMDAiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCJ9fT4KICAgICAgICDwn5SSINCY0LfQvNC10L3QuNGC0YwKICAgICAgPC9idXR0b24+fQogICAgPC9kaXY+CiAgICA8aW5wdXQgc3R5bGU9e3suLi5GUyxiYWNrZ3JvdW5kOmxvY2tlZD8icmdiYSgwLDAsMCwwLjA0KSI6Zm9jdXNlZD8iI2ZmZiI6InJnYmEoMCwwLDAsMC4wMykiLAogICAgICBjb2xvcjpsb2NrZWQ/IiM4ODgiOiIjMWExYTFhIixjdXJzb3I6bG9ja2VkPyJub3QtYWxsb3dlZCI6InRleHQiLHRleHRBbGlnbjoicmlnaHQiLGZvbnRXZWlnaHQ6IjYwMCJ9fQogICAgICB2YWx1ZT17ZGlzcGxheX0KICAgICAgb25DaGFuZ2U9e2U9PntpZighbG9ja2VkKW9uQ2hhbmdlKGUudGFyZ2V0LnZhbHVlLnJlcGxhY2UoL1teMC05LixdL2csIiIpKTt9fQogICAgICBvbkZvY3VzPXsoKT0+e2lmKCFsb2NrZWQpc2V0Rm9jdXNlZCh0cnVlKTt9fQogICAgICBvbkJsdXI9eygpPT5zZXRGb2N1c2VkKGZhbHNlKX0KICAgICAgcmVhZE9ubHk9e2xvY2tlZH0KICAgICAgcGxhY2Vob2xkZXI9IjAg4oK4IgogICAgICBpbnB1dE1vZGU9Im51bWVyaWMiCiAgICAvPgogICAge2hpbnQmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsY29sb3I6IiM1NTUiLG1hcmdpblRvcDoiM3B4In19PntoaW50fTwvZGl2Pn0KICA8L2Rpdj47Cn0KCmZ1bmN0aW9uIFNlY1RpdGxlKHtjaGlsZHJlbixpY29ufSl7CiAgcmV0dXJuIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixhbGlnbkl0ZW1zOiJjZW50ZXIiLGdhcDoiMTBweCIsYm9yZGVyQm90dG9tOiIxcHggc29saWQgcmdiYSgwLDAsMCwwLjEpIiwKICAgIHBhZGRpbmdCb3R0b206IjEwcHgiLG1hcmdpbkJvdHRvbToiMThweCIsbWFyZ2luVG9wOiIyOHB4In19PgogICAgPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMThweCJ9fT57aWNvbn08L3NwYW4+CiAgICA8c3BhbiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4IixsZXR0ZXJTcGFjaW5nOiIwLjE4ZW0iLHRleHRUcmFuc2Zvcm06InVwcGVyY2FzZSIsZm9udFdlaWdodDoiNzAwIn19PntjaGlsZHJlbn08L3NwYW4+CiAgPC9kaXY+Owp9CgovLyDilIDilIAgRGlmZlJvdyDigJQg0YHQstC10YDQutCwINC/0L4g0LrQsNC90LDQu9GDIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBEaWZmUm93KHtsYWJlbCxyb3N0YSxmYWN0LHJlYXNvbixvblJlYXNvbkNoYW5nZSxpbmNvbWluZ1ByZXBheXMsb25Mb2FkUHJlcGF5cyxsb2FkaW5nUHJlcGF5cyxhdHRhY2hlZFByZXBheXMsb25BdHRhY2hQcmVwYXl9KXsKICAvLyDQlNC10L3RjCAxICjQuNC30LvQuNGI0LXQuik6INC40YHQv9C+0LvRjNC30YPQtdC8IGFtb3VudCAo0YHQutC+0LvRjNC60L4g0L/QvtC70YPRh9C40LvQuCDQv9GA0LXQtNC+0L/Qu9Cw0YLRgykKICAvLyDQlNC10L3RjCAyICjQvdC10LTQvtGB0YLQsNGH0LApOiDQuNGB0L/QvtC70YzQt9GD0LXQvCBiYWxhbmNlICjRgdC60L7Qu9GM0LrQviDQtNC+0LvQttC10L0g0LrQu9C40LXQvdGCKQogIGNvbnN0IGF0dGFjaGVkU3VtPShhdHRhY2hlZFByZXBheXN8fFtdKS5yZWR1Y2UoKHMscCk9PnsKICAgIGNvbnN0IGJhbD1wYXJzZShwLmJhbGFuY2V8fDApOwogICAgY29uc3QgYW10PXBhcnNlKHAuYW1vdW50fHwwKTsKICAgIC8vINCV0YHQu9C4INC10YHRgtGMINC00L7Qu9CzIChiYWxhbmNlKSDQuCDRhNCw0LrRgiA8IFJPU1RBICjQvdC10LTQvtGB0YLQsNGH0LApIOKAlCDQuNGB0L/QvtC70YzQt9GD0LXQvCBiYWxhbmNlCiAgICAvLyDQldGB0LvQuCDRhNCw0LrRgiA+IFJPU1RBICjQuNC30LvQuNGI0LXQuikg4oCUINC40YHQv9C+0LvRjNC30YPQtdC8IGFtb3VudAogICAgcmV0dXJuIHMrKHJhd0RpZmY8MCYmYmFsPjA/YmFsOmFtdCk7CiAgfSwwKTsKICAvLyDQn9GA0LXQtNC+0L/Qu9Cw0YLQsCDQvtCx0YrRj9GB0L3Rj9C10YIg0YDQsNGB0YXQvtC20LTQtdC90LjQtSDRgSDQu9GO0LHQvtC5INGB0YLQvtGA0L7QvdGLOgogIC8vINCV0YHQu9C4INGE0LDQutGCIDwgUk9TVEEgKNC90LXQtNC+0YHRgtCw0YfQsCkg4oCUINC/0YDQtdC00L7Qv9C70LDRgtCwINCx0YvQu9CwINGA0LDQvdGM0YjQtSwg0L/RgNC40LHQsNCy0LvRj9C10Lwg0Log0YTQsNC60YLRgwogIC8vINCV0YHQu9C4INGE0LDQutGCID4gUk9TVEEgKNC40LfQu9C40YjQtdC6KSDigJQg0LTQtdC90YzQs9C4INC/0L7Qu9GD0YfQtdC90Ysg0L/QviDQv9GA0LXQtNC+0L/Qu9Cw0YLQtSwg0L/RgNC40LHQsNCy0LvRj9C10Lwg0LogUk9TVEEKICBjb25zdCByYXdEaWZmID0gZmFjdCAtIHJvc3RhOwogIGNvbnN0IGRpZmYgPSByYXdEaWZmIDwgMAogICAgPyByYXdEaWZmICsgYXR0YWNoZWRTdW0gICAvLyDQvdC10LTQvtGB0YLQsNGH0LA6INC/0YDQtdC00L7Qv9C70LDRgtCwINC30LDQutGA0YvQstCw0LXRgiDRgNCw0LfRgNGL0LIKICAgIDogcmF3RGlmZiAtIGF0dGFjaGVkU3VtOyAgLy8g0LjQt9C70LjRiNC10Lo6INC/0YDQtdC00L7Qv9C70LDRgtCwINC+0LHRitGP0YHQvdGP0LXRgiDQu9C40YjQvdC40LUg0LTQtdC90YzQs9C4CiAgY29uc3Qgb2s9TWF0aC5hYnMoZGlmZik8NTAwOwogIGNvbnN0IFtzaG93TGlzdCxzZXRTaG93TGlzdF09dXNlU3RhdGUoZmFsc2UpOwoKICBjb25zdCBkaWFnQnRucz1bXTsKICBpZighb2spewogICAgaWYoZGlmZj41MDApewogICAgICBkaWFnQnRucy5wdXNoKHtpZDoicHJlcGF5IixpY29uOiJcdUQ4M0RcdURDQjAiLHRleHQ6ItCR0YvQu9CwINC/0YDQtdC00L7Qv9C70LDRgtCwIOKAlCDQtNC10L3RjNCz0Lgg0LIg0YLQtdGA0LzQuNC90LDQu9C1LCDQsiBST1NUQSDQvdC1INC/0YDQvtCx0LjRgtC+Iix2YWw6ItCf0YDQtdC00L7Qv9C70LDRgtCwINC/0L7Qu9GD0YfQtdC90LAg0YfQtdGA0LXQtyDRgtC10YDQvNC40L3QsNC7LCDQsiBST1NUQSDQvdC1INC+0YLRgNCw0LbQtdC90LAifSk7CiAgICAgIGRpYWdCdG5zLnB1c2goe2lkOiJub3RfcnVuZyIsaWNvbjoiXHVEODNFXHVEREZFIix0ZXh0OiLQn9GA0L7QtNCw0LbQsCDQv9GA0L7RiNC70LAg0YfQtdGA0LXQtyDRgtC10YDQvNC40L3QsNC7LCDQvdC+INC90LUg0L/RgNC+0LHQuNGC0LAg0LIgUk9TVEEiLHZhbDoi0KLRgNCw0L3Qt9Cw0LrRhtC40Y8g0LIg0YLQtdGA0LzQuNC90LDQu9C1INCx0LXQtyDRh9C10LrQsCDQsiBST1NUQSJ9KTsKICAgIH0gZWxzZSB7CiAgICAgIGRpYWdCdG5zLnB1c2goe2lkOiJwcmVwYXlfcmVkZWVtZWQiLGljb246IuKchSIsdGV4dDoi0JrQu9C40LXQvdGCINCy0YvQutGD0L/QuNC7INGC0L7QstCw0YAg0L/QviDQv9GA0LXQtNC+0L/Qu9Cw0YLQtSIsdmFsOiLQktGL0LrRg9C/INC/0YDQtdC00L7Qv9C70LDRgtGLOiDRh9Cw0YHRgtGMINGB0YPQvNC80Ysg0L/QvtC70YPRh9C10L3QsCDRgNCw0L3RjNGI0LUifSk7CiAgICAgIGRpYWdCdG5zLnB1c2goe2lkOiJwZXJzb25hbCIsaWNvbjoiXHVEODNEXHVEQ0IzIix0ZXh0OiLQntC/0LvQsNGC0LAg0L3QsCDQu9C40YfQvdGD0Y4g0LrQsNGA0YLRgyDigJQg0L/RgNC+0LHQuNGC0L4g0LrQsNC6INC90LDQu9C40YfQvdGL0LUiLHZhbDoi0JrQu9C40LXQvdGCINC/0LXRgNC10LLRkdC7INC90LAg0LvQuNGH0L3Rg9GOINC60LDRgNGC0YMsINCyIFJPU1RBINC60LDQuiDQvdCw0LvQuNGH0L3Ri9C1In0pOwogICAgICBkaWFnQnRucy5wdXNoKHtpZDoicm9zdGFfZXJyIixpY29uOiJcdUQ4M0RcdUREMjciLHRleHQ6ItCe0YjQuNCx0LrQsCDQsiBST1NUQSDigJQg0LvQuNGI0L3QuNC5INGH0LXQuiIsdmFsOiLQntGI0LjQsdC+0YfQvdGL0Lkg0YfQtdC6INCyIFJPU1RBIOKAlCDRgtGA0LXQsdGD0LXRgiDRgNCw0LfQsdC+0YDQsCJ9KTsKICAgIH0KICB9CgogIHJldHVybiA8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDpvaz8icmdiYSg3NCwyMjIsMTI4LDAuMDYpIjoicmdiYSgyNTEsMTEzLDExMywwLjA4KSIsCiAgICBib3JkZXI6IjFweCBzb2xpZCAiKyhvaz8icmdiYSg3NCwyMjIsMTI4LDAuMikiOiJyZ2JhKDI1MSwxMTMsMTEzLDAuMjUpIiksCiAgICBib3JkZXJSYWRpdXM6IjEwcHgiLHBhZGRpbmc6IjE0cHgiLG1hcmdpbkJvdHRvbToiMTBweCJ9fT4KICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsYWxpZ25JdGVtczoiZmxleC1zdGFydCIsbWFyZ2luQm90dG9tOm9rPzA6IjEwcHgifX0+CiAgICAgIDxzcGFuIHN0eWxlPXt7Zm9udFNpemU6IjEzcHgiLGZvbnRXZWlnaHQ6IjUwMCJ9fT57bGFiZWx9PC9zcGFuPgogICAgICA8ZGl2IHN0eWxlPXt7dGV4dEFsaWduOiJyaWdodCJ9fT4KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiIjNTU1In19PlJPU1RBOiB7Zm10KHJvc3RhKX0g4oK4IOKGkiDQpNCw0LrRgjoge2ZtdChmYWN0KX0g4oK4PC9kaXY+CiAgICAgICAge2F0dGFjaGVkU3VtPjAmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsY29sb3I6IiMyRTZCNUUiLG1hcmdpblRvcDoiMnB4In19PtCf0YDQtdC00L7Qv9C70LDRgtCwOiAre2ZtdChhdHRhY2hlZFN1bSl9IOKCuDwvZGl2Pn0KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE1cHgiLGZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6b2s/IiM0YWRlODAiOiIjZmI3MTcxIixtYXJnaW5Ub3A6IjJweCJ9fT4KICAgICAgICAgIHtvaz8i4pyTINCh0YXQvtC00LjRgtGB0Y8iOmAke2RpZmY+MD8iKyI6IiJ9JHtmbXQoZGlmZil9IOKCuGB9CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICB7Lyog0J/RgNC40LrRgNC10L/Qu9GR0L3QvdGL0LUg0L/RgNC10LTQvtC/0LvQsNGC0YsgKi99CiAgICB7KGF0dGFjaGVkUHJlcGF5c3x8W10pLm1hcCgocCxpKT0+ewogICAgICBjb25zdCBiYWw9cGFyc2UocC5iYWxhbmNlfHwwKTsKICAgICAgY29uc3QgYW10PXBhcnNlKHAuYW1vdW50fHwwKTsKICAgICAgY29uc3Qgc2hvd0FtdD1yYXdEaWZmPDAmJmJhbD4wP2JhbDphbXQ7CiAgICAgIGNvbnN0IGxhYmVsPXJhd0RpZmY8MCYmYmFsPjA/ItC00L7Qu9CzIjoi0L/RgNC10LTQvtC/0LvQsNGC0LAiOwogICAgICByZXR1cm4gPGRpdiBrZXk9e2l9IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLAogICAgICAgIHBhZGRpbmc6IjZweCAxMHB4IixiYWNrZ3JvdW5kOiJyZ2JhKDQ2LDEwNyw5NCwwLjA4KSIsYm9yZGVyUmFkaXVzOiI2cHgiLG1hcmdpbkJvdHRvbToiNHB4Iixmb250U2l6ZToiMTJweCJ9fT4KICAgICAgICA8c3BhbiBzdHlsZT17e2NvbG9yOiIjMkU2QjVFIn19PjxzdHJvbmc+e3AuY2xpZW50X25hbWV9PC9zdHJvbmc+IMK3IHtsYWJlbH0ge2ZtdChzaG93QW10KX0g4oK4PC9zcGFuPgogICAgICAgIDxidXR0b24gb25DbGljaz17KCk9Pm9uQXR0YWNoUHJlcGF5KHAsdHJ1ZSl9IHN0eWxlPXt7YmFja2dyb3VuZDoibm9uZSIsYm9yZGVyOiJub25lIixjb2xvcjoiI2I3MWMxYyIsY3Vyc29yOiJwb2ludGVyIn19PuKclTwvYnV0dG9uPgogICAgICA8L2Rpdj47CiAgICB9KX0KICAgIHsvKiDQmtC90L7Qv9C60LAg0L/QvtC00YLRj9C90YPRgtGMINC/0YDQtdC00L7Qv9C70LDRgtGDICovfQogICAgeyFvayYmPGJ1dHRvbiBvbkNsaWNrPXsoKT0+e3NldFNob3dMaXN0KHY9PiF2KTtpZighc2hvd0xpc3QmJm9uTG9hZFByZXBheXMpb25Mb2FkUHJlcGF5cygpO319CiAgICAgIHN0eWxlPXt7d2lkdGg6IjEwMCUiLHBhZGRpbmc6IjhweCAxMnB4Iixib3JkZXJSYWRpdXM6IjZweCIsYm9yZGVyOiIxLjVweCBkYXNoZWQgIzJFNkI1RSIsCiAgICAgICAgYmFja2dyb3VuZDoicmdiYSg0NiwxMDcsOTQsMC4wNSkiLGNvbG9yOiIjMkU2QjVFIixmb250U2l6ZToiMTJweCIsZm9udFdlaWdodDoiNjAwIiwKICAgICAgICBjdXJzb3I6InBvaW50ZXIiLGZvbnRGYW1pbHk6ImluaGVyaXQiLG1hcmdpbkJvdHRvbToiOHB4In19PgogICAgICDwn5OOINCf0L7QtNGC0Y/QvdGD0YLRjCDQv9GA0LXQtNC+0L/Qu9Cw0YLRgyB7KGluY29taW5nUHJlcGF5c3x8W10pLmxlbmd0aD4wPyIoIitpbmNvbWluZ1ByZXBheXMubGVuZ3RoKyIpIjoi4oaSINC30LDQs9GA0YPQt9C40YLRjCJ9CiAgICA8L2J1dHRvbj59CiAgICB7c2hvd0xpc3QmJjxkaXYgc3R5bGU9e3tib3JkZXI6IjEuNXB4IHNvbGlkICMyRTZCNUUiLGJvcmRlclJhZGl1czoiOHB4IixtYXJnaW5Cb3R0b206IjhweCIsb3ZlcmZsb3c6ImhpZGRlbiJ9fT4KICAgICAge2xvYWRpbmdQcmVwYXlzJiY8ZGl2IHN0eWxlPXt7cGFkZGluZzoiMTBweCIsdGV4dEFsaWduOiJjZW50ZXIiLGZvbnRTaXplOiIxMnB4In19PuKPsyDQl9Cw0LPRgNGD0LfQutCwLi4uPC9kaXY+fQogICAgICB7IWxvYWRpbmdQcmVwYXlzJiYoaW5jb21pbmdQcmVwYXlzfHxbXSkubGVuZ3RoPT09MCYmPGRpdiBzdHlsZT17e3BhZGRpbmc6IjEwcHgiLHRleHRBbGlnbjoiY2VudGVyIixmb250U2l6ZToiMTJweCIsY29sb3I6IiM1NTUifX0+0J3QtdGCINC+0YLQutGA0YvRgtGL0YUg0L/RgNC10LTQvtC/0LvQsNGCPC9kaXY+fQogICAgICB7KGluY29taW5nUHJlcGF5c3x8W10pLmZpbHRlcihwPT4hKGF0dGFjaGVkUHJlcGF5c3x8W10pLnNvbWUoYT0+YS5pZD09PXAuaWQpKS5tYXAoKHAsaSk9PnsKICAgICAgICByZXR1cm4gPGRpdiBrZXk9e2l9IG9uQ2xpY2s9eygpPT57b25BdHRhY2hQcmVwYXkocCxmYWxzZSk7c2V0U2hvd0xpc3QoZmFsc2UpO319CiAgICAgICAgICBzdHlsZT17e3BhZGRpbmc6IjEwcHggMTJweCIsYm9yZGVyQm90dG9tOiIxcHggc29saWQgcmdiYSgwLDAsMCwwLjA4KSIsY3Vyc29yOiJwb2ludGVyIiwKICAgICAgICAgICAgYmFja2dyb3VuZDoiI2ZmZiIsZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciJ9fT4KICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTNweCIsZm9udFdlaWdodDoiNzAwIn19PntwLmNsaWVudF9uYW1lfTwvZGl2PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiIjNTU1In19PntwLmNoYW5uZWx9IMK3IHtwLnByZXBfaWR9PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246InJpZ2h0In19PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE0cHgiLGZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6IiMyRTZCNUUifX0+e2ZtdChwLmFtb3VudCl9IOKCuDwvZGl2PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEwcHgiLGNvbG9yOiIjYWFhIn19PtCy0YvQsdGA0LDRgtGMPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj47CiAgICAgIH0pfQogICAgPC9kaXY+fQogICAgey8qINCj0LzQvdGL0LUg0LrQvdC+0L/QutC4INC/0YDQuNGH0LjQvSAqL30KICAgIHshb2smJmRpYWdCdG5zLmxlbmd0aD4wJiY8ZGl2PgogICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEwcHgiLGZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6IiNiMzVjMDAiLGxldHRlclNwYWNpbmc6IjAuMDZlbSIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixtYXJnaW5Cb3R0b206IjZweCJ9fT7wn5SNINCf0YDQuNGH0LjQvdCwINGA0LDRgdGF0L7QttC00LXQvdC40Y86PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixmbGV4RGlyZWN0aW9uOiJjb2x1bW4iLGdhcDoiNXB4In19PgogICAgICAgIHtkaWFnQnRucy5tYXAoYnRuPT57CiAgICAgICAgICBjb25zdCBzZWw9cmVhc29uPT09YnRuLnZhbDsKICAgICAgICAgIHJldHVybiA8YnV0dG9uIGtleT17YnRuLmlkfSBvbkNsaWNrPXsoKT0+b25SZWFzb25DaGFuZ2Uoc2VsPyIiOmJ0bi52YWwpfQogICAgICAgICAgICBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGFsaWduSXRlbXM6ImNlbnRlciIsZ2FwOiIxMHB4IixwYWRkaW5nOiI5cHggMTJweCIsYm9yZGVyUmFkaXVzOiI4cHgiLAogICAgICAgICAgICAgIGJvcmRlcjoiMS41cHggc29saWQgIisoc2VsPyIjMkU2QjVFIjoicmdiYSgwLDAsMCwwLjEyKSIpLAogICAgICAgICAgICAgIGJhY2tncm91bmQ6c2VsPyJyZ2JhKDQ2LDEwNyw5NCwwLjEpIjoicmdiYSgyNTUsMjU1LDI1NSwwLjcpIiwKICAgICAgICAgICAgICBjdXJzb3I6InBvaW50ZXIiLGZvbnRGYW1pbHk6ImluaGVyaXQiLHRleHRBbGlnbjoibGVmdCJ9fT4KICAgICAgICAgICAgPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTZweCJ9fT57YnRuLmljb259PC9zcGFuPgogICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjpzZWw/IiMyRTZCNUUiOiIjMWExYTFhIixmb250V2VpZ2h0OnNlbD8iNzAwIjoiNDAwIn19PntidG4udGV4dH08L3NwYW4+CiAgICAgICAgICAgIHtzZWwmJjxzcGFuIHN0eWxlPXt7bWFyZ2luTGVmdDoiYXV0byIsY29sb3I6IiMyRTZCNUUifX0+4pyTPC9zcGFuPn0KICAgICAgICAgIDwvYnV0dG9uPjsKICAgICAgICB9KX0KICAgICAgPC9kaXY+CiAgICA8L2Rpdj59CiAgICB7Lyog0KHQstC+0Y8g0L/RgNC40YfQuNC90LAgKi99CiAgICB7IW9rJiYhZGlhZ0J0bnMuc29tZShiPT5iLnZhbD09PXJlYXNvbikmJjx0ZXh0YXJlYQogICAgICBzdHlsZT17ey4uLkZTLGZvbnRTaXplOiIxMnB4IixwYWRkaW5nOiI4cHggMTJweCIsbWFyZ2luVG9wOiI4cHgiLG1pbkhlaWdodDoiNTJweCIscmVzaXplOiJ2ZXJ0aWNhbCJ9fQogICAgICBwbGFjZWhvbGRlcj0i0J7Qv9C40YjQuCDQv9GA0LjRh9C40L3RgyDRgdCy0L7QuNC80Lgg0YHQu9C+0LLQsNC80LguLi4iCiAgICAgIHZhbHVlPXtyZWFzb258fCIifQogICAgICBvbkNoYW5nZT17ZT0+b25SZWFzb25DaGFuZ2UoZS50YXJnZXQudmFsdWUpfQogICAgLz59CiAgPC9kaXY+Owp9CgovLyDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKLy8g0KHQotCg0JDQndCY0KbQkCDQn9Cg0J7QlNCQ0JLQptCQCi8vIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkApjb25zdCBFTVBUWV9TSElGVCA9IHsKICBkYXRlOnRvZGF5U3RyKCksIHNlbGxlcjoiIiwKICByS2FzcGk6IiIsck9ubGluZToiIixySGFseWs6IiIsckhhbHlrT25saW5lOiIiLHJDYXNoOiIiLHJQZXJzb25hbDoiIixyQm9udXM6IiIsCiAgclJldEthc3BpOiIiLHJSZXRIYWx5azoiIixyUmV0Q2FzaDoiIiwKICB0S2FzcGk6IiIsdEthc3BpUmV0OiIiLHRIYWx5azoiIix0SGFseWtSZXQ6IiIsdFBlcnNvbmFsOiIiLAogIGNhc2hPcGVuOiIiLGNhc2hBY3R1YWw6IiIsY2FzaFBheW91dHM6IiIsaW5rYXNzbzoiIiwKICBzaGlmdFN0YXR1czoiIixub3RlczoiIgp9OwoKZnVuY3Rpb24gU2VsbGVyUGFnZSgpewogIGNvbnN0IFt0YWIsc2V0VGFiXT11c2VTdGF0ZSgib3BlbiIpOyAvLyBvcGVuIHwgY2xvc2UgfCBwcmVwYXkKICBjb25zdCBbc2hpZnQsc2V0U2hpZnRdPXVzZVN0YXRlKEVNUFRZX1NISUZUKTsKICBjb25zdCB1cGQ9KGssdik9PnNldFNoaWZ0KHA9Pih7Li4ucCxba106dn0pKTsKICBjb25zdCBbb2NyTG9ja2VkLHNldE9jckxvY2tlZF09dXNlU3RhdGUoZmFsc2UpOwogIGNvbnN0IFtvY3JTdGF0ZSxzZXRPY3JTdGF0ZV09dXNlU3RhdGUoe30pOwogIGNvbnN0IFtwaG90b3Msc2V0UGhvdG9zXT11c2VTdGF0ZSh7ejpudWxsLGthc3BpOm51bGwsaGFseWs6bnVsbH0pOyAvLyBiYXNlNjQg0YTQvtGC0L4KICBjb25zdCBbYXR0YWNoZWRJbmNvbWluZyxzZXRBdHRhY2hlZEluY29taW5nXT11c2VTdGF0ZSh7a2FzcGk6W10saGFseWs6W10sY2FzaDpbXSxwZXJzb25hbDpbXX0pOwogIGNvbnN0IFtvcGVuUHJlcGF5cyxzZXRPcGVuUHJlcGF5c109dXNlU3RhdGUoW10pOwogIGNvbnN0IFtsb2FkaW5nUHJlcGF5cyxzZXRMb2FkaW5nUHJlcGF5c109dXNlU3RhdGUoZmFsc2UpOwogIGNvbnN0IFtwcmVwYXlMaXN0VGFiLHNldFByZXBheUxpc3RUYWJdPXVzZVN0YXRlKCJvcGVuIik7CiAgY29uc3QgW3ByZXBheUZvcm0sc2V0UHJlcGF5Rm9ybV09dXNlU3RhdGUoe2NsaWVudDoiIixwaG9uZToiKzciLGNoYW5uZWw6Ikthc3BpIixhbW91bnQ6IiIsYmFsYW5jZToiIixub3RlczoiIn0pOwogIGNvbnN0IFtwcmVwYXlJdGVtcyxzZXRQcmVwYXlJdGVtc109dXNlU3RhdGUoW3tuYW1lOiIiLHByaWNlOiIiLHBhaWQ6IiIsc3RhdHVzOiLQvtC20LjQtNCw0LXRgtGB0Y8ifV0pOwogIGNvbnN0IFtzYXZpbmcsc2V0U2F2aW5nXT11c2VTdGF0ZShmYWxzZSk7CiAgY29uc3QgW3NhdmVkLHNldFNhdmVkXT11c2VTdGF0ZShmYWxzZSk7CiAgY29uc3QgW3Nob3dSZXN1bHQsc2V0U2hvd1Jlc3VsdF09dXNlU3RhdGUoZmFsc2UpOwogIGNvbnN0IFtjb3BpZWQsc2V0Q29waWVkXT11c2VTdGF0ZShmYWxzZSk7CgogIC8vINCe0YLQutGA0YvRgtC40LUg0YHQvNC10L3RiwogIGNvbnN0IFtvcGVuRm9ybSxzZXRPcGVuRm9ybV09dXNlU3RhdGUoe3NlbGxlcjoiIixjYXNoT3BlbjoiIixkYXRlOnRvZGF5U3RyKCl9KTsKICBjb25zdCBbb3BlblNhdmVkLHNldE9wZW5TYXZlZF09dXNlU3RhdGUoZmFsc2UpOwogIGNvbnN0IFtvcGVuU2F2aW5nLHNldE9wZW5TYXZpbmddPXVzZVN0YXRlKGZhbHNlKTsKICBjb25zdCBbcHJldkNhc2hFbmQsc2V0UHJldkNhc2hFbmRdPXVzZVN0YXRlKG51bGwpOyAvLyDQvtGB0YLQsNGC0L7QuiDQutCw0YHRgdGLINGBINC/0YDQvtGI0LvQvtC5INGB0LzQtdC90YsKCiAgLy8g0JDQstGC0L7Qt9Cw0LPRgNGD0LfQutCwIGNhc2hPcGVuINC40Lcg0L7RgtC60YDRi9GC0L7QuSDRgdC80LXQvdGLINC/0YDQuCDQstGL0LHQvtGA0LUg0L/RgNC+0LTQsNCy0YbQsAogIGNvbnN0IGxvYWRTaGlmdENhc2hPcGVuPWFzeW5jKHNlbGxlcik9PnsKICAgIGlmKCFzZWxsZXIpIHJldHVybjsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGVuY29kZWQ9ZW5jb2RlVVJJQ29tcG9uZW50KHNlbGxlcik7CiAgICAgIC8vINCY0YnQtdC8INC30LAg0L/QvtGB0LvQtdC00L3QuNC1IDIwINGH0LDRgdC+0LIg0LIgVVRDICjQv9C+0LrRgNGL0LLQsNC10YIg0YHQtdCz0L7QtNC90Y/RiNC90LjQuSDQtNC10L3RjCDQkNGB0YLQsNC90LAgVVRDKzUpCiAgICAgIGNvbnN0IHNpbmNlPW5ldyBEYXRlKERhdGUubm93KCktMjAqNjAqNjAqMTAwMCkudG9JU09TdHJpbmcoKTsKICAgICAgLy8gMS4g0J/QviDQuNC80LXQvdC4INC/0YDQvtC00LDQstGG0LAg0LfQsCDQv9C+0YHQu9C10LTQvdC40LUgMjAg0YfQsNGB0L7QsgogICAgICBjb25zdCBkYXRhPWF3YWl0IHNiRmV0Y2goIm9wZW5fc2hpZnRzIiwiR0VUIixudWxsLAogICAgICAgIGA/c2VsbGVyPWVxLiR7ZW5jb2RlZH0mc3RhcnRfdGltZT1ndGUuJHtzaW5jZX0mb3JkZXI9c3RhcnRfdGltZS5kZXNjJmxpbWl0PTVgKTsKICAgICAgaWYoZGF0YSYmZGF0YS5sZW5ndGg+MCl7CiAgICAgICAgLy8g0JHQtdGA0ZHQvCDQt9Cw0L/QuNGB0Ywg0YEg0L3QsNC40LHQvtC70YzRiNC40LwgY2FzaF9vcGVuINC60L7RgtC+0YDRi9C5INCy0LLQtdC00ZHQvSDRgdC10LPQvtC00L3RjwogICAgICAgIGNvbnN0IHRvZGF5U3RyMj10b2RheVN0cigpOyAvLyDQkNGB0YLQsNC90LAg0LTQsNGC0LAKICAgICAgICBjb25zdCB0b2RheVJlY29yZD1kYXRhLmZpbmQocj0+ci5jYXNoX29wZW4hPW51bGwmJnIuc3RhcnRfdGltZSYmCiAgICAgICAgICAobmV3IERhdGUoci5zdGFydF90aW1lKS50b0xvY2FsZURhdGVTdHJpbmcoJ3J1LVJVJyx7dGltZVpvbmU6J0FzaWEvQWxtYXR5J30pLnNwbGl0KCcuJykucmV2ZXJzZSgpLmpvaW4oJy0nKT09PXRvZGF5U3RyMnx8CiAgICAgICAgICAgci5zdGFydF90aW1lLnNsaWNlKDAsMTApPT09dG9kYXlTdHIyKSk7CiAgICAgICAgaWYodG9kYXlSZWNvcmQpe3VwZCgiY2FzaE9wZW4iLFN0cmluZyh0b2RheVJlY29yZC5jYXNoX29wZW4pKTtyZXR1cm47fQogICAgICAgIC8vINCR0LXRgNGR0Lwg0L/QtdGA0LLRi9C5INGBIGNhc2hfb3BlbgogICAgICAgIGNvbnN0IGFueVJlY29yZD1kYXRhLmZpbmQocj0+ci5jYXNoX29wZW4hPW51bGwpOwogICAgICAgIGlmKGFueVJlY29yZCl7dXBkKCJjYXNoT3BlbiIsU3RyaW5nKGFueVJlY29yZC5jYXNoX29wZW4pKTtyZXR1cm47fQogICAgICB9CiAgICAgIC8vIDIuINCS0YHQtSDRgdC80LXQvdGLINC30LAg0L/QvtGB0LvQtdC00L3QuNC1IDIwINGH0LDRgdC+0LIg4oCUINC40YnQtdC8INC/0L4g0LjQvNC10L3QuAogICAgICBjb25zdCBhbGw9YXdhaXQgc2JGZXRjaCgib3Blbl9zaGlmdHMiLCJHRVQiLG51bGwsCiAgICAgICAgYD9zdGFydF90aW1lPWd0ZS4ke3NpbmNlfSZvcmRlcj1zdGFydF90aW1lLmRlc2MmbGltaXQ9NTBgKTsKICAgICAgY29uc3QgbWF0Y2g9YWxsJiZhbGwuZmluZChyPT5TdHJpbmcoci5zZWxsZXJ8fCIiKS50cmltKCk9PT1TdHJpbmcoc2VsbGVyKS50cmltKCkmJnIuY2FzaF9vcGVuIT1udWxsKTsKICAgICAgaWYobWF0Y2gpe3VwZCgiY2FzaE9wZW4iLFN0cmluZyhtYXRjaC5jYXNoX29wZW4pKTt9CiAgICAgIC8vINCV0YHQu9C4INC90LjRh9C10LPQviDQvdC1INC90LDRiNC70Lgg4oCUINC/0L7Qu9C1INC+0YHRgtCw0ZHRgtGB0Y8g0L/Rg9GB0YLRi9C8LCDQv9GA0L7QtNCw0LLQtdGGINCy0LLQvtC00LjRgiDRgdCw0LwKICAgIH0gY2F0Y2goZSl7Y29uc29sZS53YXJuKCJsb2FkU2hpZnRDYXNoT3BlbjoiLGUubWVzc2FnZSk7fQogIH07CgogIC8vINCg0LDRgdGH0ZHRgtGLCiAgY29uc3QgcD1zaGlmdDsKICBjb25zdCBjYXNoQWN0dWFsRmlsbGVkPXBhcnNlKHAuY2FzaEFjdHVhbCk+MHx8cC5jYXNoQWN0dWFsIT09IiI7CiAgLy8gY2FzaFNhbGVzRmFjdDog0LjRgdC/0L7Qu9GM0LfRg9C10LwgckNhc2gg0LjQtyBST1NUQSDQutCw0Log0LjRgdGC0L7Rh9C90LjQuiDQuNGB0YLQuNC90Ysg0LTQu9GPINC/0YDQvtC00LDQtgogIC8vIGNhc2hBY3R1YWwg0L3Rg9C20LXQvSDRgtC+0LvRjNC60L4g0LTQu9GPINGB0LLQtdGA0LrQuCDRhNC40LfQuNGH0LXRgdC60L7QuSDQutCw0YHRgdGLCiAgY29uc3QgY2FzaFNhbGVzRmFjdCA9IHBhcnNlKHAuckNhc2gpID4gMAogICAgPyBwYXJzZShwLnJDYXNoKSAtIHBhcnNlKHAuclJldENhc2gpICAvLyBST1NUQSDQvdCw0LvQuNGH0L3Ri9C1ICjQuNGB0YLQvtGH0L3QuNC6INC40YHRgtC40L3RiykKICAgIDogTWF0aC5tYXgoMCwgY2FzaEFjdHVhbEZpbGxlZCAgICAgICAgLy8g0LXRgdC70Lgg0LIgUk9TVEEgMCDigJQg0LHQtdGA0ZHQvCDQuNC3INGE0LDQutGC0LAKICAgICAgICA/IHBhcnNlKHAuY2FzaEFjdHVhbCktcGFyc2UocC5jYXNoT3BlbikrcGFyc2UocC5jYXNoUGF5b3V0cykrcGFyc2UocC5pbmthc3NvKQogICAgICAgIDogMCk7CiAgLy8g0KHQstC10YDQutCwINC60LDRgdGB0Ys6INC+0LbQuNC00LDQu9C+0YHRjCB2cyDRhNCw0LrRgiAo0L7RgtC00LXQu9GM0L3QviDQvtGCINC/0YDQvtC00LDQtikKICBjb25zdCBjYXNoRXhwZWN0ZWQgPSBwYXJzZShwLmNhc2hPcGVuKSArIHBhcnNlKHAuckNhc2gpIC0gcGFyc2UocC5yUmV0Q2FzaCkgLSBwYXJzZShwLmlua2Fzc28pOwogIGNvbnN0IGNhc2hCb3hEaWZmID0gY2FzaEFjdHVhbEZpbGxlZCA/IHBhcnNlKHAuY2FzaEFjdHVhbCkgLSBjYXNoRXhwZWN0ZWQgOiAwOwogIGNvbnN0IHRvdGFsUmV0dXJucz1wYXJzZShwLnJSZXRLYXNwaSkrcGFyc2UocC5yUmV0SGFseWspK3BhcnNlKHAuclJldENhc2gpOwogIGNvbnN0IHJvc3RhVG90YWw9cGFyc2UocC5yS2FzcGkpK3BhcnNlKHAuck9ubGluZSkrcGFyc2UocC5ySGFseWspK3BhcnNlKHAuckhhbHlrT25saW5lKStwYXJzZShwLnJDYXNoKStwYXJzZShwLnJQZXJzb25hbCkrcGFyc2UocC5yQm9udXMpLXRvdGFsUmV0dXJuczsKICAvLyDQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsDog0LXRgdC70Lgg0YTQsNC60YIg0L3QtSDQstCy0LXQtNGR0L0g4oCUINCx0LXRgNGR0Lwg0LjQtyBST1NUQQogIGNvbnN0IHBlcnNvbmFsRmFjdCA9IHBhcnNlKHAudFBlcnNvbmFsKT4wID8gcGFyc2UocC50UGVyc29uYWwpIDogcGFyc2UocC5yUGVyc29uYWwpOwogIGNvbnN0IGZhY3RUb3RhbD0ocGFyc2UocC50S2FzcGkpLXBhcnNlKHAudEthc3BpUmV0KSkrKHBhcnNlKHAudEhhbHlrKS1wYXJzZShwLnRIYWx5a1JldCkpK2Nhc2hTYWxlc0ZhY3QrcGVyc29uYWxGYWN0K3BhcnNlKHAuckJvbnVzKTsKICBjb25zdCB0b3RhbERpZmY9ZmFjdFRvdGFsLXJvc3RhVG90YWw7CiAgY29uc3QgaXNPaz1NYXRoLmFicyh0b3RhbERpZmYpPDUwMDsKCiAgY29uc3QgZGlmZkthc3BpPShwYXJzZShwLnRLYXNwaSktcGFyc2UocC50S2FzcGlSZXQpKS0oKHBhcnNlKHAuckthc3BpKStwYXJzZShwLnJPbmxpbmUpKS1wYXJzZShwLnJSZXRLYXNwaSkpOwogIGNvbnN0IGRpZmZIYWx5az0ocGFyc2UocC50SGFseWspLXBhcnNlKHAudEhhbHlrUmV0KSktKChwYXJzZShwLnJIYWx5aykrcGFyc2UocC5ySGFseWtPbmxpbmUpKS1wYXJzZShwLnJSZXRIYWx5aykpOwogIGNvbnN0IGRpZmZDYXNoPWNhc2hTYWxlc0ZhY3QtcGFyc2UocC5yQ2FzaCk7CgogIGNvbnN0IGF0dGFjaFByZXBheT1hc3luYyhjaGFubmVsLHByZXAscmVtb3ZlLGlzSXNzdWUpPT57CiAgICBzZXRBdHRhY2hlZEluY29taW5nKHByZXY9PnsKICAgICAgY29uc3QgbGlzdD1wcmV2W2NoYW5uZWxdfHxbXTsKICAgICAgY29uc3QgdXBkYXRlZD1yZW1vdmU/bGlzdC5maWx0ZXIoeD0+eC5pZCE9PXByZXAuaWQpOlsuLi5saXN0LHByZXBdOwogICAgICByZXR1cm4gey4uLnByZXYsW2NoYW5uZWxdOnVwZGF0ZWR9OwogICAgfSk7CiAgICAvLyDQodGC0LDRgtGD0YEg0LzQtdC90Y/QtdGC0YHRjyDQotCe0JvQrNCa0J4g0L/RgNC4INGP0LLQvdC+0Lkg0LLRi9C00LDRh9C1INGC0L7QstCw0YDQsCAoaXNJc3N1ZT10cnVlKQogICAgLy8g0J/RgNC4INC/0YDQvtGB0YLQvtC8INC/0L7QtNGC0Y/Qs9C40LLQsNC90LjQuCDQtNC70Y8g0L7QsdGK0Y/RgdC90LXQvdC40Y8g0YDQsNGB0YXQvtC20LTQtdC90LjRjyDigJQg0YHRgtCw0YLRg9GBINC90LUg0LzQtdC90Y/QtdGC0YHRjwogICAgLy8g0K3RgtC+INC/0L7Qt9Cy0L7Qu9GP0LXRgjog0JTQtdC90YwgMSDQv9C+0LTRgtGP0L3Rg9GC0YwsINGB0YLQsNGC0YPRgSDQvtGB0YLQsNGR0YLRgdGPINCe0YLQutGA0YvRgtCwCiAgICAvLyAgICAgICAgICAgICAgINCU0LXQvdGMIDIgKNC60L3QvtC/0LrQsCDQktGL0LTQsNGC0YwpIOKGkiDRgdGC0LDRgtGD0YEg0JLRi9C00LDQvSwgYmFsYW5jZT0wCiAgICBpZighcmVtb3ZlJiZwcmVwLmlkJiZpc0lzc3VlKXsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCBzYkZldGNoKCJwcmVwYXltZW50cyIsIlBBVENIIiwKICAgICAgICAgIHtzdGF0dXM6Ilx1RDgzRFx1REZFMiDQktGL0LTQsNC9IixiYWxhbmNlOjAsbm90ZXM6ItCi0L7QstCw0YAg0LLRi9C00LDQvSDCtyAiK3RvZGF5U3RyKCl9LAogICAgICAgICAgYD9pZD1lcS4ke3ByZXAuaWR9YAogICAgICAgICk7CiAgICAgIH0gY2F0Y2goZSl7Y29uc29sZS53YXJuKCJjbG9zZVByZXBheToiLGUubWVzc2FnZSk7fQogICAgfQogIH07CgogIGNvbnN0IGxvYWRPcGVuUHJlcGF5cz1hc3luYyh0YWIpPT57CiAgICBzZXRMb2FkaW5nUHJlcGF5cyh0cnVlKTsKICAgIGNvbnN0IHQ9dGFifHxwcmVwYXlMaXN0VGFifHwib3BlbiI7CiAgICB0cnkgewogICAgICBjb25zdCBmaWx0ZXI9dD09PSJvcGVuIgogICAgICAgID8iP3N0YXR1cz1lcS5cdUQ4M0RcdURGRTEg0J7RgtC60YDRi9GC0LAmb3JkZXI9cHJlcF9kYXRlLmFzYyIKICAgICAgICA6Ij9zdGF0dXM9aW4uKFx1RDgzRFx1REZFMiDQktGL0LTQsNC9LFx1RDgzRFx1REZFMiDQl9Cw0LrRgNGL0YLQsCkmb3JkZXI9cHJlcF9kYXRlLmRlc2MmbGltaXQ9NTAiOwogICAgICBjb25zdCBkYXRhPWF3YWl0IHNiRmV0Y2goInByZXBheW1lbnRzIiwiR0VUIixudWxsLGZpbHRlcik7CiAgICAgIHNldE9wZW5QcmVwYXlzKGRhdGF8fFtdKTsKICAgIH0gY2F0Y2goZSl7Y29uc29sZS5lcnJvcihlKTt9CiAgICBzZXRMb2FkaW5nUHJlcGF5cyhmYWxzZSk7CiAgfTsKCiAgLy8gT0NSINGH0LXRgNC10LcgUmFpbHdheSDRgdC10YDQstC10YAKICBjb25zdCBoYW5kbGVQaG90b09DUj1hc3luYyh0eXBlLGZpbGUpPT57CiAgICBpZighZmlsZSlyZXR1cm47CiAgICBjb25zdCByZWFkZXI9bmV3IEZpbGVSZWFkZXIoKTsKICAgIHJlYWRlci5vbmxvYWQ9YXN5bmMoZSk9PnsKICAgICAgY29uc3QgYmFzZTY0PWUudGFyZ2V0LnJlc3VsdC5zcGxpdCgiLCIpWzFdOwogICAgICBjb25zdCBtaW1lVHlwZT1maWxlLnR5cGV8fCJpbWFnZS9qcGVnIjsKICAgICAgc2V0T2NyU3RhdGUocHJldj0+KHsuLi5wcmV2LFt0eXBlKyJMb2FkaW5nIl06dHJ1ZSxbdHlwZSsiRXJyb3IiXToiIn0pKTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBwcm9tcHRzPXsKICAgICAgICAgIHo6ICLQrdGC0L4gWi3QvtGC0YfRkdGCIFJPU1RBLiDQktC10YDQvdC4INCi0J7Qm9Cs0JrQniBKU09OOlxue1wia2FzcGlfcXJcIjowLFwib25saW5lX2thc3BpXCI6MCxcImhhbHlrX3FyXCI6MCxcIm9ubGluZV9oYWx5a1wiOjAsXCJjYXNoXCI6MCxcInBlcnNvbmFsXCI6MCxcImJvbnVzXCI6MCxcInJldF9rYXNwaV9xclwiOjAsXCJyZXRfb25saW5lX2thc3BpXCI6MCxcInJldF9oYWx5a1wiOjAsXCJyZXRfY2FzaFwiOjB9XG7QktCQ0JbQndCeOiDQstGB0LUg0LLQvtC30LLRgNCw0YLRiyDQv9C+0LvQvtC20LjRgtC10LvRjNC90YvQtSDRh9C40YHQu9CwLiDQmNGJ0Lgg0YHRgtGA0L7QutC4INGBICfQktC+0LfQstGA0LDRgicuIiwKICAgICAgICAgIGthc3BpOiAi0K3RgtC+INC+0YLRh9GR0YIgS2FzcGkg0YLQtdGA0LzQuNC90LDQu9CwLiDQktC10YDQvdC4INCi0J7Qm9Cs0JrQniBKU09OOiB7XCJncm9zc1wiOjAsXCJyZXR1cm5zXCI6MCxcIm5ldFwiOjB9IiwKICAgICAgICAgIGhhbHlrOiAi0K3RgtC+INC+0YLRh9GR0YIgSGFseWsg0YLQtdGA0LzQuNC90LDQu9CwLiDQktC10YDQvdC4INCi0J7Qm9Cs0JrQniBKU09OOiB7XCJncm9zc1wiOjAsXCJyZXR1cm5zXCI6MCxcIm5ldFwiOjB9IgogICAgICAgIH07CiAgICAgICAgY29uc3QgcmVzPWF3YWl0IGZldGNoKGAke0FQSV9VUkx9L2FwaS9vY3JgLHsKICAgICAgICAgIG1ldGhvZDoiUE9TVCIsCiAgICAgICAgICBoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7YmFzZTY0LG1pbWVUeXBlLHByb21wdDpwcm9tcHRzW3R5cGVdfSkKICAgICAgICB9KTsKICAgICAgICBjb25zdCBqc29uPWF3YWl0IHJlcy5qc29uKCk7CiAgICAgICAgY29uc3QgdGV4dD0oanNvbi50ZXh0fHwiIikucmVwbGFjZSgvYGBganNvbnxgYGAvZywiIikudHJpbSgpOwogICAgICAgIGNvbnN0IHBhcnNlZD1KU09OLnBhcnNlKHRleHQpOwogICAgICAgIC8vINCh0L7RhdGA0LDQvdGP0LXQvCDRhNC+0YLQviDQtNC70Y8g0L7RgtC/0YDQsNCy0LrQuCDQsiBUZWxlZ3JhbQogICAgICAgIHNldFBob3RvcyhwcmV2PT4oey4uLnByZXYsW3R5cGVdOmJhc2U2NH0pKTsKICAgICAgICBpZih0eXBlPT09InoiKXsKICAgICAgICAgIHNldFNoaWZ0KHByZXY9Pih7Li4ucHJldiwKICAgICAgICAgICAgckthc3BpOiAgICAgcGFyc2VkLmthc3BpX3FyICAgICA+MD9TdHJpbmcocGFyc2VkLmthc3BpX3FyKSAgICA6cHJldi5yS2FzcGksCiAgICAgICAgICAgIHJPbmxpbmU6ICAgIHBhcnNlZC5vbmxpbmVfa2FzcGkgID4wP1N0cmluZyhwYXJzZWQub25saW5lX2thc3BpKSA6cHJldi5yT25saW5lLAogICAgICAgICAgICBySGFseWs6ICAgICBwYXJzZWQuaGFseWtfcXIgICAgID4wP1N0cmluZyhwYXJzZWQuaGFseWtfcXIpICAgIDpwcmV2LnJIYWx5aywKICAgICAgICAgICAgckhhbHlrT25saW5lOnBhcnNlZC5vbmxpbmVfaGFseWs+MD9TdHJpbmcocGFyc2VkLm9ubGluZV9oYWx5aykgOnByZXYuckhhbHlrT25saW5lLAogICAgICAgICAgICByQ2FzaDogICAgICBwYXJzZWQuY2FzaCAgICAgICAgID4wP1N0cmluZyhwYXJzZWQuY2FzaCkgICAgICAgICA6cHJldi5yQ2FzaCwKICAgICAgICAgICAgckJvbnVzOiAgICAgcGFyc2VkLmJvbnVzICAgICAgICA+MD9TdHJpbmcocGFyc2VkLmJvbnVzKSAgICAgICAgOnByZXYuckJvbnVzLAogICAgICAgICAgICByUGVyc29uYWw6ICBwYXJzZWQucGVyc29uYWwgICAgID4wP1N0cmluZyhwYXJzZWQucGVyc29uYWwpICAgICA6cHJldi5yUGVyc29uYWwsCiAgICAgICAgICAgIHJSZXRLYXNwaTogIChwYXJzZWQucmV0X2thc3BpX3FyfHwwKSsocGFyc2VkLnJldF9vbmxpbmVfa2FzcGl8fDApPjA/U3RyaW5nKChwYXJzZWQucmV0X2thc3BpX3FyfHwwKSsocGFyc2VkLnJldF9vbmxpbmVfa2FzcGl8fDApKTpwcmV2LnJSZXRLYXNwaSwKICAgICAgICAgICAgclJldEhhbHlrOiAgcGFyc2VkLnJldF9oYWx5ayAgICA+MD9TdHJpbmcocGFyc2VkLnJldF9oYWx5aykgICAgOnByZXYuclJldEhhbHlrLAogICAgICAgICAgICByUmV0Q2FzaDogICBwYXJzZWQucmV0X2Nhc2ggICAgID4wP1N0cmluZyhwYXJzZWQucmV0X2Nhc2gpICAgICA6cHJldi5yUmV0Q2FzaCwKICAgICAgICAgIH0pKTsKICAgICAgICAgIHNldE9jckxvY2tlZCh0cnVlKTsKICAgICAgICB9IGVsc2UgaWYodHlwZT09PSJrYXNwaSIpewogICAgICAgICAgc2V0U2hpZnQocHJldj0+KHsuLi5wcmV2LAogICAgICAgICAgICB0S2FzcGk6ICAgIHBhcnNlZC5ncm9zcz4wP1N0cmluZyhwYXJzZWQuZ3Jvc3MpOnByZXYudEthc3BpLAogICAgICAgICAgICB0S2FzcGlSZXQ6IHBhcnNlZC5yZXR1cm5zPjA/U3RyaW5nKHBhcnNlZC5yZXR1cm5zKTpwcmV2LnRLYXNwaVJldCwKICAgICAgICAgIH0pKTsKICAgICAgICB9IGVsc2UgaWYodHlwZT09PSJoYWx5ayIpewogICAgICAgICAgc2V0U2hpZnQocHJldj0+KHsuLi5wcmV2LAogICAgICAgICAgICB0SGFseWs6ICAgIHBhcnNlZC5ncm9zcz4wP1N0cmluZyhwYXJzZWQuZ3Jvc3MpOnByZXYudEhhbHlrLAogICAgICAgICAgICB0SGFseWtSZXQ6IHBhcnNlZC5yZXR1cm5zPjA/U3RyaW5nKHBhcnNlZC5yZXR1cm5zKTpwcmV2LnRIYWx5a1JldCwKICAgICAgICAgIH0pKTsKICAgICAgICB9CiAgICAgICAgc2V0T2NyU3RhdGUocHJldj0+KHsuLi5wcmV2LFt0eXBlKyJMb2FkaW5nIl06ZmFsc2UsW3R5cGUrIkRvbmUiXTp0cnVlfSkpOwogICAgICB9IGNhdGNoKGVycil7CiAgICAgICAgc2V0T2NyU3RhdGUocHJldj0+KHsuLi5wcmV2LFt0eXBlKyJMb2FkaW5nIl06ZmFsc2UsW3R5cGUrIkVycm9yIl06ItCe0YjQuNCx0LrQsDogIitlcnIubWVzc2FnZX0pKTsKICAgICAgfQogICAgfTsKICAgIHJlYWRlci5yZWFkQXNEYXRhVVJMKGZpbGUpOwogIH07CgogIGNvbnN0IGJ1aWxkUmVwb3J0PSgpPT57CiAgICBjb25zdCBkPWZtdERhdGUoc2hpZnQuZGF0ZSk7CiAgICBsZXQgdD1g8J+TiyBOQU5FIFBBUklTIOKAlCDQl9Cw0LrRgNGL0YLQuNC1INGB0LzQtdC90YtcbvCfk4UgJHtkfSB8IPCfkaQgJHtzaGlmdC5zZWxsZXJ9XG4keyLilIAiLnJlcGVhdCgzMil9XG5gOwogICAgdCs9YFxu8J+TiiBST1NUQSDQmNCi0J7Qk9CeOiAke2ZtdChyb3N0YVRvdGFsKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuckthc3BpKT4wKXQrPWAgIEthc3BpIFFSOiAke2ZtdChwYXJzZShzaGlmdC5yS2FzcGkpKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuck9ubGluZSk+MCl0Kz1gICDQntC90LvQsNC50L0gS2FzcGk6ICR7Zm10KHBhcnNlKHNoaWZ0LnJPbmxpbmUpKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuckhhbHlrKT4wKXQrPWAgIEhhbHlrIFFSOiAke2ZtdChwYXJzZShzaGlmdC5ySGFseWspKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuckhhbHlrT25saW5lKT4wKXQrPWAgINCe0L3Qu9Cw0LnQvSBIYWx5azogJHtmbXQocGFyc2Uoc2hpZnQuckhhbHlrT25saW5lKSl9IOKCuFxuYDsKICAgIGlmKHBhcnNlKHNoaWZ0LnJDYXNoKT4wKXQrPWAgINCd0LDQu9C40YfQvdGL0LU6ICR7Zm10KHBhcnNlKHNoaWZ0LnJDYXNoKSl9IOKCuFxuYDsKICAgIGlmKHBhcnNlKHNoaWZ0LnJQZXJzb25hbCk+MCl0Kz1gICDQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsDogJHtmbXQocGFyc2Uoc2hpZnQuclBlcnNvbmFsKSl9IOKCuFxuYDsKICAgIGlmKHBhcnNlKHNoaWZ0LnJCb251cyk+MCl0Kz1gICDQkdC+0L3Rg9GB0Ys6ICR7Zm10KHBhcnNlKHNoaWZ0LnJCb251cykpfSDigrhcbmA7CiAgICBpZihwYXJzZShzaGlmdC5yUmV0S2FzcGkpPjApdCs9YCAg0JLQvtC30LLRgNCw0YIgS2FzcGk6IC0ke2ZtdChwYXJzZShzaGlmdC5yUmV0S2FzcGkpKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuclJldEhhbHlrKT4wKXQrPWAgINCS0L7Qt9Cy0YDQsNGCIEhhbHlrOiAtJHtmbXQocGFyc2Uoc2hpZnQuclJldEhhbHlrKSl9IOKCuFxuYDsKICAgIHQrPWBcbvCfkrMg0KLQldCg0JzQmNCd0JDQm9CrXG5gOwogICAgdCs9YCAgS2FzcGk6ICR7Zm10KHBhcnNlKHNoaWZ0LnRLYXNwaSkpfSDigrgke3BhcnNlKHNoaWZ0LnRLYXNwaVJldCk+MD8iICjQstC+0LfQstGA0LDRgiAtIitmbXQocGFyc2Uoc2hpZnQudEthc3BpUmV0KSkrIiDigrgpIjoiIn1cbmA7CiAgICB0Kz1gICBIYWx5azogJHtmbXQocGFyc2Uoc2hpZnQudEhhbHlrKSl9IOKCuCR7cGFyc2Uoc2hpZnQudEhhbHlrUmV0KT4wPyIgKNCy0L7Qt9Cy0YDQsNGCIC0iK2ZtdChwYXJzZShzaGlmdC50SGFseWtSZXQpKSsiIOKCuCkiOiIifVxuYDsKICAgIGlmKHBhcnNlKHNoaWZ0LnRQZXJzb25hbCk+MCl0Kz1gICDQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsDogJHtmbXQocGFyc2Uoc2hpZnQudFBlcnNvbmFsKSl9IOKCuFxuYDsKICAgIHQrPWBcbvCfkrUg0JrQkNCh0KHQkFxuYDsKICAgIHQrPWAgINCe0YLQutGA0YvRgtC40LU6ICR7Zm10KHBhcnNlKHNoaWZ0LmNhc2hPcGVuKSl9IOKCuFxuYDsKICAgIHQrPWAgINCX0LDQutGA0YvRgtC40LU6ICR7Zm10KHBhcnNlKHNoaWZ0LmNhc2hBY3R1YWwpKX0g4oK4XG5gOwogICAgaWYocGFyc2Uoc2hpZnQuaW5rYXNzbyk+MCl0Kz1gICDQmNC90LrQsNGB0YHQsNGG0LjRjzogJHtmbXQocGFyc2Uoc2hpZnQuaW5rYXNzbykpfSDigrhcbmA7CiAgICB0Kz1gXG7wn5OKINCY0KLQntCT0J5cbmA7CiAgICB0Kz1gICBST1NUQTogJHtmbXQocm9zdGFUb3RhbCl9IOKCuFxuYDsKICAgIHQrPWAgINCk0JDQmtCiOiAgJHtmbXQoZmFjdFRvdGFsKX0g4oK4XG5gOwogICAgdCs9YCAgJHtpc09rPyLinIUg0KHRhdC+0LTQuNGC0YHRjyI6IuKaoFx1RkUwRiDQoNCw0LfQvdC40YbQsDogIisodG90YWxEaWZmPjA/IisiOiIiKStmbXQodG90YWxEaWZmKSsiIOKCuCJ9XG5gOwogICAgaWYoc2hpZnQubm90ZXMpdCs9YFxu8J+TnSAke3NoaWZ0Lm5vdGVzfVxuYDsKICAgIHJldHVybiB0OwogIH07CgogIGNvbnN0IGhhbmRsZVNhdmVTaGlmdD1hc3luYygpPT57CiAgICBpZighc2hpZnQuc2VsbGVyfHwhc2hpZnQuZGF0ZSl7YWxlcnQoItCX0LDQv9C+0LvQvdC4INC/0YDQvtC00LDQstGG0LAg0Lgg0LTQsNGC0YMiKTtyZXR1cm47fQogICAgc2V0U2F2aW5nKHRydWUpOwogICAgdHJ5IHsKICAgICAgY29uc3QgZD1zaGlmdC5kYXRlOwogICAgICBjb25zdCByZXZlbnVlPXJvc3RhVG90YWw7CgogICAgICAvLyAxLiDQodC+0YXRgNCw0L3Rj9C10Lwg0LIgU3VwYWJhc2UKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBleGlzdGluZz1hd2FpdCBzYkZldGNoKCJkYWlseV9zYWxlcyIsIkdFVCIsbnVsbCxgP3NhbGVfZGF0ZT1lcS4ke2R9YCk7CiAgICAgICAgaWYoZXhpc3RpbmcmJmV4aXN0aW5nLmxlbmd0aD4wKXsKICAgICAgICAgIGF3YWl0IHNiRmV0Y2goImRhaWx5X3NhbGVzIiwiUEFUQ0giLHtyZXZlbnVlLHNlbGxlcjE6c2hpZnQuc2VsbGVyfSxgP3NhbGVfZGF0ZT1lcS4ke2R9YCk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIGF3YWl0IHNiRmV0Y2goImRhaWx5X3NhbGVzIiwiUE9TVCIsewogICAgICAgICAgICBzYWxlX2RhdGU6ZCxyZXZlbnVlLHNlbGxlcjE6c2hpZnQuc2VsbGVyLHNlbGxlcjI6IiIsCiAgICAgICAgICAgIG1vbnRoOnBhcnNlSW50KGQuc3BsaXQoIi0iKVsxXSkseWVhcjpwYXJzZUludChkLnNwbGl0KCItIilbMF0pCiAgICAgICAgICB9KTsKICAgICAgICB9CiAgICAgIH0gY2F0Y2goZSl7IGNvbnNvbGUud2FybigiU3VwYWJhc2U6IiwgZS5tZXNzYWdlKTsgfQoKICAgICAgLy8gMdCxLiDQodC+0YXRgNCw0L3Rj9C10Lwg0L7RgdGC0LDRgtC+0Log0LrQsNGB0YHRiyDQvdCwINC60L7QvdC10YYg0YHQvNC10L3RiyDihpIg0LHRg9C00LXRgiBjYXNoX29wZW4g0LTQu9GPINGB0LvQtdC00YPRjtGJ0LXQs9C+INC00L3RjwogICAgICAvLyBjYXNoQWN0dWFsIC0gaW5rYXNzbyA9INGA0LXQsNC70YzQvdGL0Lkg0L7RgdGC0LDRgtC+0Log0LIg0LrQsNGB0YHQtSDQv9C+0YHQu9C1INC40L3QutCw0YHRgdCw0YbQuNC4CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgY2FzaEVuZCA9IHBhcnNlKHNoaWZ0LmNhc2hBY3R1YWwpID4gMAogICAgICAgICAgPyBwYXJzZShzaGlmdC5jYXNoQWN0dWFsKSAtIHBhcnNlKHNoaWZ0Lmlua2Fzc298fDApCiAgICAgICAgICA6IHBhcnNlKHNoaWZ0LmNhc2hPcGVufHwwKSArIHBhcnNlKHNoaWZ0LnJDYXNofHwwKSAtIHBhcnNlKHNoaWZ0Lmlua2Fzc298fDApOwogICAgICAgIGlmKGNhc2hFbmQgPj0gMCkgewogICAgICAgICAgLy8g0KPQtNCw0LvRj9C10Lwg0YHRgtCw0YDRg9GOINC30LDQv9C40YHRjCDQuCDRgdC+0LfQtNCw0ZHQvCDQvdC+0LLRg9GOINGBINC+0YHRgtCw0YLQutC+0LwKICAgICAgICAgIGF3YWl0IHNiRmV0Y2goIm9wZW5fc2hpZnRzIiwiREVMRVRFIixudWxsLGA/cGhvbmU9ZXEud2ViXyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNoaWZ0LnNlbGxlcil9YCk7CiAgICAgICAgICBhd2FpdCBzYkZldGNoKCJvcGVuX3NoaWZ0cyIsIlBPU1QiLHsKICAgICAgICAgICAgcGhvbmU6IndlYl8iK3NoaWZ0LnNlbGxlciwKICAgICAgICAgICAgc2VsbGVyOnNoaWZ0LnNlbGxlciwKICAgICAgICAgICAgc2hvcDoiTkFORSBQQVJJUyIsCiAgICAgICAgICAgIGNhc2hfb3BlbjpNYXRoLnJvdW5kKGNhc2hFbmQpLAogICAgICAgICAgICBzdGFydF90aW1lOm5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwKICAgICAgICAgICAgaXNfc2Vjb25kOmZhbHNlCiAgICAgICAgICB9KTsKICAgICAgICB9CiAgICAgIH0gY2F0Y2goZSl7IGNvbnNvbGUud2Fybigi0KHQvtGF0YDQsNC90LXQvdC40LUg0LrQsNGB0YHRizoiLCBlLm1lc3NhZ2UpOyB9CgogICAgICAvLyAyLiDQntGC0L/RgNCw0LLQu9GP0LXQvCDQvtGC0YfRkdGCINCy0LvQsNC00LXQu9GM0YbRgyDQsiBUZWxlZ3JhbQogICAgICB0cnkgewogICAgICAgIGNvbnN0IHByZXBheVRvdGFsPU9iamVjdC52YWx1ZXMoYXR0YWNoZWRJbmNvbWluZykucmVkdWNlKChzLGxpc3QpPT5zK2xpc3QucmVkdWNlKChzcyxwKT0+c3MrcGFyc2UocC5hbW91bnR8fDApLDApLDApOwogICAgICAgICAgYXdhaXQgZmV0Y2goQVBJX1VSTCsiL2FwaS9zaGlmdC1yZXBvcnQiLHsKICAgICAgICAgIG1ldGhvZDoiUE9TVCIsCiAgICAgICAgICBoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICAgIC4uLnNoaWZ0LAogICAgICAgICAgICByb3N0YVRvdGFsLGZhY3RUb3RhbCx0b3RhbERpZmYsaXNPaywKICAgICAgICAgICAgY2FzaFNhbGVzRmFjdCxwcmVwYXlUb3RhbCwKICAgICAgICAgICAgcHJlcGF5Q2xpZW50czpPYmplY3QudmFsdWVzKGF0dGFjaGVkSW5jb21pbmcpLmZsYXQoKS5tYXAocD0+KHsKICAgICAgICAgICAgICBuYW1lOnAuY2xpZW50X25hbWUscGhvbmU6cC5waG9uZSxhbW91bnQ6cC5hbW91bnQsaXRlbTpwLml0ZW0sY2hhbm5lbDpwLmNoYW5uZWwsaWQ6cC5wcmVwX2lkCiAgICAgICAgICAgIH0pKSwKICAgICAgICAgICAgcGhvdG9zOnt6OnBob3Rvcy56fHxudWxsLGthc3BpOnBob3Rvcy5rYXNwaXx8bnVsbCxoYWx5azpwaG90b3MuaGFseWt8fG51bGx9CiAgICAgICAgICB9KQogICAgICAgIH0pOwogICAgICB9IGNhdGNoKGUpeyBjb25zb2xlLndhcm4oIlRlbGVncmFtIG5vdGlmeToiLCBlLm1lc3NhZ2UpOyB9CgogICAgICBzZXRTYXZlZCh0cnVlKTsKICAgICAgc2V0U2hvd1Jlc3VsdCh0cnVlKTsKICAgIH0gY2F0Y2goZSl7YWxlcnQoItCe0YjQuNCx0LrQsDogIitlLm1lc3NhZ2UpO30KICAgIHNldFNhdmluZyhmYWxzZSk7CiAgfTsKCiAgY29uc3QgaGFuZGxlU2F2ZVByZXBheT1hc3luYygpPT57CiAgICBjb25zdCBmPXByZXBheUZvcm07CiAgICBpZighZi5jbGllbnR8fCFmLmFtb3VudCl7YWxlcnQoItCX0LDQv9C+0LvQvdC4INC60LvQuNC10L3RgtCwINC4INGB0YPQvNC80YMiKTtyZXR1cm47fQogICAgdHJ5IHsKICAgICAgLy8g0J/QvtC70YPRh9Cw0LXQvCDRgdC70LXQtNGD0Y7RidC40LkgSUQKICAgICAgY29uc3QgZXhpc3Rpbmc9YXdhaXQgc2JGZXRjaCgicHJlcGF5bWVudHMiLCJHRVQiLG51bGwsIj9vcmRlcj1wcmVwX2lkLmRlc2MmbGltaXQ9MSIpOwogICAgICBjb25zdCBsYXN0TnVtPWV4aXN0aW5nJiZleGlzdGluZy5sZW5ndGg+MD9wYXJzZUludCgoZXhpc3RpbmdbMF0ucHJlcF9pZHx8IlBSRVAtMDAwMCIpLnJlcGxhY2UoIlBSRVAtIiwiIikpKzE6MTsKICAgICAgY29uc3QgbmV3SWQ9IlBSRVAtIitTdHJpbmcobGFzdE51bSkucGFkU3RhcnQoNCwiMCIpOwogICAgICBjb25zdCBmaWx0ZXJlZEl0ZW1zPXByZXBheUl0ZW1zLmZpbHRlcihpPT5pLm5hbWUpOwogICAgICBjb25zdCB0b3RhbFByaWNlPWZpbHRlcmVkSXRlbXMucmVkdWNlKChzLGkpPT5zK3BhcnNlKGkucHJpY2V8fDApLDApfHxwYXJzZShmLmFtb3VudCk7CiAgICAgIGNvbnN0IHRvdGFsUGFpZD1maWx0ZXJlZEl0ZW1zLnJlZHVjZSgocyxpKT0+cytwYXJzZShpLnBhaWR8fGkucHJpY2V8fDApLDApfHx0b3RhbFByaWNlOwogICAgICBjb25zdCB0b3RhbERlYnQ9TWF0aC5tYXgoMCx0b3RhbFByaWNlLXRvdGFsUGFpZCk7CiAgICAgIGNvbnN0IGl0ZW1zSnNvbj1KU09OLnN0cmluZ2lmeShmaWx0ZXJlZEl0ZW1zKTsKICAgICAgYXdhaXQgc2JGZXRjaCgicHJlcGF5bWVudHMiLCJQT1NUIix7CiAgICAgICAgcHJlcF9pZDpuZXdJZCxwcmVwX2RhdGU6dG9kYXlTdHIoKSxjbGllbnRfbmFtZTpmLmNsaWVudCxwaG9uZTpmLnBob25lLAogICAgICAgIGl0ZW06ZmlsdGVyZWRJdGVtcy5tYXAoaT0+aS5uYW1lKS5qb2luKCIsICIpLAogICAgICAgIGNoYW5uZWw6Zi5jaGFubmVsLGFtb3VudDp0b3RhbFBhaWQsYmFsYW5jZTp0b3RhbERlYnQsCiAgICAgICAgc3RhdHVzOiJcdUQ4M0RcdURGRTEg0J7RgtC60YDRi9GC0LAiLG5vdGVzOihmLm5vdGVzP2Yubm90ZXMrIlxuIjoiIikraXRlbXNKc29uLHNlbGxlcl9uYW1lOnNoaWZ0LnNlbGxlcnx8ItCf0YDQvtC00LDQstC10YYiCiAgICAgIH0pOwogICAgICBhbGVydCgi4pyFINCf0YDQtdC00L7Qv9C70LDRgtCwINGB0L7RhdGA0LDQvdC10L3QsCEgIituZXdJZCk7CiAgICAgIHNldFByZXBheUZvcm0oe2NsaWVudDoiIixwaG9uZToiKzciLGNoYW5uZWw6Ikthc3BpIixhbW91bnQ6IiIsYmFsYW5jZToiIixub3RlczoiIn0pOwogICAgICBzZXRQcmVwYXlJdGVtcyhbe25hbWU6IiIscHJpY2U6IiIscGFpZDoiIixzdGF0dXM6ItC+0LbQuNC00LDQtdGC0YHRjyJ9XSk7CiAgICB9IGNhdGNoKGUpe2FsZXJ0KCLQntGI0LjQsdC60LA6ICIrZS5tZXNzYWdlKTt9CiAgfTsKCiAgY29uc3QgaGFuZGxlU2F2ZU9wZW49YXN5bmMoKT0+ewogICAgaWYoIW9wZW5Gb3JtLnNlbGxlcnx8IW9wZW5Gb3JtLmNhc2hPcGVuKXthbGVydCgi0JfQsNC/0L7Qu9C90Lgg0L/RgNC+0LTQsNCy0YbQsCDQuCDQutCw0YHRgdGDIik7cmV0dXJuO30KICAgIHNldE9wZW5TYXZpbmcodHJ1ZSk7CiAgICB0cnkgewogICAgICAvLyDQodC90LDRh9Cw0LvQsCDRg9C00LDQu9GP0LXQvCDRgdGC0LDRgNGD0Y4g0LfQsNC/0LjRgdGMINGN0YLQvtCz0L4g0L/RgNC+0LTQsNCy0YbQsAogICAgICBhd2FpdCBzYkZldGNoKCJvcGVuX3NoaWZ0cyIsIkRFTEVURSIsbnVsbCxgP3Bob25lPWVxLndlYl8ke2VuY29kZVVSSUNvbXBvbmVudChvcGVuRm9ybS5zZWxsZXIpfWApOwogICAgICAvLyDQodC+0LfQtNCw0ZHQvCDQvdC+0LLRg9GOINGBINCw0LrRgtGD0LDQu9GM0L3QvtC5INC60LDRgdGB0L7QuQogICAgICBhd2FpdCBzYkZldGNoKCJvcGVuX3NoaWZ0cyIsIlBPU1QiLHsKICAgICAgICBwaG9uZToid2ViXyIrb3BlbkZvcm0uc2VsbGVyLHNlbGxlcjpvcGVuRm9ybS5zZWxsZXIsc2hvcDoiTkFORSBQQVJJUyIsCiAgICAgICAgY2FzaF9vcGVuOnBhcnNlKG9wZW5Gb3JtLmNhc2hPcGVuKSxzdGFydF90aW1lOm5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxpc19zZWNvbmQ6ZmFsc2UKICAgICAgfSk7CiAgICAgIHNldE9wZW5TYXZlZCh0cnVlKTsKICAgIH0gY2F0Y2goZSl7YWxlcnQoItCe0YjQuNCx0LrQsDogIitlLm1lc3NhZ2UpO30KICAgIHNldE9wZW5TYXZpbmcoZmFsc2UpOwogIH07CgogIC8vIFVJCiAgY29uc3QgdGFicz1be2lkOiJvcGVuIixsYWJlbDoiXHVEODNEXHVEQ0MyINCe0YLQutGA0YvRgtC40LUifSx7aWQ6ImNsb3NlIixsYWJlbDoiXHVEODNEXHVEQ0NCINCX0LDQutGA0YvRgtC40LUifSx7aWQ6InByZXBheSIsbGFiZWw6Ilx1RDgzRFx1RENCMyDQn9GA0LXQtNC+0L/Qu9Cw0YLRiyJ9XTsKCiAgcmV0dXJuIDxkaXYgc3R5bGU9e3ttYXhXaWR0aDoiNDgwcHgiLG1hcmdpbjoiMCBhdXRvIixwYWRkaW5nOiIwIDAgNjBweCJ9fT4KICAgIHsvKiDQqNCw0L/QutCwICovfQogICAgPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6IiMxYTFhMWEiLHBhZGRpbmc6IjE4cHggMjBweCIscG9zaXRpb246InN0aWNreSIsdG9wOjAsekluZGV4OjEwfX0+CiAgICAgIDxkaXYgc3R5bGU9e3tmb250RmFtaWx5OiInQ29ybW9yYW50IEdhcmFtb25kJyxzZXJpZiIsZm9udFN0eWxlOiJpdGFsaWMiLGZvbnRTaXplOiIyMnB4Iixjb2xvcjoiI0ZGRkZGMCIsbGV0dGVyU3BhY2luZzoiMC4wNGVtIn19Pk5BTsOJIFBBUklTPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTBweCIsY29sb3I6InJnYmEoMjU1LDI1NSwyNTUsMC40KSIsbGV0dGVyU3BhY2luZzoiMC4xNWVtIix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLG1hcmdpblRvcDoiMXB4In19PtCi0L7QvNC4IOKAlCDQn9GA0L7QtNCw0LLQtdGGPC9kaXY+CiAgICA8L2Rpdj4KCiAgICB7Lyog0KLQsNCx0YsgKi99CiAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsYmFja2dyb3VuZDoicmdiYSgwLDAsMCwwLjA2KSIsYm9yZGVyQm90dG9tOiIxcHggc29saWQgcmdiYSgwLDAsMCwwLjEpIn19PgogICAgICB7dGFicy5tYXAodD0+PGJ1dHRvbiBrZXk9e3QuaWR9IG9uQ2xpY2s9eygpPT5zZXRUYWIodC5pZCl9CiAgICAgICAgc3R5bGU9e3tmbGV4OjEscGFkZGluZzoiMTJweCA2cHgiLGJvcmRlcjoibm9uZSIsYmFja2dyb3VuZDoibm9uZSIsYm9yZGVyQm90dG9tOiIycHggc29saWQgIisodGFiPT09dC5pZD8iIzFhMWExYSI6InRyYW5zcGFyZW50IiksCiAgICAgICAgICBmb250U2l6ZToiMTFweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjp0YWI9PT10LmlkPyIjMWExYTFhIjoiIzg4OCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0IixsZXR0ZXJTcGFjaW5nOiIwLjAzZW0ifX0+CiAgICAgICAge3QubGFiZWx9CiAgICAgIDwvYnV0dG9uPil9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IHN0eWxlPXt7cGFkZGluZzoiMjBweCAxNnB4In19PgoKICAgIHsvKiDilIDilIAg0J7QotCa0KDQq9Ci0JjQlSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi99CiAgICB7dGFiPT09Im9wZW4iJiY8ZGl2PgogICAgICA8U2VjVGl0bGUgaWNvbj0iXHVEODNEXHVERkUyIj7QntGC0LrRgNGL0YLQuNC1INGB0LzQtdC90Ys8L1NlY1RpdGxlPgoKICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTRweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7Qn9GA0L7QtNCw0LLQtdGGPC9sYWJlbD4KICAgICAgICA8c2VsZWN0IHN0eWxlPXt7Li4uRlN9fSB2YWx1ZT17b3BlbkZvcm0uc2VsbGVyfSBvbkNoYW5nZT17YXN5bmMgZT0+ewogICAgICAgICAgY29uc3Qgc2VsbGVyPWUudGFyZ2V0LnZhbHVlOwogICAgICAgICAgc2V0T3BlbkZvcm0ocD0+KHsuLi5wLHNlbGxlcn0pKTsKICAgICAgICAgIHNldFByZXZDYXNoRW5kKG51bGwpOwogICAgICAgICAgaWYoIXNlbGxlcikgcmV0dXJuOwogICAgICAgICAgdHJ5IHsKICAgICAgICAgICAgLy8g0JrQsNGB0YHQsCDQvtCx0YnQsNGPIOKAlCDQsdC10YDRkdC8INC/0L7RgdC70LXQtNC90LjQuSDQvtGB0YLQsNGC0L7QuiDQv9C+INCy0YHQtdC80YMg0LzQsNCz0LDQt9C40L3RgwogICAgICAgICAgICBjb25zdCBhbGxTaGlmdHM9YXdhaXQgc2JGZXRjaCgib3Blbl9zaGlmdHMiLCJHRVQiLG51bGwsCiAgICAgICAgICAgICAgYD9zaG9wPWVxLk5BTkUgUEFSSVMmb3JkZXI9c3RhcnRfdGltZS5kZXNjJmxpbWl0PTEwYCk7CiAgICAgICAgICAgIC8vINCY0YnQtdC8INC30LDQv9C40YHRjCDRgSBjYXNoX29wZW4gKNGN0YLQviDQvtGB0YLQsNGC0L7QuiDQv9GA0LXQtNGL0LTRg9GJ0LXQuSDRgdC80LXQvdGLKQogICAgICAgICAgICAvLyDQmNGB0LrQu9GO0YfQsNC10Lwg0LfQsNC/0LjRgdGMINGB0LDQvNC+0LPQviDQv9GA0L7QtNCw0LLRhtCwINC10YHQu9C4INC+0L3QsCDRgtC+0LvRjNC60L4g0YfRgtC+INGB0L7Qt9C00LDQvdCwCiAgICAgICAgICAgIGNvbnN0IGxhc3RTaGlmdD1hbGxTaGlmdHMmJmFsbFNoaWZ0cy5maW5kKHI9PgogICAgICAgICAgICAgIHIuY2FzaF9vcGVuIT1udWxsICYmIHIuY2FzaF9vcGVuPjAKICAgICAgICAgICAgKTsKICAgICAgICAgICAgaWYobGFzdFNoaWZ0KXsKICAgICAgICAgICAgICBzZXRQcmV2Q2FzaEVuZChsYXN0U2hpZnQuY2FzaF9vcGVuKTsKICAgICAgICAgICAgfQogICAgICAgICAgfSBjYXRjaChlKXsgY29uc29sZS53YXJuKGUpOyB9CiAgICAgICAgfX0+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPtCS0YvQsdC10YDQuCDQv9GA0L7QtNCw0LLRhtCwPC9vcHRpb24+CiAgICAgICAgICB7U0VMTEVSUy5tYXAocz0+PG9wdGlvbiBrZXk9e3N9PntzfTwvb3B0aW9uPil9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTRweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QlNCw0YLQsDwvbGFiZWw+CiAgICAgICAgPGlucHV0IHR5cGU9ImRhdGUiIHN0eWxlPXt7Li4uRlN9fSB2YWx1ZT17b3BlbkZvcm0uZGF0ZX0gb25DaGFuZ2U9e2U9PnNldE9wZW5Gb3JtKHA9Pih7Li4ucCxkYXRlOmUudGFyZ2V0LnZhbHVlfSkpfS8+CiAgICAgIDwvZGl2PgoKICAgICAge3ByZXZDYXNoRW5kIT09bnVsbCYmPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6InJnYmEoMjU1LDIwMCwwLDAuMSkiLGJvcmRlcjoiMXB4IHNvbGlkIHJnYmEoMjAwLDE1MCwwLDAuMykiLAogICAgICAgIGJvcmRlclJhZGl1czoiOHB4IixwYWRkaW5nOiIxMHB4IDE0cHgiLG1hcmdpbkJvdHRvbToiMTBweCIsZm9udFNpemU6IjEzcHgifX0+CiAgICAgICAg8J+SsCDQn9C+INC00LDQvdC90YvQvCDRgdC40YHRgtC10LzRiyDQvdCwINC60L7QvdC10YYg0LLRh9C10YDQsNGI0L3QtdC5INGB0LzQtdC90Ysg0LIg0LrQsNGB0YHQtSDQsdGL0LvQvjogPHN0cm9uZz57Zm10KHByZXZDYXNoRW5kKX0g4oK4PC9zdHJvbmc+CiAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4Iixjb2xvcjoiIzg4OCIsbWFyZ2luVG9wOiIycHgifX0+0J/QtdGA0LXRgdGH0LjRgtCw0Lkg0L3QsNC70LjRh9C90YvQtSDQuCDQstCy0LXQtNC4INGE0LDQutGC0LjRh9C10YHQutGD0Y4g0YHRg9C80LzRgzwvZGl2PgogICAgICA8L2Rpdj59CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQndCw0LvQuNGH0L3Ri9C1INCyINC60LDRgdGB0LUg0L/RgNC4INC+0YLQutGA0YvRgtC40LggKNC/0LXRgNC10YHRh9C40YLQsNC5INCy0YDRg9GH0L3Rg9GOKSIKICAgICAgICB2YWx1ZT17b3BlbkZvcm0uY2FzaE9wZW59IG9uQ2hhbmdlPXt2PT5zZXRPcGVuRm9ybShwPT4oey4uLnAsY2FzaE9wZW46dn0pKX0vPgogICAgICB7cHJldkNhc2hFbmQhPT1udWxsJiZwYXJzZShvcGVuRm9ybS5jYXNoT3Blbik+MCYmTWF0aC5hYnMocGFyc2Uob3BlbkZvcm0uY2FzaE9wZW4pLXByZXZDYXNoRW5kKT41MDAmJjxkaXYgc3R5bGU9e3sKICAgICAgICBiYWNrZ3JvdW5kOiJyZ2JhKDI1MSwxMTMsMTEzLDAuMSkiLGJvcmRlcjoiMXB4IHNvbGlkIHJnYmEoMjUxLDExMywxMTMsMC4zKSIsCiAgICAgICAgYm9yZGVyUmFkaXVzOiI4cHgiLHBhZGRpbmc6IjEwcHggMTRweCIsbWFyZ2luQm90dG9tOiI0cHgiLGZvbnRTaXplOiIxM3B4Iixjb2xvcjoiI2M2MjgyOCIsZm9udFdlaWdodDoiNjAwIgogICAgICB9fT4KICAgICAgICDimqDvuI8g0KDQsNGB0YXQvtC20LTQtdC90LjQtSDRgSDQv9GA0L7RiNC70L7QuSDRgdC80LXQvdC+0Lk6IHtwYXJzZShvcGVuRm9ybS5jYXNoT3Blbik+cHJldkNhc2hFbmQ/IisiOiIifXtmbXQocGFyc2Uob3BlbkZvcm0uY2FzaE9wZW4pLXByZXZDYXNoRW5kKX0g4oK4CiAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4Iixmb250V2VpZ2h0OiI0MDAiLG1hcmdpblRvcDoiMnB4Iixjb2xvcjoiIzU1NSJ9fT4KICAgICAgICAgINCe0LbQuNC00LDQu9C+0YHRjCB7Zm10KHByZXZDYXNoRW5kKX0g4oK4IMK3INCk0LDQutGCIHtmbXQocGFyc2Uob3BlbkZvcm0uY2FzaE9wZW4pKX0g4oK4CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2Pn0KCiAgICAgIHtvcGVuU2F2ZWQ/CiAgICAgICAgPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6InJnYmEoNzQsMjIyLDEyOCwwLjEpIixib3JkZXI6IjFweCBzb2xpZCByZ2JhKDc0LDIyMiwxMjgsMC4zKSIsYm9yZGVyUmFkaXVzOiIxMHB4IixwYWRkaW5nOiIxNnB4Iix0ZXh0QWxpZ246ImNlbnRlciJ9fT4KICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMjBweCIsbWFyZ2luQm90dG9tOiI2cHgifX0+4pyFPC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFdlaWdodDoiNzAwIixtYXJnaW5Cb3R0b206IjRweCJ9fT7QodC80LXQvdCwINC+0YLQutGA0YvRgtCwITwvZGl2PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiIzU1NSJ9fT57b3BlbkZvcm0uc2VsbGVyfSDCtyB7Zm10RGF0ZShvcGVuRm9ybS5kYXRlKX0gwrcge2ZtdChwYXJzZShvcGVuRm9ybS5jYXNoT3BlbikpfSDigrg8L2Rpdj4KICAgICAgICAgIDxidXR0b24gb25DbGljaz17KCk9PntzZXRPcGVuU2F2ZWQoZmFsc2UpO3NldE9wZW5Gb3JtKHtzZWxsZXI6IiIsY2FzaE9wZW46IiIsZGF0ZTp0b2RheVN0cigpfSk7fX0KICAgICAgICAgICAgc3R5bGU9e3suLi5CVE4sbWFyZ2luVG9wOiIxNHB4IixiYWNrZ3JvdW5kOiJ0cmFuc3BhcmVudCIsY29sb3I6IiMxYTFhMWEiLGJvcmRlcjoiMXB4IHNvbGlkICMxYTFhMWEifX0+CiAgICAgICAgICAgINCd0L7QstC+0LUg0L7RgtC60YDRi9GC0LjQtQogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+OgogICAgICAgIDxidXR0b24gb25DbGljaz17aGFuZGxlU2F2ZU9wZW59IGRpc2FibGVkPXtvcGVuU2F2aW5nfQogICAgICAgICAgc3R5bGU9e3suLi5CVE4sb3BhY2l0eTpvcGVuU2F2aW5nPzAuNjoxfX0+CiAgICAgICAgICB7b3BlblNhdmluZz8i0KHQvtGF0YDQsNC90LXQvdC40LUuLi4iOiJcdUQ4M0RcdURGRTIg0J7RgtC60YDRi9GC0Ywg0YHQvNC10L3RgyJ9CiAgICAgICAgPC9idXR0b24+CiAgICAgIH0KICAgIDwvZGl2Pn0KCiAgICB7Lyog4pSA4pSAINCX0JDQmtCg0KvQotCY0JUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovfQogICAge3RhYj09PSJjbG9zZSImJjxkaXY+CiAgICAgIDxTZWNUaXRsZSBpY29uPSJcdUQ4M0RcdURDQ0IiPtCX0LDQutGA0YvRgtC40LUg0YHQvNC10L3RizwvU2VjVGl0bGU+CgogICAgICA8ZGl2IHN0eWxlPXt7bWFyZ2luQm90dG9tOiIxNHB4In19PgogICAgICAgIDxsYWJlbCBzdHlsZT17TFN9PtCf0YDQvtC00LDQstC10YY8L2xhYmVsPgogICAgICAgIDxzZWxlY3Qgc3R5bGU9e3suLi5GU319IHZhbHVlPXtzaGlmdC5zZWxsZXJ9IG9uQ2hhbmdlPXtlPT57dXBkKCJzZWxsZXIiLGUudGFyZ2V0LnZhbHVlKTt1cGQoImNhc2hPcGVuIiwiIik7bG9hZFNoaWZ0Q2FzaE9wZW4oZS50YXJnZXQudmFsdWUpO319PgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj7QktGL0LHQtdGA0Lgg0L/RgNC+0LTQsNCy0YbQsDwvb3B0aW9uPgogICAgICAgICAge1NFTExFUlMubWFwKHM9PjxvcHRpb24ga2V5PXtzfT57c308L29wdGlvbj4pfQogICAgICAgIDwvc2VsZWN0PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjE4cHgifX0+CiAgICAgICAgPGxhYmVsIHN0eWxlPXtMU30+0JTQsNGC0LAg0YHQvNC10L3RizwvbGFiZWw+CiAgICAgICAgPGlucHV0IHR5cGU9ImRhdGUiIHN0eWxlPXt7Li4uRlN9fSB2YWx1ZT17c2hpZnQuZGF0ZX0gb25DaGFuZ2U9e2U9PnVwZCgiZGF0ZSIsZS50YXJnZXQudmFsdWUpfS8+CiAgICAgIDwvZGl2PgoKICAgICAgey8qINCk0L7RgtC+IFot0L7RgtGH0ZHRgtCwICovfQogICAgICA8U2VjVGl0bGUgaWNvbj0iXHVEODNEXHVEQ0M0Ij5aLdC+0YLRh9GR0YIgUk9TVEE8L1NlY1RpdGxlPgogICAgICA8ZGl2IHN0eWxlPXt7bWFyZ2luQm90dG9tOiIxNHB4In19PgogICAgICAgIDxsYWJlbCBzdHlsZT17ey4uLkxTLG1hcmdpbkJvdHRvbToiOHB4In19PtCk0L7RgtC+IFot0L7RgtGH0ZHRgtCwPC9sYWJlbD4KICAgICAgICA8bGFiZWwgc3R5bGU9e3tkaXNwbGF5OiJibG9jayIsd2lkdGg6IjEwMCUiLHBhZGRpbmc6IjE0cHgiLGJvcmRlclJhZGl1czoiOHB4Iixib3JkZXI6IjEuNXB4IGRhc2hlZCByZ2JhKDAsMCwwLDAuMjUpIiwKICAgICAgICAgIHRleHRBbGlnbjoiY2VudGVyIixjdXJzb3I6InBvaW50ZXIiLGZvbnRTaXplOiIxM3B4Iixjb2xvcjoiIzU1NSIsYmFja2dyb3VuZDoicmdiYSgwLDAsMCwwLjAyKSJ9fT4KICAgICAgICAgIHtvY3JTdGF0ZS56TG9hZGluZz8i4o+zINCg0LDRgdC/0L7Qt9C90LDRji4uLiI6b2NyU3RhdGUuekRvbmU/IuKchSDQoNCw0YHQv9C+0LfQvdCw0L0g4oCUINC/0L7Qu9GPINC30LDQv9C+0LvQvdC10L3RiyI6Ilx1RDgzRFx1RENGNyDQndCw0LbQvNC4INGH0YLQvtCx0Ysg0LfQsNCz0YDRg9C30LjRgtGMINGE0L7RgtC+In0KICAgICAgICAgIDxpbnB1dCB0eXBlPSJmaWxlIiBhY2NlcHQ9ImltYWdlLyoiIGNhcHR1cmU9ImVudmlyb25tZW50IiBzdHlsZT17e2Rpc3BsYXk6Im5vbmUifX0KICAgICAgICAgICAgb25DaGFuZ2U9e2U9PmhhbmRsZVBob3RvT0NSKCJ6IixlLnRhcmdldC5maWxlc1swXSl9Lz4KICAgICAgICA8L2xhYmVsPgogICAgICAgIHtvY3JTdGF0ZS56RXJyb3ImJjxkaXYgc3R5bGU9e3tjb2xvcjoiI2ZiNzE3MSIsZm9udFNpemU6IjEycHgiLG1hcmdpblRvcDoiNHB4In19PntvY3JTdGF0ZS56RXJyb3J9PC9kaXY+fQogICAgICA8L2Rpdj4KCiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSJLYXNwaSBRUiIgdmFsdWU9e3NoaWZ0LnJLYXNwaX0gb25DaGFuZ2U9e3Y9PnVwZCgickthc3BpIix2KX0gbG9ja2VkPXtvY3JMb2NrZWR9IG9uVW5sb2NrPXsoKT0+c2V0T2NyTG9ja2VkKGZhbHNlKX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0i0J7QvdC70LDQudC9IEthc3BpIiB2YWx1ZT17c2hpZnQuck9ubGluZX0gb25DaGFuZ2U9e3Y9PnVwZCgick9ubGluZSIsdil9IGxvY2tlZD17b2NyTG9ja2VkfSBvblVubG9jaz17KCk9PnNldE9jckxvY2tlZChmYWxzZSl9Lz4KICAgICAgPE1vbmV5RmllbGQgbGFiZWw9IkhhbHlrIFFSIiB2YWx1ZT17c2hpZnQuckhhbHlrfSBvbkNoYW5nZT17dj0+dXBkKCJySGFseWsiLHYpfSBsb2NrZWQ9e29jckxvY2tlZH0gb25VbmxvY2s9eygpPT5zZXRPY3JMb2NrZWQoZmFsc2UpfS8+CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQntC90LvQsNC50L0gSGFseWsiIHZhbHVlPXtzaGlmdC5ySGFseWtPbmxpbmV9IG9uQ2hhbmdlPXt2PT51cGQoInJIYWx5a09ubGluZSIsdil9IGxvY2tlZD17b2NyTG9ja2VkfSBvblVubG9jaz17KCk9PnNldE9jckxvY2tlZChmYWxzZSl9Lz4KICAgICAgPE1vbmV5RmllbGQgbGFiZWw9ItCd0LDQu9C40YfQvdGL0LUiIHZhbHVlPXtzaGlmdC5yQ2FzaH0gb25DaGFuZ2U9e3Y9PnVwZCgickNhc2giLHYpfSBsb2NrZWQ9e29jckxvY2tlZH0gb25VbmxvY2s9eygpPT5zZXRPY3JMb2NrZWQoZmFsc2UpfS8+CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsCIgdmFsdWU9e3NoaWZ0LnJQZXJzb25hbH0gb25DaGFuZ2U9e3Y9PnVwZCgiclBlcnNvbmFsIix2KX0gbG9ja2VkPXtvY3JMb2NrZWR9IG9uVW5sb2NrPXsoKT0+c2V0T2NyTG9ja2VkKGZhbHNlKX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0i0JHQvtC90YPRgdGLIiB2YWx1ZT17c2hpZnQuckJvbnVzfSBvbkNoYW5nZT17dj0+dXBkKCJyQm9udXMiLHYpfSBsb2NrZWQ9e29jckxvY2tlZH0gb25VbmxvY2s9eygpPT5zZXRPY3JMb2NrZWQoZmFsc2UpfS8+CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQktC+0LfQstGA0LDRgiBLYXNwaSIgdmFsdWU9e3NoaWZ0LnJSZXRLYXNwaX0gb25DaGFuZ2U9e3Y9PnVwZCgiclJldEthc3BpIix2KX0gbG9ja2VkPXtvY3JMb2NrZWR9IG9uVW5sb2NrPXsoKT0+c2V0T2NyTG9ja2VkKGZhbHNlKX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0i0JLQvtC30LLRgNCw0YIgSGFseWsiIHZhbHVlPXtzaGlmdC5yUmV0SGFseWt9IG9uQ2hhbmdlPXt2PT51cGQoInJSZXRIYWx5ayIsdil9IGxvY2tlZD17b2NyTG9ja2VkfSBvblVubG9jaz17KCk9PnNldE9jckxvY2tlZChmYWxzZSl9Lz4KICAgICAgPE1vbmV5RmllbGQgbGFiZWw9ItCS0L7Qt9Cy0YDQsNGCINC90LDQu9C40YfQvdGL0LzQuCIgdmFsdWU9e3NoaWZ0LnJSZXRDYXNofSBvbkNoYW5nZT17dj0+dXBkKCJyUmV0Q2FzaCIsdil9IGxvY2tlZD17b2NyTG9ja2VkfSBvblVubG9jaz17KCk9PnNldE9jckxvY2tlZChmYWxzZSl9Lz4KCiAgICAgIHsvKiDQotC10YDQvNC40L3QsNC70YsgKi99CiAgICAgIDxTZWNUaXRsZSBpY29uPSJcdUQ4M0RcdURDQjMiPtCi0LXRgNC80LjQvdCw0LvRiyAo0YTQsNC60YIpPC9TZWNUaXRsZT4KICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTRweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e3suLi5MUyxtYXJnaW5Cb3R0b206IjhweCJ9fT7QpNC+0YLQviBLYXNwaSDRgtC10YDQvNC40L3QsNC70LA8L2xhYmVsPgogICAgICAgIDxsYWJlbCBzdHlsZT17e2Rpc3BsYXk6ImJsb2NrIix3aWR0aDoiMTAwJSIscGFkZGluZzoiMTJweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJvcmRlcjoiMS41cHggZGFzaGVkIHJnYmEoMCwwLDAsMC4yKSIsCiAgICAgICAgICB0ZXh0QWxpZ246ImNlbnRlciIsY3Vyc29yOiJwb2ludGVyIixmb250U2l6ZToiMTJweCIsY29sb3I6IiM1NTUifX0+CiAgICAgICAgICB7b2NyU3RhdGUua2FzcGlMb2FkaW5nPyLij7Mg0KDQsNGB0L/QvtC30L3QsNGOLi4uIjpvY3JTdGF0ZS5rYXNwaURvbmU/IuKchSBLYXNwaSDQs9C+0YLQvtCyIjoiXHVEODNEXHVEQ0Y3INCk0L7RgtC+IEthc3BpINGC0LXRgNC80LjQvdCw0LvQsCJ9CiAgICAgICAgICA8aW5wdXQgdHlwZT0iZmlsZSIgYWNjZXB0PSJpbWFnZS8qIiBjYXB0dXJlPSJlbnZpcm9ubWVudCIgc3R5bGU9e3tkaXNwbGF5OiJub25lIn19CiAgICAgICAgICAgIG9uQ2hhbmdlPXtlPT5oYW5kbGVQaG90b09DUigia2FzcGkiLGUudGFyZ2V0LmZpbGVzWzBdKX0vPgogICAgICAgIDwvbGFiZWw+CiAgICAgIDwvZGl2PgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0iS2FzcGkg4oCUINC/0YDQvtC00LDQttC4ICjRgtC10YDQvNC40L3QsNC7KSIgdmFsdWU9e3NoaWZ0LnRLYXNwaX0gb25DaGFuZ2U9e3Y9PnVwZCgidEthc3BpIix2KX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0iS2FzcGkg4oCUINCy0L7Qt9Cy0YDQsNGCICjRgtC10YDQvNC40L3QsNC7KSIgdmFsdWU9e3NoaWZ0LnRLYXNwaVJldH0gb25DaGFuZ2U9e3Y9PnVwZCgidEthc3BpUmV0Iix2KX0vPgoKICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTRweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e3suLi5MUyxtYXJnaW5Cb3R0b206IjhweCJ9fT7QpNC+0YLQviBIYWx5ayDRgtC10YDQvNC40L3QsNC70LA8L2xhYmVsPgogICAgICAgIDxsYWJlbCBzdHlsZT17e2Rpc3BsYXk6ImJsb2NrIix3aWR0aDoiMTAwJSIscGFkZGluZzoiMTJweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJvcmRlcjoiMS41cHggZGFzaGVkIHJnYmEoMCwwLDAsMC4yKSIsCiAgICAgICAgICB0ZXh0QWxpZ246ImNlbnRlciIsY3Vyc29yOiJwb2ludGVyIixmb250U2l6ZToiMTJweCIsY29sb3I6IiM1NTUifX0+CiAgICAgICAgICB7b2NyU3RhdGUuaGFseWtMb2FkaW5nPyLij7Mg0KDQsNGB0L/QvtC30L3QsNGOLi4uIjpvY3JTdGF0ZS5oYWx5a0RvbmU/IuKchSBIYWx5ayDQs9C+0YLQvtCyIjoiXHVEODNEXHVEQ0Y3INCk0L7RgtC+IEhhbHlrINGC0LXRgNC80LjQvdCw0LvQsCJ9CiAgICAgICAgICA8aW5wdXQgdHlwZT0iZmlsZSIgYWNjZXB0PSJpbWFnZS8qIiBjYXB0dXJlPSJlbnZpcm9ubWVudCIgc3R5bGU9e3tkaXNwbGF5OiJub25lIn19CiAgICAgICAgICAgIG9uQ2hhbmdlPXtlPT5oYW5kbGVQaG90b09DUigiaGFseWsiLGUudGFyZ2V0LmZpbGVzWzBdKX0vPgogICAgICAgIDwvbGFiZWw+CiAgICAgIDwvZGl2PgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0iSGFseWsg4oCUINC/0YDQvtC00LDQttC4ICjRgtC10YDQvNC40L3QsNC7KSIgdmFsdWU9e3NoaWZ0LnRIYWx5a30gb25DaGFuZ2U9e3Y9PnVwZCgidEhhbHlrIix2KX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0iSGFseWsg4oCUINCy0L7Qt9Cy0YDQsNGCICjRgtC10YDQvNC40L3QsNC7KSIgdmFsdWU9e3NoaWZ0LnRIYWx5a1JldH0gb25DaGFuZ2U9e3Y9PnVwZCgidEhhbHlrUmV0Iix2KX0vPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0i0JvQuNGH0L3QsNGPINC60LDRgNGC0LAgKNGE0LDQutGCKSIgdmFsdWU9e3NoaWZ0LnRQZXJzb25hbHx8c2hpZnQuclBlcnNvbmFsfSBvbkNoYW5nZT17dj0+dXBkKCJ0UGVyc29uYWwiLHYpfQogICAgICAgIGhpbnQ9eyFzaGlmdC50UGVyc29uYWwmJnNoaWZ0LnJQZXJzb25hbD8i4pyFINCR0LXRgNGR0YLRgdGPINC40LcgUk9TVEE6ICIrZm10KHBhcnNlKHNoaWZ0LnJQZXJzb25hbCkpKyIg4oK4IjoiIn0vPgoKICAgICAgey8qINCa0LDRgdGB0LAgKi99CiAgICAgIDxTZWNUaXRsZSBpY29uPSJcdUQ4M0RcdURDQjUiPtCa0LDRgdGB0LA8L1NlY1RpdGxlPgogICAgICA8TW9uZXlGaWVsZCBsYWJlbD0i0J7RgtC60YDRi9GC0LjQtSAo0L3QsNGH0LDQu9C+INGB0LzQtdC90YspIiB2YWx1ZT17c2hpZnQuY2FzaE9wZW59IG9uQ2hhbmdlPXt2PT51cGQoImNhc2hPcGVuIix2KX0KICAgICAgICBoaW50PXtzaGlmdC5jYXNoT3BlbiYmcGFyc2Uoc2hpZnQuY2FzaE9wZW4pPjA/IuKchSDQl9Cw0LPRgNGD0LbQtdC90L4g0LDQstGC0L7QvNCw0YLQuNGH0LXRgdC60Lgg0LjQtyDQvtGC0LrRgNGL0YLQuNGPINGB0LzQtdC90YsiOiLQl9Cw0LPRgNGD0LbQsNC10YLRgdGPINCw0LLRgtC+0LzQsNGC0LjRh9C10YHQutC4INC/0YDQuCDQstGL0LHQvtGA0LUg0L/RgNC+0LTQsNCy0YbQsCJ9Lz4KICAgICAgPE1vbmV5RmllbGQgbGFiZWw9ItCX0LDQutGA0YvRgtC40LUgKNC60L7QvdC10YYg0YHQvNC10L3RiyDigJQg0L/QtdGA0LXRgdGH0LjRgtCw0LkpIiB2YWx1ZT17c2hpZnQuY2FzaEFjdHVhbH0gb25DaGFuZ2U9e3Y9PnVwZCgiY2FzaEFjdHVhbCIsdil9CiAgICAgICAgaGludD17ItCe0LbQuNC00LDQu9C+0YHRjCDQsiDQutCw0YHRgdC1OiAiK2ZtdChwYXJzZShzaGlmdC5jYXNoT3BlbikrTWF0aC5tYXgoMCxwYXJzZShzaGlmdC5yQ2FzaCkpLXBhcnNlKHNoaWZ0Lmlua2Fzc28pKSsiIOKCuCJ9Lz4KICAgICAge2Nhc2hBY3R1YWxGaWxsZWQmJk1hdGguYWJzKGNhc2hCb3hEaWZmKT41MDAmJjxkaXYgc3R5bGU9e3sKICAgICAgICBiYWNrZ3JvdW5kOmNhc2hCb3hEaWZmPjA/InJnYmEoNzQsMjIyLDEyOCwwLjA4KSI6InJnYmEoMjUxLDExMywxMTMsMC4wOCkiLAogICAgICAgIGJvcmRlcjoiMXB4IHNvbGlkICIrKGNhc2hCb3hEaWZmPjA/InJnYmEoNzQsMjIyLDEyOCwwLjMpIjoicmdiYSgyNTEsMTEzLDExMywwLjMpIiksCiAgICAgICAgYm9yZGVyUmFkaXVzOiI4cHgiLHBhZGRpbmc6IjEwcHggMTJweCIsbWFyZ2luQm90dG9tOiI4cHgiLGZvbnRTaXplOiIxM3B4IiwKICAgICAgICBjb2xvcjpjYXNoQm94RGlmZj4wPyIjMjJjNTVlIjoiI2ZiNzE3MSIsZm9udFdlaWdodDoiNjAwIgogICAgICB9fT4KICAgICAgICB7Y2FzaEJveERpZmY+MD8iXHVEODNEXHVEQzlBINCY0LfQu9C40YjQtdC6INCyINC60LDRgdGB0LUiOiLinYwg0J3QtdC00L7RgdGC0LDRh9CwINCyINC60LDRgdGB0LUifToge2Nhc2hCb3hEaWZmPjA/IisiOiIifXtmbXQoY2FzaEJveERpZmYpfSDigrgKICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGZvbnRXZWlnaHQ6IjQwMCIsbWFyZ2luVG9wOiIycHgiLG9wYWNpdHk6MC44fX0+CiAgICAgICAgICDQntC20LjQtNCw0LvQvtGB0Ywge2ZtdChjYXNoRXhwZWN0ZWQpfSDigrggwrcg0KTQsNC60YIge2ZtdChwYXJzZShzaGlmdC5jYXNoQWN0dWFsKSl9IOKCuAogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj59CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQmNC90LrQsNGB0YHQsNGG0LjRjyIgdmFsdWU9e3NoaWZ0Lmlua2Fzc299IG9uQ2hhbmdlPXt2PT51cGQoImlua2Fzc28iLHYpfS8+CiAgICAgIDxNb25leUZpZWxkIGxhYmVsPSLQktGL0L/Qu9Cw0YLRiyDQuNC3INC60LDRgdGB0YsiIHZhbHVlPXtzaGlmdC5jYXNoUGF5b3V0c30gb25DaGFuZ2U9e3Y9PnVwZCgiY2FzaFBheW91dHMiLHYpfS8+CgogICAgICB7Lyog0KHQstC10YDQutCwICovfQogICAgICB7KHBhcnNlKHNoaWZ0LnJLYXNwaSl8fHBhcnNlKHNoaWZ0LnRLYXNwaSl8fHBhcnNlKHNoaWZ0LnJIYWx5ayl8fHBhcnNlKHNoaWZ0LnJDYXNoKSk+MCYmPD4KICAgICAgICA8U2VjVGl0bGUgaWNvbj0iXHVEODNEXHVERDBEIj7QodCy0LXRgNC60LA8L1NlY1RpdGxlPgogICAgICAgIDxEaWZmUm93IGxhYmVsPSJLYXNwaSIKICAgICAgICAgIHJvc3RhPXtwYXJzZShzaGlmdC5yS2FzcGkpK3BhcnNlKHNoaWZ0LnJPbmxpbmUpLXBhcnNlKHNoaWZ0LnJSZXRLYXNwaSl9CiAgICAgICAgICBmYWN0PXtwYXJzZShzaGlmdC50S2FzcGkpLXBhcnNlKHNoaWZ0LnRLYXNwaVJldCl9CiAgICAgICAgICByZWFzb249e3NoaWZ0LnJlYXNvbkthc3BpfQogICAgICAgICAgb25SZWFzb25DaGFuZ2U9e3Y9PnVwZCgicmVhc29uS2FzcGkiLHYpfQogICAgICAgICAgaW5jb21pbmdQcmVwYXlzPXtvcGVuUHJlcGF5c30KICAgICAgICAgIG9uTG9hZFByZXBheXM9e2xvYWRPcGVuUHJlcGF5c30KICAgICAgICAgIGxvYWRpbmdQcmVwYXlzPXtsb2FkaW5nUHJlcGF5c30KICAgICAgICAgIGF0dGFjaGVkUHJlcGF5cz17YXR0YWNoZWRJbmNvbWluZy5rYXNwaX0KICAgICAgICAgIG9uQXR0YWNoUHJlcGF5PXsocCxyKT0+YXR0YWNoUHJlcGF5KCJrYXNwaSIscCxyKX0KICAgICAgICAvPgogICAgICAgIDxEaWZmUm93IGxhYmVsPSJIYWx5ayIKICAgICAgICAgIHJvc3RhPXtwYXJzZShzaGlmdC5ySGFseWspK3BhcnNlKHNoaWZ0LnJIYWx5a09ubGluZSktcGFyc2Uoc2hpZnQuclJldEhhbHlrKX0KICAgICAgICAgIGZhY3Q9e3BhcnNlKHNoaWZ0LnRIYWx5ayktcGFyc2Uoc2hpZnQudEhhbHlrUmV0KX0KICAgICAgICAgIHJlYXNvbj17c2hpZnQucmVhc29uSGFseWt9CiAgICAgICAgICBvblJlYXNvbkNoYW5nZT17dj0+dXBkKCJyZWFzb25IYWx5ayIsdil9CiAgICAgICAgICBpbmNvbWluZ1ByZXBheXM9e29wZW5QcmVwYXlzfQogICAgICAgICAgb25Mb2FkUHJlcGF5cz17bG9hZE9wZW5QcmVwYXlzfQogICAgICAgICAgbG9hZGluZ1ByZXBheXM9e2xvYWRpbmdQcmVwYXlzfQogICAgICAgICAgYXR0YWNoZWRQcmVwYXlzPXthdHRhY2hlZEluY29taW5nLmhhbHlrfQogICAgICAgICAgb25BdHRhY2hQcmVwYXk9eyhwLHIpPT5hdHRhY2hQcmVwYXkoImhhbHlrIixwLHIpfQogICAgICAgIC8+CiAgICAgICAgPERpZmZSb3cgbGFiZWw9ItCd0LDQu9C40YfQvdGL0LUiCiAgICAgICAgICByb3N0YT17cGFyc2Uoc2hpZnQuckNhc2gpfQogICAgICAgICAgZmFjdD17Y2FzaFNhbGVzRmFjdH0KICAgICAgICAgIHJlYXNvbj17c2hpZnQucmVhc29uQ2FzaH0KICAgICAgICAgIG9uUmVhc29uQ2hhbmdlPXt2PT51cGQoInJlYXNvbkNhc2giLHYpfQogICAgICAgICAgaW5jb21pbmdQcmVwYXlzPXtvcGVuUHJlcGF5c30KICAgICAgICAgIG9uTG9hZFByZXBheXM9e2xvYWRPcGVuUHJlcGF5c30KICAgICAgICAgIGxvYWRpbmdQcmVwYXlzPXtsb2FkaW5nUHJlcGF5c30KICAgICAgICAgIGF0dGFjaGVkUHJlcGF5cz17YXR0YWNoZWRJbmNvbWluZy5jYXNofQogICAgICAgICAgb25BdHRhY2hQcmVwYXk9eyhwLHIpPT5hdHRhY2hQcmVwYXkoImNhc2giLHAscil9CiAgICAgICAgLz4KCiAgICAgICAgey8qINCY0YLQvtCzINGB0LLQtdGA0LrQuCDigJQg0YPRh9C40YLRi9Cy0LDQtdC8INCy0YHQtSDQv9GA0LjQutGA0LXQv9C70ZHQvdC90YvQtSDQv9GA0LXQtNC+0L/Qu9Cw0YLRiyAqL30KICAgICAgICB7KCgpPT57CiAgICAgICAgICBjb25zdCB0b3RhbFByZXBheUFkaj1PYmplY3QudmFsdWVzKGF0dGFjaGVkSW5jb21pbmcpLnJlZHVjZSgocyxsaXN0KT0+cytsaXN0LnJlZHVjZSgoc3MscCk9PnNzK3BhcnNlKHAuYW1vdW50KSwwKSwwKTsKICAgICAgICAgIGNvbnN0IGFkakRpZmY9dG90YWxEaWZmPDA/dG90YWxEaWZmK3RvdGFsUHJlcGF5QWRqOnRvdGFsRGlmZi10b3RhbFByZXBheUFkajsKICAgICAgICAgIGNvbnN0IGFkak9rPU1hdGguYWJzKGFkakRpZmYpPDUwMDsKICAgICAgICAgIGNvbnN0IHByZXBheUV4cGxhaW5lZD10b3RhbFByZXBheUFkaj4wJiZhZGpPayYmIWlzT2s7CiAgICAgICAgICByZXR1cm4gPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6YWRqT2s/InJnYmEoNzQsMjIyLDEyOCwwLjEpIjoicmdiYSgyNTEsMTEzLDExMywwLjA4KSIsCiAgICAgICAgICAgIGJvcmRlcjoiMXB4IHNvbGlkICIrKGFkak9rPyJyZ2JhKDc0LDIyMiwxMjgsMC4zKSI6InJnYmEoMjUxLDExMywxMTMsMC4zKSIpLAogICAgICAgICAgICBib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHgiLG1hcmdpbkJvdHRvbToiMTZweCIsdGV4dEFsaWduOiJjZW50ZXIifX0+CiAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTJweCIsY29sb3I6IiM1NTUiLG1hcmdpbkJvdHRvbToiNHB4In19PlJPU1RBOiB7Zm10KHJvc3RhVG90YWwpfSDigrggwrcg0KTQkNCa0KI6IHtmbXQoZmFjdFRvdGFsKX0g4oK4PC9kaXY+CiAgICAgICAgICAgIHt0b3RhbFByZXBheUFkaj4wJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjMkU2QjVFIixtYXJnaW5Cb3R0b206IjRweCJ9fT7Qn9GA0LXQtNC+0L/Qu9Cw0YLQsDogK3tmbXQodG90YWxQcmVwYXlBZGopfSDigrg8L2Rpdj59CiAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMjJweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjphZGpPaz8iIzIyYzU1ZSI6IiNmYjcxNzEifX0+CiAgICAgICAgICAgICAge2Fkak9rPyLinIUg0JLRgdGRINGB0YXQvtC00LjRgtGB0Y8iOmAke2FkakRpZmY+MD8iKyI6IiJ9JHtmbXQoYWRqRGlmZil9IOKCuGB9CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICB7cHJlcGF5RXhwbGFpbmVkJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjMkU2QjVFIixtYXJnaW5Ub3A6IjRweCIsZm9udFdlaWdodDoiNjAwIn19PvCfkqEg0KDQsNGB0YXQvtC20LTQtdC90LjQtSDQvtCx0YrRj9GB0L3QtdC90L4g0L/RgNC10LTQvtC/0LvQsNGC0L7QuTwvZGl2Pn0KICAgICAgICAgICAgeyFhZGpPayYmPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiI2ZiNzE3MSIsbWFyZ2luVG9wOiI0cHgifX0+0J7QsdGK0Y/RgdC90Lgg0YDQsNGB0YXQvtC20LTQtdC90LjQtSDQstGL0YjQtTwvZGl2Pn0KICAgICAgICAgIDwvZGl2PjsKICAgICAgICB9KSgpfQogICAgICA8Lz59CgogICAgICB7Lyog0J/RgNC40LzQtdGH0LDQvdC40Y8gKi99CiAgICAgIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjE2cHgifX0+CiAgICAgICAgPGxhYmVsIHN0eWxlPXtMU30+0J/RgNC40LzQtdGH0LDQvdC40Y88L2xhYmVsPgogICAgICAgIDx0ZXh0YXJlYSBzdHlsZT17ey4uLkZTLG1pbkhlaWdodDoiNjBweCIscmVzaXplOiJ2ZXJ0aWNhbCJ9fSBwbGFjZWhvbGRlcj0i0J7RgdC+0LHRi9C1INGB0L7QsdGL0YLQuNGPINGB0LzQtdC90YsuLi4iCiAgICAgICAgICB2YWx1ZT17c2hpZnQubm90ZXN9IG9uQ2hhbmdlPXtlPT51cGQoIm5vdGVzIixlLnRhcmdldC52YWx1ZSl9Lz4KICAgICAgPC9kaXY+CgogICAgICB7Lyog0JrQvdC+0L/QutC4ICovfQogICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoiMWZyIDFmciIsZ2FwOiIxMHB4IixtYXJnaW5Cb3R0b206IjEycHgifX0+CiAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKT0+e3NldFNob3dSZXN1bHQodHJ1ZSk7fX0gZGlzYWJsZWQ9eyFzaGlmdC5zZWxsZXJ9CiAgICAgICAgICBzdHlsZT17ey4uLkJUTixiYWNrZ3JvdW5kOiJ0cmFuc3BhcmVudCIsYm9yZGVyOiIxcHggc29saWQgIzFhMWExYSIsY29sb3I6IiMxYTFhMWEiLG9wYWNpdHk6c2hpZnQuc2VsbGVyPzE6MC40fX0+CiAgICAgICAgICDwn5OLINCe0YLRh9GR0YIKICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9e2hhbmRsZVNhdmVTaGlmdH0gZGlzYWJsZWQ9e3NhdmluZ30KICAgICAgICAgIHN0eWxlPXt7Li4uQlROLG9wYWNpdHk6c2F2aW5nPzAuNToxfX0+CiAgICAgICAgICB7c2F2aW5nPyLQodC+0YXRgNCw0L3QtdC90LjQtS4uLiI6c2F2ZWQ/IuKchSDQodC+0YXRgNCw0L3QtdC90L4iOiJcdUQ4M0RcdURDQkUg0KHQvtGF0YDQsNC90LjRgtGMIn0KICAgICAgICA8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj59CgogICAgey8qIOKUgOKUgCDQn9Cg0JXQlNCe0J/Qm9CQ0KLQqyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi99CiAgICB7dGFiPT09InByZXBheSImJjxkaXY+CiAgICAgIDxTZWNUaXRsZSBpY29uPSJcdUQ4M0RcdURDQjMiPtCd0L7QstCw0Y8g0L/RgNC10LTQvtC/0LvQsNGC0LA8L1NlY1RpdGxlPgoKICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTNweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QmNC80Y8g0LrQu9C40LXQvdGC0LA8L2xhYmVsPgogICAgICAgIDxpbnB1dCBzdHlsZT17ey4uLkZTfX0gdmFsdWU9e3ByZXBheUZvcm0uY2xpZW50fSBvbkNoYW5nZT17ZT0+c2V0UHJlcGF5Rm9ybShwPT4oey4uLnAsY2xpZW50OmUudGFyZ2V0LnZhbHVlfSkpfSBwbGFjZWhvbGRlcj0i0JjQvNGPINC4INGE0LDQvNC40LvQuNGPIi8+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPXt7bWFyZ2luQm90dG9tOiIxM3B4In19PgogICAgICAgIDxsYWJlbCBzdHlsZT17TFN9PtCi0LXQu9C10YTQvtC9PC9sYWJlbD4KICAgICAgICA8aW5wdXQgc3R5bGU9e3suLi5GU319IHZhbHVlPXtwcmVwYXlGb3JtLnBob25lfSBvbkNoYW5nZT17ZT0+c2V0UHJlcGF5Rm9ybShwPT4oey4uLnAscGhvbmU6ZS50YXJnZXQudmFsdWV9KSl9IHBsYWNlaG9sZGVyPSIrNyIvPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTNweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QmtCw0L3QsNC7PC9sYWJlbD4KICAgICAgICA8c2VsZWN0IHN0eWxlPXt7Li4uRlN9fSB2YWx1ZT17cHJlcGF5Rm9ybS5jaGFubmVsfSBvbkNoYW5nZT17ZT0+c2V0UHJlcGF5Rm9ybShwPT4oey4uLnAsY2hhbm5lbDplLnRhcmdldC52YWx1ZX0pKX0+CiAgICAgICAgICB7WyJLYXNwaSIsItCe0L3Qu9Cw0LnQvSBLYXNwaSIsIkhhbHlrIiwi0J7QvdC70LDQudC9IEhhbHlrIiwi0J3QsNC70LjRh9C90YvQtSIsItCb0LjRh9C90LDRjyDQutCw0YDRgtCwIl0ubWFwKGM9PjxvcHRpb24ga2V5PXtjfT57Y308L29wdGlvbj4pfQogICAgICAgIDwvc2VsZWN0PgogICAgICA8L2Rpdj4KICAgICAgey8qINCh0L/QuNGB0L7QuiDRgtC+0LLQsNGA0L7QsiAqL30KICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTRweCJ9fT4KICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciIsbWFyZ2luQm90dG9tOiI4cHgifX0+CiAgICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QotC+0LLQsNGA0Ys8L2xhYmVsPgogICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKT0+c2V0UHJlcGF5SXRlbXMocD0+Wy4uLnAse25hbWU6IiIscHJpY2U6IiIsc3RhdHVzOiLQvtC20LjQtNCw0LXRgtGB0Y8ifV0pfQogICAgICAgICAgICBzdHlsZT17e3BhZGRpbmc6IjRweCAxMHB4Iixib3JkZXJSYWRpdXM6IjZweCIsYm9yZGVyOiIxcHggc29saWQgIzFhMWExYSIsYmFja2dyb3VuZDoidHJhbnNwYXJlbnQiLAogICAgICAgICAgICAgIGZvbnRTaXplOiIxMXB4Iixmb250V2VpZ2h0OiI3MDAiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCJ9fT4KICAgICAgICAgICAgKyDQlNC+0LHQsNCy0LjRgtGMCiAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICB7cHJlcGF5SXRlbXMubWFwKChpdGVtLGlkeCk9PjxkaXYga2V5PXtpZHh9IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoiMWZyIGF1dG8gYXV0byIsZ2FwOiI2cHgiLG1hcmdpbkJvdHRvbToiNnB4IixhbGlnbkl0ZW1zOiJjZW50ZXIifX0+CiAgICAgICAgICA8aW5wdXQgc3R5bGU9e3suLi5GUyxwYWRkaW5nOiI4cHggMTBweCIsZm9udFNpemU6IjEzcHgifX0KICAgICAgICAgICAgcGxhY2Vob2xkZXI9e2DQotC+0LLQsNGAICR7aWR4KzF9YH0KICAgICAgICAgICAgdmFsdWU9e2l0ZW0ubmFtZX0KICAgICAgICAgICAgb25DaGFuZ2U9e2U9PnNldFByZXBheUl0ZW1zKHA9PnAubWFwKCh4LGkpPT5pPT09aWR4P3suLi54LG5hbWU6ZS50YXJnZXQudmFsdWV9OngpKX0vPgogICAgICAgICAgPGlucHV0IHN0eWxlPXt7Li4uRlMscGFkZGluZzoiOHB4IDEwcHgiLGZvbnRTaXplOiIxM3B4Iix3aWR0aDoiOTBweCIsdGV4dEFsaWduOiJyaWdodCJ9fQogICAgICAgICAgICBwbGFjZWhvbGRlcj0i0KbQtdC90LAg4oK4IiBpbnB1dE1vZGU9Im51bWVyaWMiCiAgICAgICAgICAgIHZhbHVlPXtpdGVtLnByaWNlfQogICAgICAgICAgICBvbkNoYW5nZT17ZT0+c2V0UHJlcGF5SXRlbXMocD0+cC5tYXAoKHgsaSk9Pmk9PT1pZHg/ey4uLngscHJpY2U6ZS50YXJnZXQudmFsdWUucmVwbGFjZSgvW14wLTldL2csIiIpfTp4KSl9Lz4KICAgICAgICAgIDxpbnB1dCBzdHlsZT17ey4uLkZTLHBhZGRpbmc6IjhweCAxMHB4Iixmb250U2l6ZToiMTNweCIsd2lkdGg6IjkwcHgiLHRleHRBbGlnbjoicmlnaHQifX0KICAgICAgICAgICAgcGxhY2Vob2xkZXI9ItCe0L/Qu9Cw0YfQtdC90L4g4oK4IiBpbnB1dE1vZGU9Im51bWVyaWMiCiAgICAgICAgICAgIHZhbHVlPXtpdGVtLnBhaWR9CiAgICAgICAgICAgIG9uQ2hhbmdlPXtlPT5zZXRQcmVwYXlJdGVtcyhwPT5wLm1hcCgoeCxpKT0+aT09PWlkeD97Li4ueCxwYWlkOmUudGFyZ2V0LnZhbHVlLnJlcGxhY2UoL1teMC05XS9nLCIiKX06eCkpfS8+CiAgICAgICAgICB7cHJlcGF5SXRlbXMubGVuZ3RoPjEmJjxidXR0b24gb25DbGljaz17KCk9PnNldFByZXBheUl0ZW1zKHA9PnAuZmlsdGVyKChfLGkpPT5pIT09aWR4KSl9CiAgICAgICAgICAgIHN0eWxlPXt7cGFkZGluZzoiOHB4Iixib3JkZXJSYWRpdXM6IjZweCIsYm9yZGVyOiJub25lIixiYWNrZ3JvdW5kOiJyZ2JhKDIyMCw1MCw1MCwwLjA4KSIsY29sb3I6IiNjNjI4MjgiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCIsZm9udFNpemU6IjEzcHgifX0+CiAgICAgICAgICAgIOKclQogICAgICAgICAgPC9idXR0b24+fQogICAgICAgIDwvZGl2Pil9CiAgICAgICAgeygoKT0+ewogICAgICAgICAgY29uc3QgdG90YWxQcmljZT1wcmVwYXlJdGVtcy5yZWR1Y2UoKHMsaSk9PnMrcGFyc2UoaS5wcmljZXx8MCksMCk7CiAgICAgICAgICBjb25zdCB0b3RhbFBhaWQ9cHJlcGF5SXRlbXMucmVkdWNlKChzLGkpPT5zK3BhcnNlKGkucGFpZHx8aS5wcmljZXx8MCksMCk7CiAgICAgICAgICBjb25zdCB0b3RhbERlYnQ9cHJlcGF5SXRlbXMucmVkdWNlKChzLGkpPT5zK01hdGgubWF4KDAscGFyc2UoaS5wcmljZXx8MCktcGFyc2UoaS5wYWlkfHxpLnByaWNlfHwwKSksMCk7CiAgICAgICAgICByZXR1cm4gPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGp1c3RpZnlDb250ZW50OiJzcGFjZS1iZXR3ZWVuIixtYXJnaW5Ub3A6IjZweCIsZm9udFNpemU6IjEycHgifX0+CiAgICAgICAgICAgIDxzcGFuIHN0eWxlPXt7Y29sb3I6IiMyRTZCNUUiLGZvbnRXZWlnaHQ6IjYwMCJ9fT7QmNGC0L7Qs9C+OiB7dG90YWxQcmljZS50b0xvY2FsZVN0cmluZygicnUtUlUiKX0g4oK4PC9zcGFuPgogICAgICAgICAgICB7dG90YWxEZWJ0PjAmJjxzcGFuIHN0eWxlPXt7Y29sb3I6IiNjNjI4MjgiLGZvbnRXZWlnaHQ6IjYwMCJ9fT7QlNC+0LvQszoge3RvdGFsRGVidC50b0xvY2FsZVN0cmluZygicnUtUlUiKX0g4oK4PC9zcGFuPn0KICAgICAgICAgIDwvZGl2PjsKICAgICAgICB9KSgpfQogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT17e21hcmdpbkJvdHRvbToiMTNweCJ9fT4KICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7Qn9GA0LjQvNC10YfQsNC90LjQtTwvbGFiZWw+CiAgICAgICAgPGlucHV0IHN0eWxlPXt7Li4uRlN9fSB2YWx1ZT17cHJlcGF5Rm9ybS5ub3Rlc30gb25DaGFuZ2U9e2U9PnNldFByZXBheUZvcm0ocD0+KHsuLi5wLG5vdGVzOmUudGFyZ2V0LnZhbHVlfSkpfSBwbGFjZWhvbGRlcj0iIi8+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIG9uQ2xpY2s9e2hhbmRsZVNhdmVQcmVwYXl9IHN0eWxlPXtCVE59PvCfkrMg0KHQvtGF0YDQsNC90LjRgtGMINC/0YDQtdC00L7Qv9C70LDRgtGDPC9idXR0b24+CgogICAgICB7Lyog0KHQv9C40YHQvtC6INC/0YDQtdC00L7Qv9C70LDRgiAqL30KICAgICAgPFNlY1RpdGxlIGljb249Ilx1RDgzRFx1RENDQiI+0J/RgNC10LTQvtC/0LvQsNGC0Ys8L1NlY1RpdGxlPgogICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsZ2FwOiI4cHgiLG1hcmdpbkJvdHRvbToiMTJweCJ9fT4KICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpPT57c2V0UHJlcGF5TGlzdFRhYigib3BlbiIpO2xvYWRPcGVuUHJlcGF5cygib3BlbiIpO319IHN0eWxlPXt7ZmxleDoxLHBhZGRpbmc6IjhweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJvcmRlcjoiMS41cHggc29saWQgIzFhMWExYSIsYmFja2dyb3VuZDpwcmVwYXlMaXN0VGFiPT09Im9wZW4iPyIjMWExYTFhIjoidHJhbnNwYXJlbnQiLGNvbG9yOnByZXBheUxpc3RUYWI9PT0ib3BlbiI/IiNGRkZGRjAiOiIjMWExYTFhIixmb250U2l6ZToiMTJweCIsZm9udFdlaWdodDoiNzAwIixjdXJzb3I6InBvaW50ZXIiLGZvbnRGYW1pbHk6ImluaGVyaXQifX0+8J+foSDQntGC0LrRgNGL0YLRi9C1PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKT0+e3NldFByZXBheUxpc3RUYWIoImNsb3NlZCIpO2xvYWRPcGVuUHJlcGF5cygiY2xvc2VkIik7fX0gc3R5bGU9e3tmbGV4OjEscGFkZGluZzoiOHB4Iixib3JkZXJSYWRpdXM6IjhweCIsYm9yZGVyOiIxLjVweCBzb2xpZCAjMWExYTFhIixiYWNrZ3JvdW5kOnByZXBheUxpc3RUYWI9PT0iY2xvc2VkIj8iIzFhMWExYSI6InRyYW5zcGFyZW50Iixjb2xvcjpwcmVwYXlMaXN0VGFiPT09ImNsb3NlZCI/IiNGRkZGRjAiOiIjMWExYTFhIixmb250U2l6ZToiMTJweCIsZm9udFdlaWdodDoiNzAwIixjdXJzb3I6InBvaW50ZXIiLGZvbnRGYW1pbHk6ImluaGVyaXQifX0+8J+foiDQktGL0LTQsNC90L3Ri9C1PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpPT5sb2FkT3BlblByZXBheXMocHJlcGF5TGlzdFRhYil9IGRpc2FibGVkPXtsb2FkaW5nUHJlcGF5c30KICAgICAgICBzdHlsZT17ey4uLkJUTixiYWNrZ3JvdW5kOiJ0cmFuc3BhcmVudCIsYm9yZGVyOiIxcHggc29saWQgIzFhMWExYSIsY29sb3I6IiMxYTFhMWEiLG1hcmdpbkJvdHRvbToiMTRweCIsb3BhY2l0eTpsb2FkaW5nUHJlcGF5cz8wLjU6MX19PgogICAgICAgIHtsb2FkaW5nUHJlcGF5cz8i4o+zINCX0LDQs9GA0YPQt9C60LAuLi4iOiJcdUQ4M0RcdUREMDQg0JfQsNCz0YDRg9C30LjRgtGMINGB0L/QuNGB0L7QuiJ9CiAgICAgIDwvYnV0dG9uPgogICAgICB7b3BlblByZXBheXMubWFwKChwLGkpPT57CiAgICAgICAgY29uc3QgaXNDbG9zZWQ9cC5zdGF0dXMmJihwLnN0YXR1cy5pbmNsdWRlcygn0JLRi9C00LDQvScpfHxwLnN0YXR1cy5pbmNsdWRlcygn0JfQsNC60YDRi9GC0LAnKSk7CiAgICAgICAgcmV0dXJuIDxkaXYga2V5PXtpfSBzdHlsZT17e2JvcmRlcjpgMS41cHggc29saWQgJHtpc0Nsb3NlZD8nIzRjYWY1MCc6JyNlNmE4MTcnfWAsYm9yZGVyUmFkaXVzOiI4cHgiLHBhZGRpbmc6IjEycHgiLG1hcmdpbkJvdHRvbToiMTBweCIsYmFja2dyb3VuZDppc0Nsb3NlZD8icmdiYSgyMzIsMjQ1LDIzMywwLjYpIjoicmdiYSgyNTUsMjQ4LDIyMCwwLjYpIn19PgogICAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsbWFyZ2luQm90dG9tOiI2cHgifX0+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7ZmxleDoxfX0+CiAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250V2VpZ2h0OiI3MDAiLGZvbnRTaXplOiIxNHB4In19PntwLmNsaWVudF9uYW1lfTwvZGl2PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiIjNTU1In19PntwLnByZXBfaWR9IMK3IHtwLmNoYW5uZWx9PC9kaXY+CiAgICAgICAgICAgIHtwLnBob25lJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiIjODg4In19PvCfk7Ege3AucGhvbmV9PC9kaXY+fQogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7dGV4dEFsaWduOiJyaWdodCJ9fT4KICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxNnB4Iixmb250V2VpZ2h0OiI3MDAiLGNvbG9yOiIjMkU2QjVFIn19PntmbXQocC5hbW91bnQpfSDigrg8L2Rpdj4KICAgICAgICAgICAge3AuYmFsYW5jZT4wJiYhaXNDbG9zZWQmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTJweCIsY29sb3I6IiNjNjI4MjgiLGZvbnRXZWlnaHQ6IjcwMCJ9fT7QlNC+0LvQszoge2ZtdChwLmJhbGFuY2UpfSDigrg8L2Rpdj59CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICB7Lyog0KLQvtCy0LDRgNGLINC40LcgSlNPTiAqL30KICAgICAgICB7KCgpPT57CiAgICAgICAgICBsZXQgaXRlbXM9W107CiAgICAgICAgICB0cnkgewogICAgICAgICAgICBjb25zdCBub3Rlc1N0cj1wLm5vdGVzfHwiIjsKICAgICAgICAgICAgY29uc3QganNvbk1hdGNoPW5vdGVzU3RyLm1hdGNoKC8oXFsuKlxdKS9zKTsKICAgICAgICAgICAgaWYoanNvbk1hdGNoKSBpdGVtcz1KU09OLnBhcnNlKGpzb25NYXRjaFsxXSk7CiAgICAgICAgICB9IGNhdGNoKGUpe30KICAgICAgICAgIGlmKGl0ZW1zLmxlbmd0aD4wKXsKICAgICAgICAgICAgcmV0dXJuIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjhweCJ9fT4KICAgICAgICAgICAgICB7aXRlbXMubWFwKChpdGVtLGlkeCk9PjxkaXYga2V5PXtpZHh9IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLAogICAgICAgICAgICAgICAgYWxpZ25JdGVtczoiY2VudGVyIixwYWRkaW5nOiI2cHggMTBweCIsYm9yZGVyUmFkaXVzOiI2cHgiLG1hcmdpbkJvdHRvbToiNHB4IiwKICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6aXRlbS5zdGF0dXM9PT0i0LLRi9C00LDQvSI/InJnYmEoNzQsMjIyLDEyOCwwLjA4KSI6InJnYmEoMCwwLDAsMC4wMykiLAogICAgICAgICAgICAgICAgYm9yZGVyOiIxcHggc29saWQgIisoaXRlbS5zdGF0dXM9PT0i0LLRi9C00LDQvSI/InJnYmEoNzQsMjIyLDEyOCwwLjIpIjoicmdiYSgwLDAsMCwwLjA4KSIpfX0+CiAgICAgICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRTaXplOiIxM3B4Iixmb250V2VpZ2h0OiI1MDAifX0+e2l0ZW0ubmFtZX08L3NwYW4+CiAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiJ2YXIoLS10ZXh0LXNlY29uZGFyeSkiLG1hcmdpblRvcDoiMXB4In19PgogICAgICAgICAgICAgICAgICB7cGFyc2UoaXRlbS5wcmljZXx8MCk+MCYmYCR7cGFyc2UoaXRlbS5wcmljZXx8MCkudG9Mb2NhbGVTdHJpbmcoInJ1LVJVIil9IOKCuGB9CiAgICAgICAgICAgICAgICAgIHtwYXJzZShpdGVtLnBhaWR8fDApPjAmJnBhcnNlKGl0ZW0ucGFpZHx8MCk8cGFyc2UoaXRlbS5wcmljZXx8MCkmJjxzcGFuIHN0eWxlPXt7Y29sb3I6IiNjNjI4MjgiLG1hcmdpbkxlZnQ6IjZweCJ9fT7QtNC+0LvQsyB7KHBhcnNlKGl0ZW0ucHJpY2V8fDApLXBhcnNlKGl0ZW0ucGFpZHx8MCkpLnRvTG9jYWxlU3RyaW5nKCJydS1SVSIpfSDigrg8L3NwYW4+fQogICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgIHshaXNDbG9zZWQmJjxidXR0b24gb25DbGljaz17YXN5bmMoKT0+ewogICAgICAgICAgICAgICAgICBpZighd2luZG93LmNvbmZpcm0oYNCS0YvQtNCw0YLRjCAiJHtpdGVtLm5hbWV9IiDQutC70LjQtdC90YLRgyAke3AuY2xpZW50X25hbWV9P2ApKSByZXR1cm47CiAgICAgICAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgICAgICAgaXRlbXNbaWR4XS5zdGF0dXM9ItCy0YvQtNCw0L0iOwogICAgICAgICAgICAgICAgICAgIGNvbnN0IGFsbElzc3VlZD1pdGVtcy5ldmVyeShpPT5pLnN0YXR1cz09PSLQstGL0LTQsNC9Iik7CiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nPWl0ZW1zLmZpbHRlcihpPT5pLnN0YXR1cyE9PSLQstGL0LTQsNC9IikucmVkdWNlKChzLGkpPT5zK3BhcnNlKGkucHJpY2V8fDApLDApOwogICAgICAgICAgICAgICAgICAgIGNvbnN0IG5vdGVzQmFzZT0ocC5ub3Rlc3x8IiIpLnJlcGxhY2UoLyhcWy4qXF0pL3MsIiIpLnRyaW0oKTsKICAgICAgICAgICAgICAgICAgICBhd2FpdCBzYkZldGNoKCJwcmVwYXltZW50cyIsIlBBVENIIix7CiAgICAgICAgICAgICAgICAgICAgICBzdGF0dXM6YWxsSXNzdWVkPyJcdUQ4M0RcdURGRTIg0JLRi9C00LDQvSI6Ilx1RDgzRFx1REZFMSDQntGC0LrRgNGL0YLQsCIsCiAgICAgICAgICAgICAgICAgICAgICBiYWxhbmNlOnJlbWFpbmluZywKICAgICAgICAgICAgICAgICAgICAgIG5vdGVzOm5vdGVzQmFzZSsiXG4iK0pTT04uc3RyaW5naWZ5KGl0ZW1zKQogICAgICAgICAgICAgICAgICAgIH0sYD9pZD1lcS4ke3AuaWR9YCk7CiAgICAgICAgICAgICAgICAgICAgbG9hZE9wZW5QcmVwYXlzKHByZXBheUxpc3RUYWIpOwogICAgICAgICAgICAgICAgICB9IGNhdGNoKGUpe2FsZXJ0KCLQntGI0LjQsdC60LA6ICIrZS5tZXNzYWdlKTt9CiAgICAgICAgICAgICAgICB9fSBzdHlsZT17e3BhZGRpbmc6IjRweCAxMHB4Iixib3JkZXJSYWRpdXM6IjZweCIsYm9yZGVyOiJub25lIiwKICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDppdGVtLnN0YXR1cz09PSLQstGL0LTQsNC9Ij8icmdiYSg3NCwyMjIsMTI4LDAuMikiOiIjMkU2QjVFIiwKICAgICAgICAgICAgICAgICAgY29sb3I6aXRlbS5zdGF0dXM9PT0i0LLRi9C00LDQvSI/IiMyMmM1NWUiOiIjZmZmIiwKICAgICAgICAgICAgICAgICAgZm9udFNpemU6IjExcHgiLGZvbnRXZWlnaHQ6IjcwMCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0IiwKICAgICAgICAgICAgICAgICAgcG9pbnRlckV2ZW50czppdGVtLnN0YXR1cz09PSLQstGL0LTQsNC9Ij8ibm9uZSI6ImF1dG8ifX0+CiAgICAgICAgICAgICAgICAgIHtpdGVtLnN0YXR1cz09PSLQstGL0LTQsNC9Ij8i4pyTINCS0YvQtNCw0L0iOiLQktGL0LTQsNGC0YwifQogICAgICAgICAgICAgICAgPC9idXR0b24+fQogICAgICAgICAgICAgIDwvZGl2Pil9CiAgICAgICAgICAgIDwvZGl2PjsKICAgICAgICAgIH0KICAgICAgICAgIHJldHVybiBwLml0ZW0/PGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiIzU1NSIsbWFyZ2luQm90dG9tOiI2cHgifX0+8J+RlyB7cC5pdGVtfTwvZGl2PjpudWxsOwogICAgICAgIH0pKCl9CiAgICAgICAge2lzQ2xvc2VkCiAgICAgICAgICA/PGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4Iixjb2xvcjoiIzRjYWY1MCIsZm9udFdlaWdodDoiNjAwIn19PntwLnN0YXR1c308L2Rpdj4KICAgICAgICAgIDo8YnV0dG9uIG9uQ2xpY2s9e2FzeW5jKCk9PnsKICAgICAgICAgICAgaWYoIXdpbmRvdy5jb25maXJtKGDimqDvuI8g0JLQndCY0JzQkNCd0JjQlSFcblxu0JLRi9C00LDRgtGMINCS0KHQlSDRgtC+0LLQsNGA0Ysg0LrQu9C40LXQvdGC0YMgJHtwLmNsaWVudF9uYW1lfT9cblxu0K3RgtC+INCX0JDQmtCg0J7QldCiINC/0YDQtdC00L7Qv9C70LDRgtGDINC90LDQstGB0LXQs9C00LAuYCkpIHJldHVybjsKICAgICAgICAgICAgdHJ5IHsKICAgICAgICAgICAgICBhd2FpdCBzYkZldGNoKCJwcmVwYXltZW50cyIsIlBBVENIIiwKICAgICAgICAgICAgICAgIHtzdGF0dXM6Ilx1RDgzRFx1REZFMiDQktGL0LTQsNC9IixiYWxhbmNlOjAsbm90ZXM6ItCS0YHQtSDRgtC+0LLQsNGA0Ysg0LLRi9C00LDQvdGLIMK3ICIrdG9kYXlTdHIoKX0sCiAgICAgICAgICAgICAgICBgP2lkPWVxLiR7cC5pZH1gCiAgICAgICAgICAgICAgKTsKICAgICAgICAgICAgICBsb2FkT3BlblByZXBheXMocHJlcGF5TGlzdFRhYik7CiAgICAgICAgICAgIH0gY2F0Y2goZSl7YWxlcnQoItCe0YjQuNCx0LrQsDogIitlLm1lc3NhZ2UpO30KICAgICAgICAgIH19IHN0eWxlPXt7d2lkdGg6IjEwMCUiLHBhZGRpbmc6IjhweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJvcmRlcjoiMS41cHggc29saWQgIzJFNkI1RSIsCiAgICAgICAgICAgIGJhY2tncm91bmQ6InRyYW5zcGFyZW50Iixjb2xvcjoiIzJFNkI1RSIsZm9udFNpemU6IjEycHgiLGZvbnRXZWlnaHQ6IjcwMCIsCiAgICAgICAgICAgIGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCIsbWFyZ2luVG9wOiI0cHgifX0+CiAgICAgICAgICAgIPCfjoEg0JLRi9C00LDRgtGMINCy0YHQtSDRgtC+0LLQsNGA0YsKICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIH0KICAgICAgPC9kaXY+OwogICAgICB9KX0KICAgIDwvZGl2Pn0KCiAgICA8L2Rpdj4KCiAgICB7Lyog0JzQvtC00LDQu9C60LAg0L7RgtGH0ZHRgiAqL30KICAgIHtzaG93UmVzdWx0JiY8ZGl2IG9uQ2xpY2s9e2U9PntpZihlLnRhcmdldD09PWUuY3VycmVudFRhcmdldClzZXRTaG93UmVzdWx0KGZhbHNlKX19CiAgICAgIHN0eWxlPXt7cG9zaXRpb246ImZpeGVkIixpbnNldDowLGJhY2tncm91bmQ6InJnYmEoMCwwLDAsMC43KSIsZGlzcGxheToiZmxleCIsYWxpZ25JdGVtczoiZmxleC1lbmQiLHpJbmRleDoxMDAsYmFja2Ryb3BGaWx0ZXI6ImJsdXIoNHB4KSJ9fT4KICAgICAgPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6IiNGNUY1RTgiLGJvcmRlclJhZGl1czoiMjBweCAyMHB4IDAgMCIscGFkZGluZzoiMjRweCAyMHB4IDUwcHgiLHdpZHRoOiIxMDAlIixtYXhXaWR0aDoiNDgwcHgiLG1hcmdpbjoiMCBhdXRvIixtYXhIZWlnaHQ6IjkwdmgiLG92ZXJmbG93WToiYXV0byJ9fT4KICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciIsbWFyZ2luQm90dG9tOiIyMHB4In19PgogICAgICAgICAgPHNwYW4gc3R5bGU9e3tmb250RmFtaWx5OiInQ29ybW9yYW50IEdhcmFtb25kJyxzZXJpZiIsZm9udFN0eWxlOiJpdGFsaWMiLGZvbnRTaXplOiIyMnB4Iixjb2xvcjoiIzZCNEYyRSJ9fT7QntGC0YfRkdGCINGB0LzQtdC90Ys8L3NwYW4+CiAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpPT5zZXRTaG93UmVzdWx0KGZhbHNlKX0gc3R5bGU9e3tiYWNrZ3JvdW5kOiJub25lIixib3JkZXI6Im5vbmUiLGZvbnRTaXplOiIyMnB4IixjdXJzb3I6InBvaW50ZXIiLGNvbG9yOiIjODg4In19PsOXPC9idXR0b24+CiAgICAgICAgPC9kaXY+CgogICAgICAgIHsvKiDQqNCw0L/QutCwICovfQogICAgICAgIDxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjMWExYTFhIixib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxMnB4Iixjb2xvcjoiI0ZGRkZGMCJ9fT4KICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsb3BhY2l0eTowLjUsbGV0dGVyU3BhY2luZzoiMC4xMmVtIix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLG1hcmdpbkJvdHRvbToiNHB4In19Pk5BTkUgUEFSSVMgwrcg0J7RgtGH0ZHRgiDRgdC80LXQvdGLPC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE3cHgiLGZvbnRXZWlnaHQ6IjcwMCJ9fT57c2hpZnQuc2VsbGVyfTwvZGl2PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxM3B4IixvcGFjaXR5OjAuNixtYXJnaW5Ub3A6IjJweCJ9fT57Zm10RGF0ZShzaGlmdC5kYXRlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgey8qIFJPU1RBICovfQogICAgICAgIDxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjZmZmIixib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxMnB4Iixib3JkZXI6IjFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDgpIn19PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMHB4IixsZXR0ZXJTcGFjaW5nOiIwLjEyZW0iLHRleHRUcmFuc2Zvcm06InVwcGVyY2FzZSIsY29sb3I6IiM4ODgiLG1hcmdpbkJvdHRvbToiMTBweCJ9fT5ST1NUQTwvZGl2PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIyMnB4Iixmb250V2VpZ2h0OiI3MDAiLG1hcmdpbkJvdHRvbToiMTJweCIsY29sb3I6IiMxYTFhMWEifX0+e2ZtdChyb3N0YVRvdGFsKX0g4oK4PC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsZmxleERpcmVjdGlvbjoiY29sdW1uIixnYXA6IjZweCJ9fT4KICAgICAgICAgICAge1sKICAgICAgICAgICAgICBbIkthc3BpIFFSIiwgc2hpZnQuckthc3BpXSwKICAgICAgICAgICAgICBbItCe0L3Qu9Cw0LnQvSBLYXNwaSIsIHNoaWZ0LnJPbmxpbmVdLAogICAgICAgICAgICAgIFsiSGFseWsgUVIiLCBzaGlmdC5ySGFseWtdLAogICAgICAgICAgICAgIFsi0J7QvdC70LDQudC9IEhhbHlrIiwgc2hpZnQuckhhbHlrT25saW5lXSwKICAgICAgICAgICAgICBbItCd0LDQu9C40YfQvdGL0LUiLCBzaGlmdC5yQ2FzaF0sCiAgICAgICAgICAgICAgWyLQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsCIsIHNoaWZ0LnJQZXJzb25hbF0sCiAgICAgICAgICAgICAgWyLQkdC+0L3Rg9GB0YsiLCBzaGlmdC5yQm9udXNdLAogICAgICAgICAgICBdLmZpbHRlcigoWyx2XSk9PnBhcnNlKHYpPjApLm1hcCgoW2xhYmVsLHZhbF0pPT48ZGl2IGtleT17bGFiZWx9IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGZvbnRTaXplOiIxM3B4In19PgogICAgICAgICAgICAgIDxzcGFuIHN0eWxlPXt7Y29sb3I6IiM1NTUifX0+e2xhYmVsfTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRXZWlnaHQ6IjYwMCJ9fT57Zm10KHBhcnNlKHZhbCkpfSDigrg8L3NwYW4+CiAgICAgICAgICAgIDwvZGl2Pil9CiAgICAgICAgICAgIHtwYXJzZShzaGlmdC5yUmV0S2FzcGkpPjAmJjxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsZm9udFNpemU6IjEzcHgiLGNvbG9yOiIjYzYyODI4In19PgogICAgICAgICAgICAgIDxzcGFuPtCS0L7Qt9Cy0YDQsNGCIEthc3BpPC9zcGFuPjxzcGFuPuKIkntmbXQocGFyc2Uoc2hpZnQuclJldEthc3BpKSl9IOKCuDwvc3Bhbj4KICAgICAgICAgICAgPC9kaXY+fQogICAgICAgICAgICB7cGFyc2Uoc2hpZnQuclJldEhhbHlrKT4wJiY8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGZvbnRTaXplOiIxM3B4Iixjb2xvcjoiI2M2MjgyOCJ9fT4KICAgICAgICAgICAgICA8c3Bhbj7QktC+0LfQstGA0LDRgiBIYWx5azwvc3Bhbj48c3Bhbj7iiJJ7Zm10KHBhcnNlKHNoaWZ0LnJSZXRIYWx5aykpfSDigrg8L3NwYW4+CiAgICAgICAgICAgIDwvZGl2Pn0KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgoKICAgICAgICB7Lyog0KLQtdGA0LzQuNC90LDQu9GLICovfQogICAgICAgIDxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjZmZmIixib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxMnB4Iixib3JkZXI6IjFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDgpIn19PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMHB4IixsZXR0ZXJTcGFjaW5nOiIwLjEyZW0iLHRleHRUcmFuc2Zvcm06InVwcGVyY2FzZSIsY29sb3I6IiM4ODgiLG1hcmdpbkJvdHRvbToiMTBweCJ9fT7QotC10YDQvNC40L3QsNC70YsgKNGE0LDQutGCKTwvZGl2PgogICAgICAgICAge1sKICAgICAgICAgICAgWyJLYXNwaSIsIChwYXJzZShzaGlmdC50S2FzcGkpLXBhcnNlKHNoaWZ0LnRLYXNwaVJldCkpLCBwYXJzZShzaGlmdC50S2FzcGlSZXQpXSwKICAgICAgICAgICAgWyJIYWx5ayIsIChwYXJzZShzaGlmdC50SGFseWspLXBhcnNlKHNoaWZ0LnRIYWx5a1JldCkpLCBwYXJzZShzaGlmdC50SGFseWtSZXQpXSwKICAgICAgICAgICAgWyLQm9C40YfQvdCw0Y8g0LrQsNGA0YLQsCIsIHBhcnNlKHNoaWZ0LnRQZXJzb25hbCksIDBdLAogICAgICAgICAgXS5maWx0ZXIoKFssdl0pPT52PjApLm1hcCgoW2xhYmVsLG5ldCxyZXRdKT0+PGRpdiBrZXk9e2xhYmVsfSBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGp1c3RpZnlDb250ZW50OiJzcGFjZS1iZXR3ZWVuIixmb250U2l6ZToiMTNweCIsbWFyZ2luQm90dG9tOiI2cHgifX0+CiAgICAgICAgICAgIDxzcGFuIHN0eWxlPXt7Y29sb3I6IiM1NTUifX0+e2xhYmVsfTwvc3Bhbj4KICAgICAgICAgICAgPGRpdiBzdHlsZT17e3RleHRBbGlnbjoicmlnaHQifX0+CiAgICAgICAgICAgICAgPHNwYW4gc3R5bGU9e3tmb250V2VpZ2h0OiI2MDAifX0+e2ZtdChuZXQpfSDigrg8L3NwYW4+CiAgICAgICAgICAgICAge3JldD4wJiY8c3BhbiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4Iixjb2xvcjoiI2M2MjgyOCIsbWFyZ2luTGVmdDoiNnB4In19PuKIkntmbXQocmV0KX0g0LLQvtC30LLRgNCw0YI8L3NwYW4+fQogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2Pil9CiAgICAgICAgPC9kaXY+CgogICAgICAgIHsvKiDQmtCw0YHRgdCwICovfQogICAgICAgIDxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjZmZmIixib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxMnB4Iixib3JkZXI6IjFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDgpIn19PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMHB4IixsZXR0ZXJTcGFjaW5nOiIwLjEyZW0iLHRleHRUcmFuc2Zvcm06InVwcGVyY2FzZSIsY29sb3I6IiM4ODgiLG1hcmdpbkJvdHRvbToiMTBweCJ9fT7QmtCw0YHRgdCwPC9kaXY+CiAgICAgICAgICB7WwogICAgICAgICAgICBbItCe0YLQutGA0YvRgtC40LUiLCBzaGlmdC5jYXNoT3Blbl0sCiAgICAgICAgICAgIFsi0JfQsNC60YDRi9GC0LjQtSIsIHNoaWZ0LmNhc2hBY3R1YWxdLAogICAgICAgICAgICBbItCY0L3QutCw0YHRgdCw0YbQuNGPIiwgc2hpZnQuaW5rYXNzb10sCiAgICAgICAgICBdLmZpbHRlcigoWyx2XSk9PnBhcnNlKHYpPjApLm1hcCgoW2xhYmVsLHZhbF0pPT48ZGl2IGtleT17bGFiZWx9IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGZvbnRTaXplOiIxM3B4IixtYXJnaW5Cb3R0b206IjZweCJ9fT4KICAgICAgICAgICAgPHNwYW4gc3R5bGU9e3tjb2xvcjoiIzU1NSJ9fT57bGFiZWx9PC9zcGFuPgogICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRXZWlnaHQ6IjYwMCJ9fT57Zm10KHBhcnNlKHZhbCkpfSDigrg8L3NwYW4+CiAgICAgICAgICA8L2Rpdj4pfQogICAgICAgIDwvZGl2PgoKICAgICAgICB7Lyog0JjRgtC+0LMg0YEg0YPRh9GR0YLQvtC8INC/0YDQtdC00L7Qv9C70LDRgiAqL30KICAgICAgICB7KCgpPT57CiAgICAgICAgICBjb25zdCB0b3RhbFByZXBheUFkaj1PYmplY3QudmFsdWVzKGF0dGFjaGVkSW5jb21pbmcpLnJlZHVjZSgocyxsaXN0KT0+cytsaXN0LnJlZHVjZSgoc3MscCk9PnNzK3BhcnNlKHAuYW1vdW50KSwwKSwwKTsKICAgICAgICAgIGNvbnN0IGFkakRpZmY9dG90YWxEaWZmPDA/dG90YWxEaWZmK3RvdGFsUHJlcGF5QWRqOnRvdGFsRGlmZi10b3RhbFByZXBheUFkajsKICAgICAgICAgIGNvbnN0IGFkak9rPU1hdGguYWJzKGFkakRpZmYpPDUwMDsKICAgICAgICAgIGNvbnN0IHByZXBheUV4cGxhaW5lZD10b3RhbFByZXBheUFkaj4wJiZhZGpPayYmIWlzT2s7CiAgICAgICAgICByZXR1cm4gPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6YWRqT2s/InJnYmEoNzQsMjIyLDEyOCwwLjEpIjoicmdiYSgyNTEsMTEzLDExMywwLjA4KSIsCiAgICAgICAgICAgIGJvcmRlcjoiMXB4IHNvbGlkICIrKGFkak9rPyJyZ2JhKDc0LDIyMiwxMjgsMC4zKSI6InJnYmEoMjUxLDExMywxMTMsMC4zKSIpLAogICAgICAgICAgICBib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxNnB4In19PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoiMWZyIDFmciIsZ2FwOiIxMHB4IixtYXJnaW5Cb3R0b206IjEwcHgifX0+CiAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e3RleHRBbGlnbjoiY2VudGVyIn19PgogICAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMHB4Iixjb2xvcjoiIzg4OCIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixsZXR0ZXJTcGFjaW5nOiIwLjA4ZW0iLG1hcmdpbkJvdHRvbToiM3B4In19PlJPU1RBPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE2cHgiLGZvbnRXZWlnaHQ6IjcwMCJ9fT57Zm10KHJvc3RhVG90YWwpfSDigrg8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IHN0eWxlPXt7dGV4dEFsaWduOiJjZW50ZXIifX0+CiAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEwcHgiLGNvbG9yOiIjODg4Iix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLGxldHRlclNwYWNpbmc6IjAuMDhlbSIsbWFyZ2luQm90dG9tOiIzcHgifX0+0KTQsNC60YI8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTZweCIsZm9udFdlaWdodDoiNzAwIn19PntmbXQoZmFjdFRvdGFsKX0g4oK4PC9kaXY+CiAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICB7dG90YWxQcmVwYXlBZGo+MCYmPGRpdiBzdHlsZT17e3RleHRBbGlnbjoiY2VudGVyIixmb250U2l6ZToiMTNweCIsY29sb3I6IiMyRTZCNUUiLGZvbnRXZWlnaHQ6IjYwMCIsbWFyZ2luQm90dG9tOiI4cHgifX0+CiAgICAgICAgICAgICAg8J+SsyDQn9GA0LXQtNC+0L/Qu9Cw0YLQsDogK3tmbXQodG90YWxQcmVwYXlBZGopfSDigrgKICAgICAgICAgICAgPC9kaXY+fQogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7dGV4dEFsaWduOiJjZW50ZXIiLGZvbnRTaXplOiIxNnB4Iixmb250V2VpZ2h0OiI3MDAiLGNvbG9yOmFkak9rPyIjMjJjNTVlIjoiI2ZiNzE3MSJ9fT4KICAgICAgICAgICAgICB7YWRqT2s/IuKchSDQktGB0ZEg0YHRhdC+0LTQuNGC0YHRjyI6cHJlcGF5RXhwbGFpbmVkPyLinIUg0J7QsdGK0Y/RgdC90LXQvdC+INC/0YDQtdC00L7Qv9C70LDRgtC+0LkiOmDimqDvuI8g0KDQsNC30L3QuNGG0LA6ICR7YWRqRGlmZj4wPyIrIjoiIn0ke2ZtdChhZGpEaWZmKX0g4oK4YH0KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIHtwcmVwYXlFeHBsYWluZWQmJjxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246ImNlbnRlciIsZm9udFNpemU6IjEycHgiLGNvbG9yOiIjMkU2QjVFIixtYXJnaW5Ub3A6IjRweCJ9fT4KICAgICAgICAgICAgICDQoNCw0YHRhdC+0LbQtNC10L3QuNC1IHtmbXQoTWF0aC5hYnModG90YWxEaWZmKSl9IOKCuCDQt9Cw0LrRgNGL0YLQviDQv9GA0LXQtNC+0L/Qu9Cw0YLQvtC5INC60LvQuNC10L3RgtCwCiAgICAgICAgICAgIDwvZGl2Pn0KICAgICAgICAgIDwvZGl2PjsKICAgICAgICB9KSgpfQoKICAgICAgICB7Lyog0J/RgNC10LTQvtC/0LvQsNGC0Ysg0LrQu9C40LXQvdGC0L7QsiAqL30KICAgICAgICB7T2JqZWN0LnZhbHVlcyhhdHRhY2hlZEluY29taW5nKS5mbGF0KCkubGVuZ3RoPjAmJjxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjZmZmIixib3JkZXJSYWRpdXM6IjEycHgiLHBhZGRpbmc6IjE2cHggMThweCIsbWFyZ2luQm90dG9tOiIxMnB4Iixib3JkZXI6IjFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDgpIn19PgogICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMHB4IixsZXR0ZXJTcGFjaW5nOiIwLjEyZW0iLHRleHRUcmFuc2Zvcm06InVwcGVyY2FzZSIsY29sb3I6IiM4ODgiLG1hcmdpbkJvdHRvbToiMTJweCJ9fT7Qn9GA0LXQtNC+0L/Qu9Cw0YLRiyDQutC70LjQtdC90YLQvtCyPC9kaXY+CiAgICAgICAgICB7T2JqZWN0LmVudHJpZXMoYXR0YWNoZWRJbmNvbWluZykubWFwKChbY2hhbm5lbCxsaXN0XSk9Pmxpc3QubWFwKChwLGkpPT48ZGl2IGtleT17Y2hhbm5lbCtpfSBzdHlsZT17e2JvcmRlckxlZnQ6IjNweCBzb2xpZCAjMkU2QjVFIixwYWRkaW5nTGVmdDoiMTJweCIsbWFyZ2luQm90dG9tOiIxMnB4In19PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFdlaWdodDoiNzAwIixmb250U2l6ZToiMTRweCIsY29sb3I6IiMxYTFhMWEiLG1hcmdpbkJvdHRvbToiMnB4In19PntwLmNsaWVudF9uYW1lfHwi0JrQu9C40LXQvdGCIn08L2Rpdj4KICAgICAgICAgICAge3AucGhvbmUmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTJweCIsY29sb3I6IiM4ODgiLG1hcmdpbkJvdHRvbToiNHB4In19PvCfk7Ege3AucGhvbmV9PC9kaXY+fQogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoiMWZyIDFmciIsZ2FwOiI2cHgiLG1hcmdpblRvcDoiNnB4In19PgogICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiJyZ2JhKDAsMCwwLDAuMDMpIixib3JkZXJSYWRpdXM6IjZweCIscGFkZGluZzoiNnB4IDhweCJ9fT4KICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiOXB4Iixjb2xvcjoiIzg4OCIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixsZXR0ZXJTcGFjaW5nOiIwLjA4ZW0ifX0+0J/RgNC10LTQvtC/0LvQsNGC0LA8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTRweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjoiIzJFNkI1RSIsbWFyZ2luVG9wOiIxcHgifX0+e2ZtdChwYXJzZShwLmFtb3VudCkpfSDigrg8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICB7cGFyc2UocC5iYWxhbmNlfHwwKT4wJiY8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDoicmdiYSgxOTgsNDAsNDAsMC4wNSkiLGJvcmRlclJhZGl1czoiNnB4IixwYWRkaW5nOiI2cHggOHB4In19PgogICAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiI5cHgiLGNvbG9yOiIjODg4Iix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLGxldHRlclNwYWNpbmc6IjAuMDhlbSJ9fT7QntGB0YLQsNGC0L7QujwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxNHB4Iixmb250V2VpZ2h0OiI3MDAiLGNvbG9yOiIjYzYyODI4IixtYXJnaW5Ub3A6IjFweCJ9fT57Zm10KHBhcnNlKHAuYmFsYW5jZSkpfSDigrg8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj59CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICB7cC5pdGVtJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjNTU1IixtYXJnaW5Ub3A6IjZweCJ9fT7wn5GXIHtwLml0ZW19PC9kaXY+fQogICAgICAgICAgICB7cC5jaGFubmVsJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGNvbG9yOiIjODg4IixtYXJnaW5Ub3A6IjJweCJ9fT7wn5KzIHtwLmNoYW5uZWx9PC9kaXY+fQogICAgICAgICAgICB7cC5wcmVwX2RhdGUmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsY29sb3I6IiM4ODgiLG1hcmdpblRvcDoiMnB4In19PvCfk4Ug0JLQvdC10YHQtdC90L46IHtwLnByZXBfZGF0ZX08L2Rpdj59CiAgICAgICAgICAgIHtwLnByZXBfaWQmJjxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsY29sb3I6IiNiYmIiLG1hcmdpblRvcDoiMnB4In19PntwLnByZXBfaWR9PC9kaXY+fQogICAgICAgICAgPC9kaXY+KSl9CiAgICAgICAgPC9kaXY+fQoKICAgICAgICB7c2hpZnQubm90ZXMmJjxkaXYgc3R5bGU9e3tiYWNrZ3JvdW5kOiJyZ2JhKDAsMCwwLDAuMDQpIixib3JkZXJSYWRpdXM6IjEwcHgiLHBhZGRpbmc6IjEycHggMTRweCIsbWFyZ2luQm90dG9tOiIxNHB4Iixmb250U2l6ZToiMTNweCIsY29sb3I6IiM1NTUifX0+CiAgICAgICAgICDwn5OdIHtzaGlmdC5ub3Rlc30KICAgICAgICA8L2Rpdj59CgogICAgICAgIDxidXR0b24gb25DbGljaz17KCk9PnsKICAgICAgICAgIG5hdmlnYXRvci5jbGlwYm9hcmQmJm5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGJ1aWxkUmVwb3J0KCkpLnRoZW4oKCk9PntzZXRDb3BpZWQodHJ1ZSk7c2V0VGltZW91dCgoKT0+c2V0Q29waWVkKGZhbHNlKSwyNTAwKX0pOwogICAgICAgIH19IHN0eWxlPXt7Li4uQlROLGJhY2tncm91bmQ6Y29waWVkPyJyZ2JhKDc0LDIyMiwxMjgsMC4xNSkiOiIjMWExYTFhIixjb2xvcjpjb3BpZWQ/IiMyMmM1NWUiOiIjRkZGRkYwIn19PgogICAgICAgICAge2NvcGllZD8i4pyTINCh0LrQvtC/0LjRgNC+0LLQsNC90L4hIjoiXHVEODNEXHVEQ0NCINCh0LrQvtC/0LjRgNC+0LLQsNGC0YwifQogICAgICAgIDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2Pn0KICA8L2Rpdj47Cn0KCi8vIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAovLyDQodCi0KDQkNCd0JjQptCQINCS0JvQkNCU0JXQm9Cs0KbQkAovLyDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKZnVuY3Rpb24gT3duZXJQYWdlKCl7CiAgY29uc3QgW3RhYixzZXRUYWJdPXVzZVN0YXRlKCJkYXNoIik7CiAgY29uc3QgW3NhbGVzLHNldFNhbGVzXT11c2VTdGF0ZShbXSk7CiAgY29uc3QgW3ByZXBheXMsc2V0UHJlcGF5c109dXNlU3RhdGUoW10pOwogIGNvbnN0IFtsb2FkaW5nLHNldExvYWRpbmddPXVzZVN0YXRlKGZhbHNlKTsKICBjb25zdCBub3c9bmV3IERhdGUoKTsKICBjb25zdCBbbW9udGgsc2V0TW9udGhdPXVzZVN0YXRlKG5vdy5nZXRNb250aCgpKzEpOwogIGNvbnN0IFt5ZWFyLHNldFllYXJdPXVzZVN0YXRlKG5vdy5nZXRGdWxsWWVhcigpKTsKCiAgY29uc3QgbG9hZFNhbGVzPWFzeW5jKCk9PnsKICAgIHNldExvYWRpbmcodHJ1ZSk7CiAgICB0cnkgewogICAgICBjb25zdCBkYXRhPWF3YWl0IHNiRmV0Y2goImRhaWx5X3NhbGVzIiwiR0VUIixudWxsLGA/bW9udGg9ZXEuJHttb250aH0meWVhcj1lcS4ke3llYXJ9Jm9yZGVyPXNhbGVfZGF0ZS5hc2NgKTsKICAgICAgc2V0U2FsZXMoZGF0YXx8W10pOwogICAgfSBjYXRjaChlKXtjb25zb2xlLmVycm9yKGUpO30KICAgIHNldExvYWRpbmcoZmFsc2UpOwogIH07CgogIGNvbnN0IGxvYWRQcmVwYXlzPWFzeW5jKCk9PnsKICAgIHNldExvYWRpbmcodHJ1ZSk7CiAgICB0cnkgewogICAgICBjb25zdCBkYXRhPWF3YWl0IHNiRmV0Y2goInByZXBheW1lbnRzIiwiR0VUIixudWxsLCI/b3JkZXI9cHJlcF9kYXRlLmFzYyIpOwogICAgICBzZXRQcmVwYXlzKGRhdGF8fFtdKTsKICAgIH0gY2F0Y2goZSl7Y29uc29sZS5lcnJvcihlKTt9CiAgICBzZXRMb2FkaW5nKGZhbHNlKTsKICB9OwoKICB1c2VFZmZlY3QoKCk9PnsgaWYodGFiPT09ImRhc2gifHx0YWI9PT0ic2FsZXMiKWxvYWRTYWxlcygpOyBpZih0YWI9PT0icHJlcGF5cyIpbG9hZFByZXBheXMoKTsgfSxbdGFiLG1vbnRoLHllYXJdKTsKCiAgLy8g0KDQsNGB0YfRkdGC0YsKICBjb25zdCB0b3RhbFJldj1zYWxlcy5yZWR1Y2UoKHMseCk9PnMrTnVtYmVyKHgucmV2ZW51ZXx8MCksMCk7CiAgY29uc3QgcGxhbj0yNzAwMDAwMDsKICBjb25zdCBwY3Q9TWF0aC5yb3VuZCh0b3RhbFJldi9wbGFuKjEwMCk7CiAgY29uc3QgZGF5c0xlZnQ9bmV3IERhdGUoeWVhcixtb250aCwwKS5nZXREYXRlKCktbm93LmdldERhdGUoKTsKICBjb25zdCByZW1haW5pbmc9TWF0aC5tYXgoMCxwbGFuLXRvdGFsUmV2KTsKICBjb25zdCBkYWlseU5lZWQ9ZGF5c0xlZnQ+MD9NYXRoLnJvdW5kKHJlbWFpbmluZy9kYXlzTGVmdCk6MDsKCiAgLy8g0KHRg9C80LzRiyDQv9C+INC/0YDQvtC00LDQstGG0LDQvAogIGNvbnN0IHNlbGxlclRvdGFscz170JfQsNGA0LjQvdCwOjAs0JTQsNC70LjRgNCwOjB9OwogIGNvbnN0IHBlcnNvbmFsUGxhbnM9e9CX0LDRgNC40L3QsDoxMzUwMDAwMCzQlNCw0LvQuNGA0LA6MTM1MDAwMDB9OwogIHNhbGVzLmZvckVhY2gocz0+ewogICAgY29uc3QgcmV2PU51bWJlcihzLnJldmVudWV8fDApOwogICAgY29uc3Qgc2VsbGVycz1bcy5zZWxsZXIxLHMuc2VsbGVyMl0uZmlsdGVyKHg9PngmJnNlbGxlclRvdGFsc1t4XSE9PXVuZGVmaW5lZCk7CiAgICBpZihzZWxsZXJzLmxlbmd0aD09PTApIHJldHVybjsKICAgIGNvbnN0IG49c2VsbGVycy5sZW5ndGg7CiAgICBzZWxsZXJzLmZvckVhY2gobmFtZT0+e3NlbGxlclRvdGFsc1tuYW1lXSs9cmV2L247fSk7CiAgfSk7CgogIGNvbnN0IG1vbnRoTmFtZXM9WyIiLCLQr9C90LLQsNGA0YwiLCLQpNC10LLRgNCw0LvRjCIsItCc0LDRgNGCIiwi0JDQv9GA0LXQu9GMIiwi0JzQsNC5Iiwi0JjRjtC90YwiLCLQmNGO0LvRjCIsItCQ0LLQs9GD0YHRgiIsItCh0LXQvdGC0Y/QsdGA0YwiLCLQntC60YLRj9Cx0YDRjCIsItCd0L7Rj9Cx0YDRjCIsItCU0LXQutCw0LHRgNGMIl07CiAgY29uc3QgdGFicz1be2lkOiJkYXNoIixsYWJlbDoiXHVEODNEXHVEQ0NBINCU0LDRiNCx0L7RgNC0In0se2lkOiJzYWxlcyIsbGFiZWw6Ilx1RDgzRFx1RENDNSDQn9GA0L7QtNCw0LbQuCJ9LHtpZDoicHJlcGF5cyIsbGFiZWw6Ilx1RDgzRFx1RENCMyDQn9GA0LXQtNC+0L/Qu9Cw0YLRiyJ9LHtpZDoiZWRpdG9yIixsYWJlbDoi4pyPXHVGRTBGINCg0LXQtNCw0LrRgtC+0YAifV07CiAgY29uc3Qgc2VsbGVyQ29sb3JzPXvQl9Cw0YDQuNC90LA6IiM1YThlNzAiLNCU0LDQu9C40YDQsDoiIzcwNjBhOCJ9OwoKICByZXR1cm4gPGRpdiBzdHlsZT17e21heFdpZHRoOiI5MDBweCIsbWFyZ2luOiIwIGF1dG8iLHBhZGRpbmc6IjAgMCA2MHB4In19PgogICAgey8qINCo0LDQv9C60LAgKi99CiAgICA8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDoiIzFhMWExYSIscGFkZGluZzoiMThweCAyNHB4IixkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsYWxpZ25JdGVtczoiY2VudGVyIixwb3NpdGlvbjoic3RpY2t5Iix0b3A6MCx6SW5kZXg6MTB9fT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udEZhbWlseToiJ0Nvcm1vcmFudCBHYXJhbW9uZCcsc2VyaWYiLGZvbnRTdHlsZToiaXRhbGljIixmb250U2l6ZToiMjJweCIsY29sb3I6IiNGRkZGRjAifX0+TkFOw4kgUEFSSVM8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEwcHgiLGNvbG9yOiJyZ2JhKDI1NSwyNTUsMjU1LDAuNCkiLGxldHRlclNwYWNpbmc6IjAuMTVlbSIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixtYXJnaW5Ub3A6IjFweCJ9fT7QotC+0LzQuCDigJQg0KPQv9GA0LDQstC70LXQvdC40LU8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixnYXA6IjhweCIsYWxpZ25JdGVtczoiY2VudGVyIn19PgogICAgICAgIDxzZWxlY3Qgc3R5bGU9e3tiYWNrZ3JvdW5kOiJyZ2JhKDI1NSwyNTUsMjU1LDAuMSkiLGJvcmRlcjoibm9uZSIsY29sb3I6IiNGRkZGRjAiLGJvcmRlclJhZGl1czoiNnB4IixwYWRkaW5nOiI2cHggMTBweCIsZm9udFNpemU6IjEycHgiLGZvbnRGYW1pbHk6ImluaGVyaXQiLGN1cnNvcjoicG9pbnRlciJ9fQogICAgICAgICAgdmFsdWU9e21vbnRofSBvbkNoYW5nZT17ZT0+c2V0TW9udGgoTnVtYmVyKGUudGFyZ2V0LnZhbHVlKSl9PgogICAgICAgICAge1sxLDIsMyw0LDUsNiw3LDgsOSwxMCwxMSwxMl0ubWFwKG09PjxvcHRpb24ga2V5PXttfSB2YWx1ZT17bX0+e21vbnRoTmFtZXNbbV19PC9vcHRpb24+KX0KICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8c2VsZWN0IHN0eWxlPXt7YmFja2dyb3VuZDoicmdiYSgyNTUsMjU1LDI1NSwwLjEpIixib3JkZXI6Im5vbmUiLGNvbG9yOiIjRkZGRkYwIixib3JkZXJSYWRpdXM6IjZweCIscGFkZGluZzoiNnB4IDEwcHgiLGZvbnRTaXplOiIxMnB4Iixmb250RmFtaWx5OiJpbmhlcml0IixjdXJzb3I6InBvaW50ZXIifX0KICAgICAgICAgIHZhbHVlPXt5ZWFyfSBvbkNoYW5nZT17ZT0+c2V0WWVhcihOdW1iZXIoZS50YXJnZXQudmFsdWUpKX0+CiAgICAgICAgICB7WzIwMjUsMjAyNiwyMDI3XS5tYXAoeT0+PG9wdGlvbiBrZXk9e3l9Pnt5fTwvb3B0aW9uPil9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgey8qINCi0LDQsdGLICovfQogICAgPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGJhY2tncm91bmQ6InJnYmEoMCwwLDAsMC4wNikiLGJvcmRlckJvdHRvbToiMXB4IHNvbGlkIHJnYmEoMCwwLDAsMC4xKSJ9fT4KICAgICAge3RhYnMubWFwKHQ9PjxidXR0b24ga2V5PXt0LmlkfSBvbkNsaWNrPXsoKT0+c2V0VGFiKHQuaWQpfQogICAgICAgIHN0eWxlPXt7cGFkZGluZzoiMTNweCAyMHB4Iixib3JkZXI6Im5vbmUiLGJhY2tncm91bmQ6Im5vbmUiLGJvcmRlckJvdHRvbToiMnB4IHNvbGlkICIrKHRhYj09PXQuaWQ/IiMxYTFhMWEiOiJ0cmFuc3BhcmVudCIpLAogICAgICAgICAgZm9udFNpemU6IjEycHgiLGZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6dGFiPT09dC5pZD8iIzFhMWExYSI6IiM4ODgiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCIsbGV0dGVyU3BhY2luZzoiMC4wM2VtIn19PgogICAgICAgIHt0LmxhYmVsfQogICAgICA8L2J1dHRvbj4pfQogICAgPC9kaXY+CgogICAgPGRpdiBzdHlsZT17e3BhZGRpbmc6IjI0cHggMjBweCJ9fT4KCiAgICB7Lyog4pSA4pSAINCU0JDQqNCR0J7QoNCUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqL30KICAgIHt0YWI9PT0iZGFzaCImJjxkaXY+CiAgICAgIHtsb2FkaW5nPzxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246ImNlbnRlciIscGFkZGluZzoiNDBweCIsY29sb3I6IiM4ODgifX0+0JfQsNCz0YDRg9C30LrQsC4uLjwvZGl2Pjo8PgoKICAgICAgey8qINCf0YDQvtCz0YDQtdGB0YEg0LzQsNCz0LDQt9C40L3QsCAqL30KICAgICAgPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6IiMxYTFhMWEiLGJvcmRlclJhZGl1czoiMTRweCIscGFkZGluZzoiMjJweCIsbWFyZ2luQm90dG9tOiIyMHB4Iixjb2xvcjoiI0ZGRkZGMCJ9fT4KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjExcHgiLGxldHRlclNwYWNpbmc6IjAuMTVlbSIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixjb2xvcjoicmdiYSgyNTUsMjU1LDI1NSwwLjQpIixtYXJnaW5Cb3R0b206IjZweCJ9fT57bW9udGhOYW1lc1ttb250aF19IHt5ZWFyfTwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMzZweCIsZm9udFdlaWdodDoiNzAwIixsZXR0ZXJTcGFjaW5nOiItMC4wMmVtIn19PntmbXQodG90YWxSZXYpfSDigrg8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEzcHgiLGNvbG9yOiJyZ2JhKDI1NSwyNTUsMjU1LDAuNSkiLG1hcmdpblRvcDoiMnB4In19PtC40Lcge2ZtdChwbGFuKX0g4oK4INC/0LvQsNC90LA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDoicmdiYSgyNTUsMjU1LDI1NSwwLjEpIixib3JkZXJSYWRpdXM6IjZweCIsaGVpZ2h0OiI4cHgiLG1hcmdpbjoiMTRweCAwIDEwcHgiLG92ZXJmbG93OiJoaWRkZW4ifX0+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7aGVpZ2h0OiIxMDAlIixib3JkZXJSYWRpdXM6IjZweCIsYmFja2dyb3VuZDoiI0ZGRkZGMCIsd2lkdGg6TWF0aC5taW4ocGN0LDEwMCkrIiUiLHRyYW5zaXRpb246IndpZHRoIDAuNHMifX0vPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsZm9udFNpemU6IjEycHgiLGNvbG9yOiJyZ2JhKDI1NSwyNTUsMjU1LDAuNSkifX0+CiAgICAgICAgICA8c3Bhbj57cGN0fSUg0LLRi9C/0L7Qu9C90LXQvdC+PC9zcGFuPgogICAgICAgICAgPHNwYW4+0L3Rg9C20L3QviB7Zm10KGRhaWx5TmVlZCl9IOKCuC/QtNC10L3RjCDCtyB7ZGF5c0xlZnR9INC00L3QtdC5PC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIHsvKiDQn9GA0L7QtNCw0LLRhtGLICovfQogICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoicmVwZWF0KGF1dG8tZml0LG1pbm1heCgyNDBweCwxZnIpKSIsZ2FwOiIxMnB4IixtYXJnaW5Cb3R0b206IjIwcHgifX0+CiAgICAgICAge09iamVjdC5lbnRyaWVzKHNlbGxlclRvdGFscykuZmlsdGVyKChbLHZdKT0+dj4wKS5tYXAoKFtuYW1lLHZhbF0pPT57CiAgICAgICAgICBjb25zdCBwbD1wZXJzb25hbFBsYW5zW25hbWVdfHwwOwogICAgICAgICAgY29uc3QgcD1wbD4wP01hdGgucm91bmQodmFsL3BsKjEwMCk6MDsKICAgICAgICAgIGNvbnN0IGM9c2VsbGVyQ29sb3JzW25hbWVdfHwiIzg4OCI7CiAgICAgICAgICByZXR1cm4gPGRpdiBrZXk9e25hbWV9IHN0eWxlPXt7YmFja2dyb3VuZDoiI2ZmZiIsYm9yZGVyOiIxcHggc29saWQgcmdiYSgwLDAsMCwwLjA4KSIsYm9yZGVyUmFkaXVzOiIxMnB4IixvdmVyZmxvdzoiaGlkZGVuIn19PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDpjLHBhZGRpbmc6IjEycHggMTZweCIsZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciJ9fT4KICAgICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6IiNmZmYiLGZvbnRTaXplOiIxNHB4In19PntuYW1lfTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBzdHlsZT17e2ZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6IiNmZmYiLGZvbnRTaXplOiIxOHB4In19PntwfSU8L3NwYW4+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7cGFkZGluZzoiMTJweCAxNnB4In19PgogICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMThweCIsZm9udFdlaWdodDoiNzAwIn19PntmbXQodmFsKX0g4oK4PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiIzg4OCIsbWFyZ2luVG9wOiIycHgifX0+0LjQtyB7Zm10KHBsKX0g4oK4PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2JhY2tncm91bmQ6IiNmMGYwZWMiLGJvcmRlclJhZGl1czoiNHB4IixoZWlnaHQ6IjVweCIsbWFyZ2luOiIxMHB4IDAgNnB4IixvdmVyZmxvdzoiaGlkZGVuIn19PgogICAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2hlaWdodDoiMTAwJSIsYm9yZGVyUmFkaXVzOiI0cHgiLGJhY2tncm91bmQ6Yyx3aWR0aDpNYXRoLm1pbihwLDEwMCkrIiUifX0vPgogICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgIDxkaXYgc3R5bGU9e3tmb250U2l6ZToiMTFweCIsY29sb3I6IiM4ODgifX0+0L7RgdGC0LDQu9C+0YHRjCB7Zm10KE1hdGgubWF4KDAscGwtdmFsKSl9IOKCuDwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PjsKICAgICAgICB9KX0KICAgICAgPC9kaXY+CgogICAgICB7Lyog0JHRi9GB0YLRgNCw0Y8g0YHRgtCw0YLQuNGB0YLQuNC60LAgKi99CiAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJncmlkIixncmlkVGVtcGxhdGVDb2x1bW5zOiJyZXBlYXQoMywxZnIpIixnYXA6IjEwcHgifX0+CiAgICAgICAge1sKICAgICAgICAgIHtsYWJlbDoi0JTQvdC10Lkg0L/RgNC+0LTQsNC2Iix2YWw6c2FsZXMubGVuZ3RofSwKICAgICAgICAgIHtsYWJlbDoi0KHRgNC10LTQvdC40Lkg0LTQtdC90YwiLHZhbDpzYWxlcy5sZW5ndGg+MD9mbXQoTWF0aC5yb3VuZCh0b3RhbFJldi9zYWxlcy5sZW5ndGgpKSsiIOKCuCI6IuKAlCJ9LAogICAgICAgICAge2xhYmVsOiLQm9GD0YfRiNC40Lkg0LTQtdC90YwiLHZhbDpzYWxlcy5sZW5ndGg+MD9mbXQoTWF0aC5tYXgoLi4uc2FsZXMubWFwKHM9Pk51bWJlcihzLnJldmVudWV8fDApKSkpKyIg4oK4Ijoi4oCUIn0sCiAgICAgICAgXS5tYXAoKHtsYWJlbCx2YWx9KT0+PGRpdiBrZXk9e2xhYmVsfSBzdHlsZT17e2JhY2tncm91bmQ6InJnYmEoMCwwLDAsMC4wNCkiLGJvcmRlclJhZGl1czoiMTBweCIscGFkZGluZzoiMTRweCIsdGV4dEFsaWduOiJjZW50ZXIifX0+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEwcHgiLGNvbG9yOiIjODg4Iix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLGxldHRlclNwYWNpbmc6IjAuMWVtIixtYXJnaW5Cb3R0b206IjRweCJ9fT57bGFiZWx9PC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE4cHgiLGZvbnRXZWlnaHQ6IjcwMCJ9fT57dmFsfTwvZGl2PgogICAgICAgIDwvZGl2Pil9CiAgICAgIDwvZGl2PgogICAgICA8Lz59CiAgICA8L2Rpdj59CgogICAgey8qIOKUgOKUgCDQn9Cg0J7QlNCQ0JbQmCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi99CiAgICB7dGFiPT09InNhbGVzIiYmPGRpdj4KICAgICAge2xvYWRpbmc/PGRpdiBzdHlsZT17e3RleHRBbGlnbjoiY2VudGVyIixwYWRkaW5nOiI0MHB4Iixjb2xvcjoiIzg4OCJ9fT7Ql9Cw0LPRgNGD0LfQutCwLi4uPC9kaXY+OgogICAgICBzYWxlcy5sZW5ndGg9PT0wPzxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246ImNlbnRlciIscGFkZGluZzoiNDBweCIsY29sb3I6IiM4ODgifX0+0J3QtdGCINC00LDQvdC90YvRhSDQt9CwIHttb250aE5hbWVzW21vbnRoXX0ge3llYXJ9PC9kaXY+OgogICAgICA8ZGl2IHN0eWxlPXt7b3ZlcmZsb3dYOiJhdXRvIn19PgogICAgICAgIDx0YWJsZSBzdHlsZT17e3dpZHRoOiIxMDAlIixib3JkZXJDb2xsYXBzZToiY29sbGFwc2UiLGZvbnRTaXplOiIxM3B4In19PgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHIgc3R5bGU9e3tiYWNrZ3JvdW5kOiIjMWExYTFhIixjb2xvcjoiI0ZGRkZGMCJ9fT4KICAgICAgICAgICAgICB7WyLQlNCw0YLQsCIsItCS0YvRgNGD0YfQutCwIiwi0J/RgNC+0LTQsNCy0LXRhiAxIiwi0J/RgNC+0LTQsNCy0LXRhiAyIl0ubWFwKGg9Pjx0aCBrZXk9e2h9IHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4Iix0ZXh0QWxpZ246ImxlZnQiLGZvbnRTaXplOiIxMHB4Iix0ZXh0VHJhbnNmb3JtOiJ1cHBlcmNhc2UiLGxldHRlclNwYWNpbmc6IjAuMDhlbSIsZm9udFdlaWdodDoiNzAwIix3aGl0ZVNwYWNlOiJub3dyYXAifX0+e2h9PC90aD4pfQogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90aGVhZD4KICAgICAgICAgIDx0Ym9keT4KICAgICAgICAgICAge3NhbGVzLm1hcCgocyxpKT0+ewogICAgICAgICAgICAgIGNvbnN0IHJldj1OdW1iZXIocy5yZXZlbnVlfHwwKTsKICAgICAgICAgICAgICBjb25zdCBkPXMuc2FsZV9kYXRlP3Muc2FsZV9kYXRlLnNsaWNlKDgsMTApKyIuIitzLnNhbGVfZGF0ZS5zbGljZSg1LDcpOiI/IjsKICAgICAgICAgICAgICByZXR1cm4gPHRyIGtleT17aX0gc3R5bGU9e3tiYWNrZ3JvdW5kOmklMj09PTA/IiNmZmYiOiJyZ2JhKDAsMCwwLDAuMDIpIixib3JkZXJCb3R0b206IjFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDYpIn19PgogICAgICAgICAgICAgICAgPHRkIHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4Iixjb2xvcjoiIzU1NSJ9fT57ZH08L3RkPgogICAgICAgICAgICAgICAgPHRkIHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4Iixmb250V2VpZ2h0OiI3MDAifX0+e2ZtdChyZXYpfSDigrg8L3RkPgogICAgICAgICAgICAgICAgPHRkIHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4In19PjxzcGFuIHN0eWxlPXt7YmFja2dyb3VuZDpzZWxsZXJDb2xvcnNbcy5zZWxsZXIxXXx8IiNkZGQiLGNvbG9yOiIjZmZmIixwYWRkaW5nOiIycHggOHB4Iixib3JkZXJSYWRpdXM6IjIwcHgiLGZvbnRTaXplOiIxMXB4Iixmb250V2VpZ2h0OiI3MDAifX0+e3Muc2VsbGVyMXx8IuKAlCJ9PC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgICA8dGQgc3R5bGU9e3twYWRkaW5nOiIxMHB4IDEycHgifX0+e3Muc2VsbGVyMj88c3BhbiBzdHlsZT17e2JhY2tncm91bmQ6c2VsbGVyQ29sb3JzW3Muc2VsbGVyMl18fCIjZGRkIixjb2xvcjoiI2ZmZiIscGFkZGluZzoiMnB4IDhweCIsYm9yZGVyUmFkaXVzOiIyMHB4Iixmb250U2l6ZToiMTFweCIsZm9udFdlaWdodDoiNzAwIn19PntzLnNlbGxlcjJ9PC9zcGFuPjoi4oCUIn08L3RkPgogICAgICAgICAgICAgIDwvdHI+OwogICAgICAgICAgICB9KX0KICAgICAgICAgIDwvdGJvZHk+CiAgICAgICAgICA8dGZvb3Q+CiAgICAgICAgICAgIDx0ciBzdHlsZT17e2JhY2tncm91bmQ6IiMxYTFhMWEiLGNvbG9yOiIjRkZGRkYwIixmb250V2VpZ2h0OiI3MDAifX0+CiAgICAgICAgICAgICAgPHRkIHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4Iixmb250U2l6ZToiMTFweCIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixsZXR0ZXJTcGFjaW5nOiIwLjA1ZW0ifX0+0JjRgtC+0LPQvjwvdGQ+CiAgICAgICAgICAgICAgPHRkIHN0eWxlPXt7cGFkZGluZzoiMTBweCAxMnB4In19PntmbXQodG90YWxSZXYpfSDigrg8L3RkPgogICAgICAgICAgICAgIDx0ZCBjb2xTcGFuPXsyfSBzdHlsZT17e3BhZGRpbmc6IjEwcHggMTJweCIsZm9udFNpemU6IjExcHgiLGNvbG9yOiJyZ2JhKDI1NSwyNTUsMjU1LDAuNSkifX0+e3NhbGVzLmxlbmd0aH0g0YHQvNC10L08L3RkPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90Zm9vdD4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj59CiAgICA8L2Rpdj59CgogICAgey8qIOKUgOKUgCDQn9Cg0JXQlNCe0J/Qm9CQ0KLQqyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi99CiAgICB7dGFiPT09InByZXBheXMiJiY8ZGl2PgogICAgICA8YnV0dG9uIG9uQ2xpY2s9e2xvYWRQcmVwYXlzfSBkaXNhYmxlZD17bG9hZGluZ30KICAgICAgICBzdHlsZT17ey4uLkJUTixtYXJnaW5Cb3R0b206IjE2cHgiLG9wYWNpdHk6bG9hZGluZz8wLjU6MSxtYXhXaWR0aDoiMjAwcHgifX0+CiAgICAgICAge2xvYWRpbmc/IuKPsyDQl9Cw0LPRgNGD0LfQutCwLi4uIjoiXHVEODNEXHVERDA0INCe0LHQvdC+0LLQuNGC0YwifQogICAgICA8L2J1dHRvbj4KICAgICAge3ByZXBheXMuZmlsdGVyKHA9PiFwLnN0YXR1cy5pbmNsdWRlcygi0JfQsNC60YDRi9GC0LAiKSkubWFwKChwLGkpPT57CiAgICAgICAgY29uc3QgaXNPcGVuPSFwLnN0YXR1cy5pbmNsdWRlcygi0JfQsNC60YDRi9GC0LAiKTsKICAgICAgICByZXR1cm4gPGRpdiBrZXk9e2l9IHN0eWxlPXt7Ym9yZGVyOiIxLjVweCBzb2xpZCAiKyhpc09wZW4/IiNlNmE4MTciOiIjNGNhZjUwIiksYm9yZGVyUmFkaXVzOiIxMHB4IiwKICAgICAgICAgIHBhZGRpbmc6IjE0cHgiLG1hcmdpbkJvdHRvbToiMTBweCIsYmFja2dyb3VuZDppc09wZW4/InJnYmEoMjU1LDI0OCwyMjAsMC42KSI6InJnYmEoMjMyLDI0NSwyMzMsMC42KSJ9fT4KICAgICAgICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixqdXN0aWZ5Q29udGVudDoic3BhY2UtYmV0d2VlbiIsbWFyZ2luQm90dG9tOiI2cHgifX0+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRXZWlnaHQ6IjcwMCIsZm9udFNpemU6IjE0cHgifX0+e3AuY2xpZW50X25hbWV9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4Iixjb2xvcjoiIzU1NSJ9fT57cC5wcmVwX2lkfSDCtyB7cC5jaGFubmVsfSDCtyB7cC5wcmVwX2RhdGV9PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2IHN0eWxlPXt7dGV4dEFsaWduOiJyaWdodCJ9fT4KICAgICAgICAgICAgICA8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjE4cHgiLGZvbnRXZWlnaHQ6IjcwMCIsY29sb3I6IiMyRTZCNUUifX0+e2ZtdChwLmFtb3VudCl9IOKCuDwvZGl2PgogICAgICAgICAgICAgIHtwLmJhbGFuY2U+MCYmPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiI2M2MjgyOCJ9fT7QlNC+0LvQszoge2ZtdChwLmJhbGFuY2UpfSDigrg8L2Rpdj59CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICB7cC5pdGVtJiY8ZGl2IHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjNTU1In19PvCfkZcge3AuaXRlbX08L2Rpdj59CiAgICAgICAgPC9kaXY+OwogICAgICB9KX0KICAgICAge3ByZXBheXMuZmlsdGVyKHA9PiFwLnN0YXR1cy5pbmNsdWRlcygi0JfQsNC60YDRi9GC0LAiKSkubGVuZ3RoPT09MCYmIWxvYWRpbmcmJgogICAgICAgIDxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246ImNlbnRlciIscGFkZGluZzoiNDBweCIsY29sb3I6IiM4ODgifX0+0J3QtdGCINC+0YLQutGA0YvRgtGL0YUg0L/RgNC10LTQvtC/0LvQsNGCPC9kaXY+fQogICAgPC9kaXY+fQoKICAgIHsvKiDilIDilIAg0KDQldCU0JDQmtCi0J7QoCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi99CiAgICB7dGFiPT09ImVkaXRvciImJjxFZGl0b3JUYWIvPn0KCiAgICA8L2Rpdj4KICA8L2Rpdj47Cn0KCi8vIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAovLyDQoNCV0JTQkNCa0KLQntCgINCX0JDQn9CY0KHQldCZCi8vIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkApmdW5jdGlvbiBFZGl0b3JUYWIoKXsKICBjb25zdCBbdGFibGUsc2V0VGFibGVdPXVzZVN0YXRlKCJkYWlseV9zYWxlcyIpOwogIGNvbnN0IFtyb3dzLHNldFJvd3NdPXVzZVN0YXRlKFtdKTsKICBjb25zdCBbbG9hZGluZyxzZXRMb2FkaW5nXT11c2VTdGF0ZShmYWxzZSk7CiAgY29uc3QgW2VkaXRSb3csc2V0RWRpdFJvd109dXNlU3RhdGUobnVsbCk7CiAgY29uc3QgW2VkaXREYXRhLHNldEVkaXREYXRhXT11c2VTdGF0ZSh7fSk7CiAgY29uc3QgW3NhdmluZyxzZXRTYXZpbmddPXVzZVN0YXRlKGZhbHNlKTsKICBjb25zdCBbbXNnLHNldE1zZ109dXNlU3RhdGUoIiIpOwogIGNvbnN0IG5vdz1uZXcgRGF0ZSgpOwogIGNvbnN0IFtmaWx0ZXJNb250aCxzZXRGaWx0ZXJNb250aF09dXNlU3RhdGUobm93LmdldE1vbnRoKCkrMSk7CiAgY29uc3QgW2ZpbHRlclllYXIsc2V0RmlsdGVyWWVhcl09dXNlU3RhdGUobm93LmdldEZ1bGxZZWFyKCkpOwoKICBjb25zdCB0YWJsZXM9WwogICAge2lkOiJkYWlseV9zYWxlcyIsbGFiZWw6Ilx1RDgzRFx1RENDNSDQn9GA0L7QtNCw0LbQuCDQv9C+INC00L3Rj9C8In0sCiAgICB7aWQ6InByZXBheW1lbnRzIixsYWJlbDoiXHVEODNEXHVEQ0IzINCf0YDQtdC00L7Qv9C70LDRgtGLIn0sCiAgICB7aWQ6Im9wZW5fc2hpZnRzIixsYWJlbDoiXHVEODNEXHVERDA0INCe0YLQutGA0YvRgtGL0LUg0YHQvNC10L3RiyJ9LAogICAge2lkOiJleHBlbnNlcyIsbGFiZWw6Ilx1RDgzRFx1RENCOCDQoNCw0YHRhdC+0LTRiyJ9LAogIF07CgogIGNvbnN0IG1vbnRoTmFtZXM9WyIiLCLQr9C90LLQsNGA0YwiLCLQpNC10LLRgNCw0LvRjCIsItCc0LDRgNGCIiwi0JDQv9GA0LXQu9GMIiwi0JzQsNC5Iiwi0JjRjtC90YwiLCLQmNGO0LvRjCIsItCQ0LLQs9GD0YHRgiIsItCh0LXQvdGC0Y/QsdGA0YwiLCLQntC60YLRj9Cx0YDRjCIsItCd0L7Rj9Cx0YDRjCIsItCU0LXQutCw0LHRgNGMIl07CgogIGNvbnN0IGxvYWRSb3dzPWFzeW5jKCk9PnsKICAgIHNldExvYWRpbmcodHJ1ZSk7CiAgICBzZXRSb3dzKFtdKTsKICAgIHNldEVkaXRSb3cobnVsbCk7CiAgICB0cnkgewogICAgICBsZXQgZmlsdGVyPSI/b3JkZXI9aWQuZGVzYyZsaW1pdD0xMDAiOwogICAgICBpZih0YWJsZT09PSJkYWlseV9zYWxlcyIpewogICAgICAgIGZpbHRlcj1gP21vbnRoPWVxLiR7ZmlsdGVyTW9udGh9JnllYXI9ZXEuJHtmaWx0ZXJZZWFyfSZvcmRlcj1zYWxlX2RhdGUuYXNjYDsKICAgICAgfSBlbHNlIGlmKHRhYmxlPT09InByZXBheW1lbnRzIil7CiAgICAgICAgLy8g0J/RgNC10LTQvtC/0LvQsNGC0Ysg0L/QvtC60LDQt9GL0LLQsNC10Lwg0LLRgdC1IOKAlCDQvtC90Lgg0LzQvtCz0YPRgiDQsdGL0YLRjCDQt9CwINGA0LDQt9C90YvQtSDQvNC10YHRj9GG0YsKICAgICAgICBmaWx0ZXI9YD9vcmRlcj1wcmVwX2RhdGUuZGVzYyZsaW1pdD0xMDBgOwogICAgICB9IGVsc2UgaWYodGFibGU9PT0iZXhwZW5zZXMiKXsKICAgICAgICAvLyDQoNCw0YHRhdC+0LTRiyDQv9C+0LrQsNC30YvQstCw0LXQvCDQstGB0LUg0LHQtdC3INGE0LjQu9GM0YLRgNCwINC/0L4g0LzQtdGB0Y/RhtGDCiAgICAgICAgZmlsdGVyPWA/b3JkZXI9ZXhwZW5zZV9kYXRlLmRlc2MmbGltaXQ9MTAwYDsKICAgICAgfQogICAgICBjb25zdCBkYXRhPWF3YWl0IHNiRmV0Y2godGFibGUsIkdFVCIsbnVsbCxmaWx0ZXIpOwogICAgICBzZXRSb3dzKGRhdGF8fFtdKTsKICAgIH0gY2F0Y2goZSl7c2V0TXNnKCLQntGI0LjQsdC60LA6ICIrZS5tZXNzYWdlKTt9CiAgICBzZXRMb2FkaW5nKGZhbHNlKTsKICB9OwoKICBjb25zdCBzdGFydEVkaXQ9KHJvdyk9PnsKICAgIHNldEVkaXRSb3cocm93LmlkKTsKICAgIHNldEVkaXREYXRhKHsuLi5yb3d9KTsKICB9OwoKICBjb25zdCBzYXZlRWRpdD1hc3luYygpPT57CiAgICBzZXRTYXZpbmcodHJ1ZSk7CiAgICB0cnkgewogICAgICBhd2FpdCBzYkZldGNoKHRhYmxlLCJQQVRDSCIsZWRpdERhdGEsIj9pZD1lcS4iK2VkaXRSb3cpOwogICAgICBzZXRNc2coIuKchSDQodC+0YXRgNCw0L3QtdC90L4iKTsKICAgICAgc2V0RWRpdFJvdyhudWxsKTsKICAgICAgbG9hZFJvd3MoKTsKICAgIH0gY2F0Y2goZSl7c2V0TXNnKCLQntGI0LjQsdC60LA6ICIrZS5tZXNzYWdlKTt9CiAgICBzZXRTYXZpbmcoZmFsc2UpOwogICAgc2V0VGltZW91dCgoKT0+c2V0TXNnKCIiKSwzMDAwKTsKICB9OwoKICBjb25zdCBkZWxldGVSb3c9YXN5bmMoaWQpPT57CiAgICBpZighd2luZG93LmNvbmZpcm0oItCj0LTQsNC70LjRgtGMINGN0YLRgyDQt9Cw0L/QuNGB0Yw/IikpIHJldHVybjsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHVybD1gJHtBUElfVVJMfS9hcGkvZGIvJHt0YWJsZX0/aWQ9ZXEuJHtpZH1gOwogICAgICBhd2FpdCBmZXRjaCh1cmwse21ldGhvZDoiREVMRVRFIixoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9fSk7CiAgICAgIHNldE1zZygi4pyFINCj0LTQsNC70LXQvdC+Iik7CiAgICAgIGxvYWRSb3dzKCk7CiAgICB9IGNhdGNoKGUpe3NldE1zZygi0J7RiNC40LHQutCwOiAiK2UubWVzc2FnZSk7fQogICAgc2V0VGltZW91dCgoKT0+c2V0TXNnKCIiKSwzMDAwKTsKICB9OwoKICBjb25zdCBmbXQ9bj0+TWF0aC5yb3VuZChufHwwKS50b0xvY2FsZVN0cmluZygicnUtUlUiKTsKCiAgY29uc3QgW2V4cGVuc2VGb3JtLHNldEV4cGVuc2VGb3JtXT11c2VTdGF0ZSh7ZGF0ZTp0b2RheVN0cigpLGNhdGVnb3J5OiIiLGRlc2NyaXB0aW9uOiIiLHN1bToiIn0pOwogIGNvbnN0IFthZGRpbmdFeHBlbnNlLHNldEFkZGluZ0V4cGVuc2VdPXVzZVN0YXRlKGZhbHNlKTsKICBjb25zdCBbc2hvd0FkZEV4cGVuc2Usc2V0U2hvd0FkZEV4cGVuc2VdPXVzZVN0YXRlKGZhbHNlKTsKCiAgY29uc3QgaGFuZGxlQWRkRXhwZW5zZT1hc3luYygpPT57CiAgICBpZighZXhwZW5zZUZvcm0uc3VtfHwhZXhwZW5zZUZvcm0uY2F0ZWdvcnkpe2FsZXJ0KCLQl9Cw0L/QvtC70L3QuCDQutCw0YLQtdCz0L7RgNC40Y4g0Lgg0YHRg9C80LzRgyIpO3JldHVybjt9CiAgICBzZXRBZGRpbmdFeHBlbnNlKHRydWUpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc2JGZXRjaCgiZXhwZW5zZXMiLCJQT1NUIix7CiAgICAgICAgZXhwZW5zZV9kYXRlOmV4cGVuc2VGb3JtLmRhdGUsCiAgICAgICAgY2F0ZWdvcnk6ZXhwZW5zZUZvcm0uY2F0ZWdvcnksCiAgICAgICAgZGVzY3JpcHRpb246ZXhwZW5zZUZvcm0uZGVzY3JpcHRpb24sCiAgICAgICAgYW1vdW50OnBhcnNlKGV4cGVuc2VGb3JtLnN1bSksCiAgICAgICAgbW9udGg6cGFyc2VJbnQoZXhwZW5zZUZvcm0uZGF0ZS5zcGxpdCgiLSIpWzFdKSwKICAgICAgICB5ZWFyOnBhcnNlSW50KGV4cGVuc2VGb3JtLmRhdGUuc3BsaXQoIi0iKVswXSkKICAgICAgfSk7CiAgICAgIHNldE1zZygi4pyFINCg0LDRgdGF0L7QtCDQtNC+0LHQsNCy0LvQtdC9Iik7CiAgICAgIHNldEV4cGVuc2VGb3JtKHtkYXRlOnRvZGF5U3RyKCksY2F0ZWdvcnk6IiIsZGVzY3JpcHRpb246IiIsc3VtOiIifSk7CiAgICAgIHNldFNob3dBZGRFeHBlbnNlKGZhbHNlKTsKICAgICAgaWYodGFibGU9PT0iZXhwZW5zZXMiKSBsb2FkUm93cygpOwogICAgfSBjYXRjaChlKXtzZXRNc2coItCe0YjQuNCx0LrQsDogIitlLm1lc3NhZ2UpO30KICAgIHNldEFkZGluZ0V4cGVuc2UoZmFsc2UpOwogICAgc2V0VGltZW91dCgoKT0+c2V0TXNnKCIiKSwzMDAwKTsKICB9OwoKICBjb25zdCBleHBlbnNlQ2F0ZWdvcmllcz1bItCQ0YDQtdC90LTQsCIsItCX0LDRgNC/0LvQsNGC0LAiLCLQoNC10LrQu9Cw0LzQsCIsItCj0L/QsNC60L7QstC60LAiLCLQmtGD0YDRjNC10YAiLCLQpdC+0LfRgNCw0YHRhdC+0LTRiyIsItCa0L7QvNC40YHRgdC40Y8iLCLQntCx0L7RgNGD0LTQvtCy0LDQvdC40LUiLCLQn9GA0L7Rh9C10LUiXTsKCiAgcmV0dXJuIDxkaXY+CiAgICB7Lyog0JHRi9GB0YLRgNC+0LUg0LTQvtCx0LDQstC70LXQvdC40LUg0YDQsNGB0YXQvtC00LAgKi99CiAgICA8ZGl2IHN0eWxlPXt7bWFyZ2luQm90dG9tOiIxNnB4In19PgogICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpPT5zZXRTaG93QWRkRXhwZW5zZSh2PT4hdil9CiAgICAgICAgc3R5bGU9e3twYWRkaW5nOiIxMHB4IDE2cHgiLGJvcmRlclJhZGl1czoiOHB4Iixib3JkZXI6IjEuNXB4IHNvbGlkICNjNjI4MjgiLAogICAgICAgICAgYmFja2dyb3VuZDpzaG93QWRkRXhwZW5zZT8iI2M2MjgyOCI6InRyYW5zcGFyZW50Iixjb2xvcjpzaG93QWRkRXhwZW5zZT8iI2ZmZiI6IiNjNjI4MjgiLAogICAgICAgICAgZm9udFNpemU6IjEzcHgiLGZvbnRXZWlnaHQ6IjcwMCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0IixtYXJnaW5Cb3R0b206IjEwcHgifX0+CiAgICAgICAge3Nob3dBZGRFeHBlbnNlPyLinJUg0JfQsNC60YDRi9GC0YwiOiLinpUg0JTQvtCx0LDQstC40YLRjCDRgNCw0YHRhdC+0LQifQogICAgICA8L2J1dHRvbj4KICAgICAge3Nob3dBZGRFeHBlbnNlJiY8ZGl2IHN0eWxlPXt7YmFja2dyb3VuZDoicmdiYSgxOTgsNDAsNDAsMC4wNCkiLGJvcmRlcjoiMXB4IHNvbGlkIHJnYmEoMTk4LDQwLDQwLDAuMikiLGJvcmRlclJhZGl1czoiMTJweCIscGFkZGluZzoiMTZweCJ9fT4KICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZ3JpZCIsZ3JpZFRlbXBsYXRlQ29sdW1uczoiMWZyIDFmciIsZ2FwOiIxMHB4IixtYXJnaW5Cb3R0b206IjEwcHgifX0+CiAgICAgICAgICA8ZGl2PgogICAgICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QlNCw0YLQsDwvbGFiZWw+CiAgICAgICAgICAgIDxpbnB1dCB0eXBlPSJkYXRlIiBzdHlsZT17ey4uLkZTLGZvbnRTaXplOiIxM3B4IixwYWRkaW5nOiI4cHggMTBweCJ9fQogICAgICAgICAgICAgIHZhbHVlPXtleHBlbnNlRm9ybS5kYXRlfSBvbkNoYW5nZT17ZT0+c2V0RXhwZW5zZUZvcm0ocD0+KHsuLi5wLGRhdGU6ZS50YXJnZXQudmFsdWV9KSl9Lz4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdj4KICAgICAgICAgICAgPGxhYmVsIHN0eWxlPXtMU30+0KHRg9C80LzQsDwvbGFiZWw+CiAgICAgICAgICAgIDxpbnB1dCBzdHlsZT17ey4uLkZTLGZvbnRTaXplOiIxM3B4IixwYWRkaW5nOiI4cHggMTBweCIsdGV4dEFsaWduOiJyaWdodCJ9fSBpbnB1dE1vZGU9Im51bWVyaWMiCiAgICAgICAgICAgICAgcGxhY2Vob2xkZXI9IjAg4oK4IiB2YWx1ZT17ZXhwZW5zZUZvcm0uc3VtfSBvbkNoYW5nZT17ZT0+c2V0RXhwZW5zZUZvcm0ocD0+KHsuLi5wLHN1bTplLnRhcmdldC52YWx1ZS5yZXBsYWNlKC9bXjAtOV0vZywiIil9KSl9Lz4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjEwcHgifX0+CiAgICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QmtCw0YLQtdCz0L7RgNC40Y88L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBzdHlsZT17ey4uLkZTLGZvbnRTaXplOiIxM3B4IixwYWRkaW5nOiI4cHggMTBweCJ9fQogICAgICAgICAgICB2YWx1ZT17ZXhwZW5zZUZvcm0uY2F0ZWdvcnl9IG9uQ2hhbmdlPXtlPT5zZXRFeHBlbnNlRm9ybShwPT4oey4uLnAsY2F0ZWdvcnk6ZS50YXJnZXQudmFsdWV9KSl9PgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPtCS0YvQsdC10YDQuCDQutCw0YLQtdCz0L7RgNC40Y48L29wdGlvbj4KICAgICAgICAgICAge2V4cGVuc2VDYXRlZ29yaWVzLm1hcChjPT48b3B0aW9uIGtleT17Y30+e2N9PC9vcHRpb24+KX0KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9e3ttYXJnaW5Cb3R0b206IjEycHgifX0+CiAgICAgICAgICA8bGFiZWwgc3R5bGU9e0xTfT7QntC/0LjRgdCw0L3QuNC1PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBzdHlsZT17ey4uLkZTLGZvbnRTaXplOiIxM3B4IixwYWRkaW5nOiI4cHggMTBweCJ9fQogICAgICAgICAgICBwbGFjZWhvbGRlcj0i0KfRgtC+INC40LzQtdC90L3QviDQvtC/0LvQsNGH0LXQvdC+PyIKICAgICAgICAgICAgdmFsdWU9e2V4cGVuc2VGb3JtLmRlc2NyaXB0aW9ufSBvbkNoYW5nZT17ZT0+c2V0RXhwZW5zZUZvcm0ocD0+KHsuLi5wLGRlc2NyaXB0aW9uOmUudGFyZ2V0LnZhbHVlfSkpfS8+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtoYW5kbGVBZGRFeHBlbnNlfSBkaXNhYmxlZD17YWRkaW5nRXhwZW5zZX0KICAgICAgICAgIHN0eWxlPXt7Li4uQlROLGJhY2tncm91bmQ6IiNjNjI4MjgiLG9wYWNpdHk6YWRkaW5nRXhwZW5zZT8wLjU6MX19PgogICAgICAgICAge2FkZGluZ0V4cGVuc2U/ItCh0L7RhdGA0LDQvdC10L3QuNC1Li4uIjoiXHVEODNEXHVEQ0JFINCh0L7RhdGA0LDQvdC40YLRjCDRgNCw0YHRhdC+0LQifQogICAgICAgIDwvYnV0dG9uPgogICAgICA8L2Rpdj59CiAgICA8L2Rpdj4KCiAgICB7Lyog0JLRi9Cx0L7RgCDRgtCw0LHQu9C40YbRiyAqL30KICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixnYXA6IjhweCIsZmxleFdyYXA6IndyYXAiLG1hcmdpbkJvdHRvbToiMTJweCJ9fT4KICAgICAge3RhYmxlcy5tYXAodD0+PGJ1dHRvbiBrZXk9e3QuaWR9IG9uQ2xpY2s9eygpPT57c2V0VGFibGUodC5pZCk7c2V0Um93cyhbXSk7c2V0RWRpdFJvdyhudWxsKTt9fQogICAgICAgIHN0eWxlPXt7cGFkZGluZzoiOHB4IDE0cHgiLGJvcmRlclJhZGl1czoiOHB4Iixib3JkZXI6IjEuNXB4IHNvbGlkICIrKHRhYmxlPT09dC5pZD8iIzFhMWExYSI6InJnYmEoMCwwLDAsMC4xNSkiKSwKICAgICAgICAgIGJhY2tncm91bmQ6dGFibGU9PT10LmlkPyIjMWExYTFhIjoidHJhbnNwYXJlbnQiLGNvbG9yOnRhYmxlPT09dC5pZD8iI0ZGRkZGMCI6IiMxYTFhMWEiLAogICAgICAgICAgZm9udFNpemU6IjEycHgiLGZvbnRXZWlnaHQ6IjcwMCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0In19PgogICAgICAgIHt0LmxhYmVsfQogICAgICA8L2J1dHRvbj4pfQogICAgPC9kaXY+CgogICAgey8qINCk0LjQu9GM0YLRgCDQv9C+INC80LXRgdGP0YbRgyAqL30KICAgIDxkaXYgc3R5bGU9e3tkaXNwbGF5OiJmbGV4IixnYXA6IjhweCIsYWxpZ25JdGVtczoiY2VudGVyIixtYXJnaW5Cb3R0b206IjEycHgiLGZsZXhXcmFwOiJ3cmFwIn19PgogICAgICA8c2VsZWN0IHN0eWxlPXt7Li4uRlMsd2lkdGg6ImF1dG8iLHBhZGRpbmc6IjhweCAxMnB4Iixmb250U2l6ZToiMTNweCJ9fQogICAgICAgIHZhbHVlPXtmaWx0ZXJNb250aH0gb25DaGFuZ2U9e2U9PnNldEZpbHRlck1vbnRoKE51bWJlcihlLnRhcmdldC52YWx1ZSkpfT4KICAgICAgICB7WzEsMiwzLDQsNSw2LDcsOCw5LDEwLDExLDEyXS5tYXAobT0+PG9wdGlvbiBrZXk9e219IHZhbHVlPXttfT57bW9udGhOYW1lc1ttXX08L29wdGlvbj4pfQogICAgICA8L3NlbGVjdD4KICAgICAgPHNlbGVjdCBzdHlsZT17ey4uLkZTLHdpZHRoOiJhdXRvIixwYWRkaW5nOiI4cHggMTJweCIsZm9udFNpemU6IjEzcHgifX0KICAgICAgICB2YWx1ZT17ZmlsdGVyWWVhcn0gb25DaGFuZ2U9e2U9PnNldEZpbHRlclllYXIoTnVtYmVyKGUudGFyZ2V0LnZhbHVlKSl9PgogICAgICAgIHtbMjAyNSwyMDI2LDIwMjddLm1hcCh5PT48b3B0aW9uIGtleT17eX0+e3l9PC9vcHRpb24+KX0KICAgICAgPC9zZWxlY3Q+CiAgICAgIDxidXR0b24gb25DbGljaz17bG9hZFJvd3N9IGRpc2FibGVkPXtsb2FkaW5nfQogICAgICAgIHN0eWxlPXt7cGFkZGluZzoiOHB4IDE2cHgiLGJvcmRlclJhZGl1czoiOHB4Iixib3JkZXI6IjEuNXB4IHNvbGlkICMxYTFhMWEiLAogICAgICAgICAgYmFja2dyb3VuZDoiIzFhMWExYSIsY29sb3I6IiNGRkZGRjAiLGZvbnRTaXplOiIxM3B4Iixmb250V2VpZ2h0OiI3MDAiLAogICAgICAgICAgY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0IixvcGFjaXR5OmxvYWRpbmc/MC41OjF9fT4KICAgICAgICB7bG9hZGluZz8i4o+zIjoiXHVEODNEXHVERDA0In0ge2xvYWRpbmc/ItCX0LDQs9GA0YPQt9C60LAuLi4iOiLQl9Cw0LPRgNGD0LfQuNGC0YwifQogICAgICA8L2J1dHRvbj4KICAgICAge3Jvd3MubGVuZ3RoPjAmJjxzcGFuIHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjODg4In19Pntyb3dzLmxlbmd0aH0g0LfQsNC/0LjRgdC10Lk8L3NwYW4+fQogICAgPC9kaXY+CgogICAge21zZyYmPGRpdiBzdHlsZT17e3BhZGRpbmc6IjEwcHggMTRweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJhY2tncm91bmQ6InJnYmEoNzQsMjIyLDEyOCwwLjEpIiwKICAgICAgYm9yZGVyOiIxcHggc29saWQgcmdiYSg3NCwyMjIsMTI4LDAuMykiLG1hcmdpbkJvdHRvbToiMTRweCIsZm9udFNpemU6IjEzcHgiLGZvbnRXZWlnaHQ6IjYwMCJ9fT4KICAgICAge21zZ30KICAgIDwvZGl2Pn0KCiAgICB7Lyog0KHQv9C40YHQvtC6INC30LDQv9C40YHQtdC5ICovfQogICAge3Jvd3MubWFwKChyb3csaSk9PnsKICAgICAgY29uc3QgaXNFZGl0PWVkaXRSb3c9PT1yb3cuaWQ7CiAgICAgIGNvbnN0IGtleXM9T2JqZWN0LmtleXMocm93KS5maWx0ZXIoaz0+ayE9PSJpZCImJmshPT0iY3JlYXRlZF9hdCImJmshPT0idXBkYXRlZF9hdCIpOwoKICAgICAgcmV0dXJuIDxkaXYga2V5PXtpfSBzdHlsZT17e2JvcmRlcjoiMXB4IHNvbGlkIHJnYmEoMCwwLDAsMC4xKSIsYm9yZGVyUmFkaXVzOiIxMHB4IiwKICAgICAgICBwYWRkaW5nOiIxNHB4IixtYXJnaW5Cb3R0b206IjEwcHgiLGJhY2tncm91bmQ6aXNFZGl0PyJyZ2JhKDI1NSwyNDgsMjIwLDAuNikiOiIjZmZmIn19PgoKICAgICAgICB7Lyog0KjQsNC/0LrQsCAqL30KICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsanVzdGlmeUNvbnRlbnQ6InNwYWNlLWJldHdlZW4iLGFsaWduSXRlbXM6ImNlbnRlciIsbWFyZ2luQm90dG9tOiIxMHB4In19PgogICAgICAgICAgPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGFsaWduSXRlbXM6ImNlbnRlciIsZ2FwOiIxMHB4IixmbGV4V3JhcDoid3JhcCJ9fT4KICAgICAgICAgICAgey8qINCU0LDRgtCwICovfQogICAgICAgICAgICB7cm93LnNhbGVfZGF0ZSYmPHNwYW4gc3R5bGU9e3tiYWNrZ3JvdW5kOiIjMWExYTFhIixjb2xvcjoiI0ZGRkZGMCIsYm9yZGVyUmFkaXVzOiI2cHgiLHBhZGRpbmc6IjJweCA4cHgiLGZvbnRTaXplOiIxMnB4Iixmb250V2VpZ2h0OiI3MDAiLHdoaXRlU3BhY2U6Im5vd3JhcCJ9fT57cm93LnNhbGVfZGF0ZS5zbGljZSg4LDEwKX0ue3Jvdy5zYWxlX2RhdGUuc2xpY2UoNSw3KX0ue3Jvdy5zYWxlX2RhdGUuc2xpY2UoMCw0KX08L3NwYW4+fQogICAgICAgICAgICB7cm93LnByZXBfZGF0ZSYmPHNwYW4gc3R5bGU9e3tiYWNrZ3JvdW5kOiIjZTZhODE3Iixjb2xvcjoiI2ZmZiIsYm9yZGVyUmFkaXVzOiI2cHgiLHBhZGRpbmc6IjJweCA4cHgiLGZvbnRTaXplOiIxMnB4Iixmb250V2VpZ2h0OiI3MDAiLHdoaXRlU3BhY2U6Im5vd3JhcCJ9fT57cm93LnByZXBfZGF0ZS5zbGljZSg4LDEwKX0ue3Jvdy5wcmVwX2RhdGUuc2xpY2UoNSw3KX0ue3Jvdy5wcmVwX2RhdGUuc2xpY2UoMCw0KX08L3NwYW4+fQogICAgICAgICAgICB7cm93LmRhdGUmJjxzcGFuIHN0eWxlPXt7YmFja2dyb3VuZDoiIzU1NSIsY29sb3I6IiNmZmYiLGJvcmRlclJhZGl1czoiNnB4IixwYWRkaW5nOiIycHggOHB4Iixmb250U2l6ZToiMTJweCIsZm9udFdlaWdodDoiNzAwIix3aGl0ZVNwYWNlOiJub3dyYXAifX0+e1N0cmluZyhyb3cuZGF0ZSkuc2xpY2UoOCwxMCl9LntTdHJpbmcocm93LmRhdGUpLnNsaWNlKDUsNyl9LntTdHJpbmcocm93LmRhdGUpLnNsaWNlKDAsNCl9PC9zcGFuPn0KICAgICAgICAgICAge3Jvdy5leHBlbnNlX2RhdGUmJjxzcGFuIHN0eWxlPXt7YmFja2dyb3VuZDoiIzU1NSIsY29sb3I6IiNmZmYiLGJvcmRlclJhZGl1czoiNnB4IixwYWRkaW5nOiIycHggOHB4Iixmb250U2l6ZToiMTJweCIsZm9udFdlaWdodDoiNzAwIix3aGl0ZVNwYWNlOiJub3dyYXAifX0+e1N0cmluZyhyb3cuZXhwZW5zZV9kYXRlKS5zbGljZSg4LDEwKX0ue1N0cmluZyhyb3cuZXhwZW5zZV9kYXRlKS5zbGljZSg1LDcpfS57U3RyaW5nKHJvdy5leHBlbnNlX2RhdGUpLnNsaWNlKDAsNCl9PC9zcGFuPn0KICAgICAgICAgICAgey8qINCf0YDQvtC00LDQstC10YYgKi99CiAgICAgICAgICAgIHsocm93LnNlbGxlcjF8fHJvdy5zZWxsZXIpJiY8c3BhbiBzdHlsZT17e2ZvbnRTaXplOiIxMnB4Iixjb2xvcjoiIzU1NSJ9fT7wn5GkIHtyb3cuc2VsbGVyMXx8cm93LnNlbGxlcn17cm93LnNlbGxlcjI/IiArICIrcm93LnNlbGxlcjI6IiJ9PC9zcGFuPn0KICAgICAgICAgICAge3Jvdy5jbGllbnRfbmFtZSYmPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTNweCIsZm9udFdlaWdodDoiNjAwIn19PvCfkaQge3Jvdy5jbGllbnRfbmFtZX08L3NwYW4+fQogICAgICAgICAgICB7Lyog0JrQsNGC0LXQs9C+0YDQuNGPL9C+0L/QuNGB0LDQvdC40LUg0YDQsNGB0YXQvtC00LAgKi99CiAgICAgICAgICAgIHtyb3cuY2F0ZWdvcnkmJjxzcGFuIHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGJhY2tncm91bmQ6InJnYmEoMCwwLDAsMC4wNikiLGJvcmRlclJhZGl1czoiNHB4IixwYWRkaW5nOiIycHggNnB4In19Pntyb3cuY2F0ZWdvcnl9PC9zcGFuPn0KICAgICAgICAgICAge3Jvdy5kZXNjcmlwdGlvbiYmPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTJweCIsY29sb3I6IiM1NTUifX0+e3Jvdy5kZXNjcmlwdGlvbn08L3NwYW4+fQogICAgICAgICAgICB7cm93Lml0ZW0mJjxzcGFuIHN0eWxlPXt7Zm9udFNpemU6IjEycHgiLGNvbG9yOiIjNTU1In19PvCfkZcge3Jvdy5pdGVtfTwvc3Bhbj59CiAgICAgICAgICAgIHsvKiDQodGD0LzQvNCwICovfQogICAgICAgICAgICB7cm93LnJldmVudWU+MCYmPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTVweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjoiIzJFNkI1RSIsbWFyZ2luTGVmdDoiYXV0byJ9fT57Zm10KHJvdy5yZXZlbnVlKX0g4oK4PC9zcGFuPn0KICAgICAgICAgICAge3Jvdy5hbW91bnQ+MCYmPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTVweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjoiIzJFNkI1RSIsbWFyZ2luTGVmdDoiYXV0byJ9fT57Zm10KHJvdy5hbW91bnQpfSDigrg8L3NwYW4+fQogICAgICAgICAgICB7cm93LmFtb3VudD4wJiYhcm93LnJldmVudWUmJiFyb3cuYmFsYW5jZSYmPHNwYW4gc3R5bGU9e3tmb250U2l6ZToiMTVweCIsZm9udFdlaWdodDoiNzAwIixjb2xvcjoiI2M2MjgyOCIsbWFyZ2luTGVmdDoiYXV0byJ9fT57Zm10KHJvdy5hbW91bnQpfSDigrg8L3NwYW4+fQogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IHN0eWxlPXt7ZGlzcGxheToiZmxleCIsZ2FwOiI2cHgifX0+CiAgICAgICAgICAgIHshaXNFZGl0JiY8YnV0dG9uIG9uQ2xpY2s9eygpPT5zdGFydEVkaXQocm93KX0KICAgICAgICAgICAgICBzdHlsZT17e3BhZGRpbmc6IjVweCAxMnB4Iixib3JkZXJSYWRpdXM6IjZweCIsYm9yZGVyOiIxcHggc29saWQgIzFhMWExYSIsCiAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiJ0cmFuc3BhcmVudCIsZm9udFNpemU6IjExcHgiLGZvbnRXZWlnaHQ6IjcwMCIsY3Vyc29yOiJwb2ludGVyIixmb250RmFtaWx5OiJpbmhlcml0In19PgogICAgICAgICAgICAgIOKcj++4jyDQmNC30LzQtdC90LjRgtGMCiAgICAgICAgICAgIDwvYnV0dG9uPn0KICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKT0+ZGVsZXRlUm93KHJvdy5pZCl9CiAgICAgICAgICAgICAgc3R5bGU9e3twYWRkaW5nOiI1cHggMTJweCIsYm9yZGVyUmFkaXVzOiI2cHgiLGJvcmRlcjoiMXB4IHNvbGlkIHJnYmEoMjIwLDUwLDUwLDAuNCkiLAogICAgICAgICAgICAgICAgYmFja2dyb3VuZDoicmdiYSgyMjAsNTAsNTAsMC4wNikiLGNvbG9yOiIjYzYyODI4Iixmb250U2l6ZToiMTFweCIsZm9udFdlaWdodDoiNzAwIixjdXJzb3I6InBvaW50ZXIiLGZvbnRGYW1pbHk6ImluaGVyaXQifX0+CiAgICAgICAgICAgICAg8J+XkSDQo9C00LDQu9C40YLRjAogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgoKICAgICAgICB7Lyog0KDQtdC00LDQutGC0LjRgNC+0LLQsNC90LjQtSAqL30KICAgICAgICB7aXNFZGl0JiY8ZGl2PgogICAgICAgICAgPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImdyaWQiLGdyaWRUZW1wbGF0ZUNvbHVtbnM6IjFmciAxZnIiLGdhcDoiOHB4IixtYXJnaW5Cb3R0b206IjEwcHgifX0+CiAgICAgICAgICAgIHtrZXlzLm1hcChrPT57CiAgICAgICAgICAgICAgLy8g0KHQv9C10YbQuNCw0LvRjNC90YvQuSDQv9C10YDQtdC60LvRjtGH0LDRgtC10LvRjCDQtNC70Y8g0L/QvtC70Y8gc3RhdHVzCiAgICAgICAgICAgICAgaWYoaz09PSJzdGF0dXMiKXsKICAgICAgICAgICAgICAgIGNvbnN0IHN0YXR1c2VzPVsiXHVEODNEXHVERkUxINCe0YLQutGA0YvRgtCwIiwiXHVEODNEXHVERkUyINCS0YvQtNCw0L0iLCJcdUQ4M0RcdURGRTIg0JfQsNC60YDRi9GC0LAiLCJcdUQ4M0RcdUREMzQg0J7RgtC80LXQvdC10L3QsCJdOwogICAgICAgICAgICAgICAgcmV0dXJuIDxkaXYga2V5PXtrfSBzdHlsZT17e2dyaWRDb2x1bW46IjEgLyAtMSJ9fT4KICAgICAgICAgICAgICAgICAgPGxhYmVsIHN0eWxlPXt7Li4uTFMsbWFyZ2luQm90dG9tOiI2cHgifX0+0KHRgtCw0YLRg9GBINC/0YDQtdC00L7Qv9C70LDRgtGLPC9sYWJlbD4KICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImZsZXgiLGdhcDoiNnB4IixmbGV4V3JhcDoid3JhcCJ9fT4KICAgICAgICAgICAgICAgICAgICB7c3RhdHVzZXMubWFwKHM9PjxidXR0b24ga2V5PXtzfSBvbkNsaWNrPXsoKT0+c2V0RWRpdERhdGEocD0+KHsuLi5wLHN0YXR1czpzfSkpfQogICAgICAgICAgICAgICAgICAgICAgc3R5bGU9e3twYWRkaW5nOiI3cHggMTJweCIsYm9yZGVyUmFkaXVzOiI4cHgiLGJvcmRlcjoiMS41cHggc29saWQgIisoZWRpdERhdGEuc3RhdHVzPT09cz8iIzFhMWExYSI6InJnYmEoMCwwLDAsMC4xNSkiKSwKICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDplZGl0RGF0YS5zdGF0dXM9PT1zPyIjMWExYTFhIjoidHJhbnNwYXJlbnQiLAogICAgICAgICAgICAgICAgICAgICAgICBjb2xvcjplZGl0RGF0YS5zdGF0dXM9PT1zPyIjRkZGRkYwIjoiIzFhMWExYSIsCiAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiIxMnB4Iixmb250V2VpZ2h0OiI1MDAiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCJ9fT4KICAgICAgICAgICAgICAgICAgICAgIHtzfQogICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPil9CiAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgPC9kaXY+OwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgICByZXR1cm4gPGRpdiBrZXk9e2t9PgogICAgICAgICAgICAgICAgPGxhYmVsIHN0eWxlPXt7Li4uTFMsbWFyZ2luQm90dG9tOiIzcHgifX0+e2t9PC9sYWJlbD4KICAgICAgICAgICAgICAgIDxpbnB1dCBzdHlsZT17ey4uLkZTLHBhZGRpbmc6IjhweCAxMHB4Iixmb250U2l6ZToiMTNweCJ9fQogICAgICAgICAgICAgICAgICB2YWx1ZT17ZWRpdERhdGFba118fCIifQogICAgICAgICAgICAgICAgICBvbkNoYW5nZT17ZT0+c2V0RWRpdERhdGEocD0+KHsuLi5wLFtrXTplLnRhcmdldC52YWx1ZX0pKX0KICAgICAgICAgICAgICAgIC8+CiAgICAgICAgICAgICAgPC9kaXY+OwogICAgICAgICAgICB9KX0KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBzdHlsZT17e2Rpc3BsYXk6ImdyaWQiLGdyaWRUZW1wbGF0ZUNvbHVtbnM6IjFmciAxZnIiLGdhcDoiOHB4In19PgogICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9e3NhdmVFZGl0fSBkaXNhYmxlZD17c2F2aW5nfQogICAgICAgICAgICAgIHN0eWxlPXt7Li4uQlROLG9wYWNpdHk6c2F2aW5nPzAuNToxfX0+CiAgICAgICAgICAgICAge3NhdmluZz8i0KHQvtGF0YDQsNC90LXQvdC40LUuLi4iOiJcdUQ4M0RcdURDQkUg0KHQvtGF0YDQsNC90LjRgtGMIn0KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gb25DbGljaz17KCk9PnNldEVkaXRSb3cobnVsbCl9CiAgICAgICAgICAgICAgc3R5bGU9e3suLi5CVE4sYmFja2dyb3VuZDoidHJhbnNwYXJlbnQiLGJvcmRlcjoiMXB4IHNvbGlkICMxYTFhMWEiLGNvbG9yOiIjMWExYTFhIn19PgogICAgICAgICAgICAgINCe0YLQvNC10L3QsAogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2Pn0KICAgICAgPC9kaXY+OwogICAgfSl9CgogICAge3Jvd3MubGVuZ3RoPT09MCYmIWxvYWRpbmcmJjxkaXYgc3R5bGU9e3t0ZXh0QWxpZ246ImNlbnRlciIscGFkZGluZzoiNDBweCIsY29sb3I6IiM4ODgifX0+CiAgICAgINCd0LDQttC80LggItCX0LDQs9GA0YPQt9C40YLRjCIg0YfRgtC+0LHRiyDRg9Cy0LjQtNC10YLRjCDQt9Cw0L/QuNGB0LgKICAgIDwvZGl2Pn0KICA8L2Rpdj47Cn0KCi8vIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAovLyDQktCl0J7QlAovLyDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKZnVuY3Rpb24gTG9naW5QYWdlKHtvbkxvZ2lufSl7CiAgY29uc3QgW3Bhc3Msc2V0UGFzc109dXNlU3RhdGUoIiIpOwogIGNvbnN0IFtlcnJvcixzZXRFcnJvcl09dXNlU3RhdGUoIiIpOwogIGNvbnN0IGNoZWNrPSgpPT57CiAgICBpZihwYXNzPT09T1dORVJfUEFTUyl7b25Mb2dpbigib3duZXIiKTtyZXR1cm47fQogICAgaWYocGFzcz09PVNFTExFUl9QQVNTKXtvbkxvZ2luKCJzZWxsZXIiKTtyZXR1cm47fQogICAgc2V0RXJyb3IoItCd0LXQstC10YDQvdGL0Lkg0L/QsNGA0L7Qu9GMIik7c2V0VGltZW91dCgoKT0+c2V0RXJyb3IoIiIpLDIwMDApOwogIH07CiAgcmV0dXJuIDxkaXYgc3R5bGU9e3ttYXhXaWR0aDoiMzYwcHgiLG1hcmdpbjoiMCBhdXRvIixwYWRkaW5nOiI2MHB4IDI0cHgiLHRleHRBbGlnbjoiY2VudGVyIn19PgogICAgPGRpdiBzdHlsZT17e2ZvbnRGYW1pbHk6IidDb3Jtb3JhbnQgR2FyYW1vbmQnLHNlcmlmIixmb250U3R5bGU6Iml0YWxpYyIsZm9udFNpemU6IjQwcHgiLGNvbG9yOiIjMWExYTFhIixtYXJnaW5Cb3R0b206IjRweCJ9fT5OQU7DiTwvZGl2PgogICAgPGRpdiBzdHlsZT17e2ZvbnRTaXplOiIxMXB4IixsZXR0ZXJTcGFjaW5nOiIwLjJlbSIsdGV4dFRyYW5zZm9ybToidXBwZXJjYXNlIixjb2xvcjoiIzg4OCIsbWFyZ2luQm90dG9tOiI1MHB4In19PlBBUklTIMK3INCQ0KHQotCQ0J3QkDwvZGl2PgogICAgPGlucHV0IHR5cGU9InBhc3N3b3JkIiBzdHlsZT17ey4uLkZTLHRleHRBbGlnbjoiY2VudGVyIixtYXJnaW5Cb3R0b206IjEycHgiLGxldHRlclNwYWNpbmc6IjAuMDhlbSJ9fQogICAgICBwbGFjZWhvbGRlcj0i0J/QsNGA0L7Qu9GMIiB2YWx1ZT17cGFzc30gb25DaGFuZ2U9e2U9PnNldFBhc3MoZS50YXJnZXQudmFsdWUpfQogICAgICBvbktleURvd249e2U9PmUua2V5PT09IkVudGVyIiYmY2hlY2soKX0KICAgIC8+CiAgICB7ZXJyb3ImJjxkaXYgc3R5bGU9e3tjb2xvcjoiI2ZiNzE3MSIsZm9udFNpemU6IjEycHgiLG1hcmdpbkJvdHRvbToiMTBweCJ9fT57ZXJyb3J9PC9kaXY+fQogICAgPGJ1dHRvbiBvbkNsaWNrPXtjaGVja30gc3R5bGU9e0JUTn0+0JLQvtC50YLQuDwvYnV0dG9uPgogICAgPGRpdiBzdHlsZT17e21hcmdpblRvcDoiMjBweCIsZm9udFNpemU6IjExcHgiLGNvbG9yOiIjYmJiIixsaW5lSGVpZ2h0OiIxLjgifX0+CiAgICAgINCf0YDQvtC00LDQstGG0Ys6INC/0LDRgNC+0LvRjCDQvdCw0L3QtdC60LDRgdGB0LA8YnIvPtCg0YPQutC+0LLQvtC00LjRgtC10LvRjDog0L7RgtC00LXQu9GM0L3Ri9C5INC/0LDRgNC+0LvRjAogICAgPC9kaXY+CiAgPC9kaXY+Owp9CgovLyDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKLy8gUk9PVAovLyDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKZnVuY3Rpb24gQXBwKCl7CiAgY29uc3QgW3JvbGUsc2V0Um9sZV09dXNlU3RhdGUobnVsbCk7IC8vIG51bGwgfCBzZWxsZXIgfCBvd25lcgoKICBpZighcm9sZSlyZXR1cm4gPExvZ2luUGFnZSBvbkxvZ2luPXtzZXRSb2xlfS8+OwoKICByZXR1cm4gPGRpdj4KICAgIHtyb2xlPT09InNlbGxlciImJjxTZWxsZXJQYWdlLz59CiAgICB7cm9sZT09PSJvd25lciImJjxPd25lclBhZ2UvPn0KICAgIDxkaXYgc3R5bGU9e3twb3NpdGlvbjoiZml4ZWQiLGJvdHRvbTowLGxlZnQ6MCxyaWdodDowLHBhZGRpbmc6IjZweCIsdGV4dEFsaWduOiJjZW50ZXIiLGJhY2tncm91bmQ6InJnYmEoMjU1LDI1NSwyNTUsMC45KSIsYmFja2Ryb3BGaWx0ZXI6ImJsdXIoMTBweCkiLGJvcmRlclRvcDoiMXB4IHNvbGlkIHJnYmEoMCwwLDAsMC4wNikifX0+CiAgICAgIDxidXR0b24gb25DbGljaz17KCk9PnNldFJvbGUobnVsbCl9IHN0eWxlPXt7YmFja2dyb3VuZDoibm9uZSIsYm9yZGVyOiJub25lIixmb250U2l6ZToiMTFweCIsY29sb3I6IiNhYWEiLGN1cnNvcjoicG9pbnRlciIsZm9udEZhbWlseToiaW5oZXJpdCJ9fT4KICAgICAgICDQktGL0LnRgtC4ICh7cm9sZT09PSJzZWxsZXIiPyLQn9GA0L7QtNCw0LLQtdGGIjoi0KDRg9C60L7QstC+0LTQuNGC0LXQu9GMIn0pCiAgICAgIDwvYnV0dG9uPgogICAgPC9kaXY+CiAgPC9kaXY+Owp9CgpSZWFjdERPTS5jcmVhdGVSb290KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyb290IikpLnJlbmRlcig8QXBwLz4pOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==';
  const html = Buffer.from(htmlB64, 'base64').toString('utf-8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

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
    const plan = 27000000;
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
  const isOk = Math.abs(diff) < 500;
  const isDanger = !isOk && Math.abs(diff) >= 500;
  const statusBg   = isOk ? '#eaf3de' : '#fcebeb';
  const statusBorder = isOk ? '#c0dd97' : '#F7C1C1';
  const statusDot  = isOk ? '#639922' : '#E24B4A';
  const statusText = isOk ? 'Все каналы сходятся — смена закрыта корректно' : 'РАСХОЖДЕНИЕ — требует внимания';
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
<div class="card"><div class="card-title"><div class="dot" style="background:#378ADD"></div>Kaspi</div><div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rOnline)}</span></div><div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rKaspi)}</span></div><div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tKaspi)}</span></div>${(s.tKaspiRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tKaspiRet)+'</span></div>':''}<div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(kaspiNet)}</span></div></div>
<div class="card"><div class="card-title"><div class="dot" style="background:#7F77DD"></div>Halyk</div><div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rHalykOnline)}</span></div><div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rHalyk)}</span></div><div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tHalyk)}</span></div>${(s.tHalykRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tHalykRet)+'</span></div>':''}<div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(halykNet)}</span></div></div>
<div class="card"><div class="card-title"><div class="dot" style="background:#1D9E75"></div>Прочие</div><div class="row"><span class="row-label">Наличные</span><span class="row-value">${fmt(s.rCash)}</span></div>${(s.rPersonal||0)>0?'<div class="row"><span class="row-label">Личная карта</span><span class="row-value">'+fmt(s.rPersonal)+'</span></div>':''}<div class="row-total"><span>Итого</span><span>${fmt((s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0))}</span></div></div>
</div>
<div class="sec">Касса и сверка</div>
<div class="grid2">
<div class="card"><div class="card-title">💵 Касса</div><div class="row"><span class="row-label">Открытие</span><span class="row-value">${fmt(s.cashOpen)}</span></div><div class="row"><span class="row-label">Закрытие (факт)</span><span class="row-value">${fmt(s.cashActual)}</span></div><div class="row"><span class="row-label">Продажи нал (ROSTA)</span><span class="row-value">${fmt(cashSales)}</span></div>${(s.inkasso||0)>0?'<div class="row"><span class="row-label">Инкассация</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.inkasso)+'</span></div>':''}<div class="row"><span class="row-label">Ожидалось в кассе</span><span class="row-value">${fmt((s.cashOpen||0)+cashSales-(s.inkasso||0))}</span></div>${(s.cashActual||0)>0?'<div class="row"><span class="row-label">Факт в кассе</span><span class="row-value" style="color:'+( Math.abs((s.cashActual||0)-((s.cashOpen||0)+cashSales-(s.inkasso||0)))>500 ? "#E24B4A":"#1D9E75")+'">'+fmt(s.cashActual||0)+'</span></div>':''}<div class="row-total"><span>Итого в кассе</span><span style="color:#1D9E75">${fmt((s.cashOpen||0)+(s.rCash||0))}</span></div></div>
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
    const plan = 27000000;
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
    const plans = {'Асель':8550000,'Зарина':10350000,'Луиза':8100000};
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
    const planTotal = 27000000;
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
