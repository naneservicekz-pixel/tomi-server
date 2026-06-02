// ══════════════════════════════════════════════════════════════════════
// ТОМИ — Telegram AI Управляющий NANE PARIS
// Версия 4.3 — исправлен баг геолокации при открытии смены
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
const lastShiftReports = {}; // userId -> { html, filename, caption }
const pendingResendApprovals = {};
const pendingPrepayDelete = {};
const pendingExpense = {}; // userId -> { amount, description, date } // ownerId -> { sellerId, sellerName, prepayId, reason } // ownerId -> { sellerId, sellerName }

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

// ══════════════════════════════════════════════════════════════════════
// SUPABASE DATA FUNCTIONS — заменяют Google Sheets для основных данных
// ══════════════════════════════════════════════════════════════════════

async function dbSaveSale(date, revenue, seller1, seller2) {
  try {
    const d = typeof date === 'string' ? date : date.split('.').reverse().join('-');
    const m = parseInt(d.split('-')[1]);
    const y = parseInt(d.split('-')[0]);
    const { error } = await supabase.from('daily_sales').upsert({
      sale_date: d, revenue: Number(revenue),
      seller1: seller1 || '', seller2: seller2 || '',
      month: m, year: y
    }, { onConflict: 'sale_date' });
    if (error) console.error('dbSaveSale error:', error.message);
    else console.log('dbSaveSale OK:', d, revenue);
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
    // 'all' — без фильтра
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

// ══════════════════════════════════════════════════════════════════════
// РАСЧЁТ ЗАРПЛАТЫ — система КЕ + KPI
// ══════════════════════════════════════════════════════════════════════

async function saveKPI(sellerName, score, month, year) {
  try {
    await supabase.from('kpi_scores').upsert({
      seller_name: sellerName, score: score, month: month, year: year
    }, { onConflict: 'seller_name,month,year' });
    console.log('KPI saved:', sellerName, score, month, year);
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

    // Параметры
    const KE = 14000; // выход тг/смена
    const TAX_PCT = 0.03; // 3% налог
    const BONUS_PLAN = 30000; // бонус за выполнение личного плана
    const KPI_ONE = 25000; // одна KPI метрика

    // Личные планы июнь
    const personalPlans = { 'Асель': 8550000, 'Зарина': 10350000, 'Луиза': 8100000 };
    // Обновляем планы динамически по месяцу (пока захардкожено июнь)

    // Шкала % (от личных продаж продавца)
    const getPct = (amount) => {
      if (amount >= 1000000) return 0.027;
      if (amount >= 750000)  return 0.022;
      if (amount >= 500000)  return 0.017;
      return 0.012;
    };

    // Получаем KPI за месяц
    const kpiScores = await getKPI(month, year);

    // Считаем по продавцам
    const sellers = ['Асель', 'Зарина', 'Луиза'];
    const data = {};
    sellers.forEach(s => {
      data[s] = { shifts: 0, sales: 0, bonusGoodDay: 0, bonusRecord: 0 };
    });

    let totalRevenue = 0;

    sales.forEach(day => {
      const rev = Number(day.revenue || 0);
      totalRevenue += rev;
      const daySellers = [day.seller1, day.seller2].filter(s => s && sellers.includes(s));
      if (daySellers.length === 0) return;

      // % считается от ОБЩЕГО оборота смены для каждого продавца
      const dayPct = rev * getPct(rev);

      daySellers.forEach(s => {
        data[s].shifts++;
        data[s].sales += rev / daySellers.length; // для статистики продаж
        // Каждый продавец получает % от ПОЛНОГО оборота смены
        data[s].pctSum = (data[s].pctSum || 0) + dayPct;

        // Бонус за хороший день — от ОБЩЕГО оборота дня
        if (rev >= 2000000) {
          data[s].bonusRecord += 40000;
        } else if (rev >= 700000) {
          data[s].bonusGoodDay += 5000;
        }
      });
    });

    // Итоги по каждому продавцу
    const result = {};
    sellers.forEach(s => {
      const d = data[s];
      const ke = d.shifts * KE;
      const pct = Math.round(d.pctSum || 0); // уже посчитан подневно
      const bonusPlan = d.sales >= (personalPlans[s] || 0) ? BONUS_PLAN : 0;
      const kpiScore = kpiScores[s] !== undefined ? kpiScores[s] : 3; // по умолчанию 3/3
      const kpiAmt = kpiScore * KPI_ONE;
      const total = ke + pct + d.bonusGoodDay + d.bonusRecord + bonusPlan + kpiAmt;

      result[s] = {
        shifts: d.shifts,
        sales: Math.round(d.sales),
        ke: ke,
        pct: pct,
        pctRate: 'подневно',
        kpiScore: kpiScore,
        kpiAmt: kpiAmt,
        bonusGoodDay: d.bonusGoodDay,
        bonusRecord: d.bonusRecord,
        bonusPlan: bonusPlan,
        planFact: Math.round(d.sales),
        planTarget: personalPlans[s] || 0,
        planDone: d.sales >= (personalPlans[s] || 0),
        total: Math.round(total)
      };
    });

    const totalFot = sellers.reduce((s, name) => s + result[name].total, 0);
    const tax = Math.round(totalRevenue * TAX_PCT);

    return { sellers: result, totalRevenue, totalFot, tax, month, year };
  } catch(e) {
    console.error('calcSalary error:', e.message);
    return null;
  }
}

async function showSalaryReport(userId, month, year) {
  try {
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const calc = await calcSalary(month, year);

    if (!calc) {
      await sendTelegram(userId, '📊 Нет данных по продажам за ' + (monthNames[month]||month) + ' ' + year);
      return;
    }

    const fmt = n => Math.round(n).toLocaleString('ru-RU');
    const sellers = ['Асель', 'Зарина', 'Луиза'];

    let msg = '💰 РАСЧЁТ ЗАРПЛАТЫ — ' + (monthNames[month]||month) + ' ' + year + '\n';
    msg += '━━━━━━━━━━━━━━━━━━━━\n\n';

    sellers.forEach(name => {
      const s = calc.sellers[name];
      if (!s || s.shifts === 0) return;
      msg += '👤 ' + name + ' · ' + s.shifts + ' смен\n';
      msg += '  Продажи: ' + fmt(s.sales) + ' тг (' + s.pctRate + ')\n';
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
    const result = await supabase.from('open_shifts').upsert({ phone: String(userId), ...shiftData }, { onConflict: 'phone' });
    console.log('saveOpenShift result:', JSON.stringify(result?.error || 'ok'), 'userId:', userId);
  } catch(e) { console.error('saveOpenShift ERROR:', e.message); }
}

async function saveLastReport(userId, html, filename, caption) {
  try {
    await supabase.from('last_reports').upsert({ user_id: String(userId), html, filename, caption }, { onConflict: 'user_id' });
    console.log('Отчёт сохранён в Supabase для', userId);
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

// Читаем остаток кассы из последней закрытой смены (Google Sheets)
async function loadLastCash() {
  try {
    const rows = await readSheet('Смены!A:Y', SPREADSHEET_ID);
    if (!rows || rows.length < 2) return null;
    // Последняя строка с данными (пропускаем заголовок)
    for (let i = rows.length - 1; i >= 1; i--) {
      const cashActual = parseFloat(String(rows[i][15]||'0').replace(/[^0-9.]/g,''));
      if (cashActual > 0) {
        console.log('Последний остаток кассы из Смены:', cashActual, '(строка', i+1, ')');
        return cashActual;
      }
    }
    return null;
  } catch(e) { console.error('loadLastCash error:', e.message); return null; }
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
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/tomi-sheets%40tomi-nane.iam.gserviceaccount.com',
      universe_domain: 'googleapis.com'
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

async function updateSheetCell(range, value, spreadsheetId) {
  try {
    const { api, id } = getSheets(spreadsheetId || SPREADSHEET_ID);
    await api.spreadsheets.values.update({ spreadsheetId: id, range, valueInputOption: 'USER_ENTERED', resource: { values: [[value]] } });
    return true;
  } catch(e) { return false; }
}

// ── Запись в "Учёт по дням" дашборда ─────────────────────────────────
async function writeToUchetPoDnyam(date, rostaTotal, seller1, seller2) {
  if (!DASHBOARD_ID) return false;
  try {
    const rows = await readSheet("Учёт по дням!A6:E200", DASHBOARD_ID);
    if (!rows) return false;

    // Ищем строку с нужной датой — сравниваем только день.месяц (без года)
    const dateShort = date.split('.').slice(0,2).join('.'); // "29.05" из "29.05.2026"
    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const cellDate = String(rows[i][1]||'').trim();
      const cellDateShort = cellDate.split('.').slice(0,2).join('.');
      if (cellDateShort === dateShort) { targetRow = 6 + i; break; }
    }

    // Если не нашли по дате — пишем в первую пустую строку по колонке C
    if (targetRow < 0) {
      for (let i = 0; i < rows.length; i++) {
        const cellC = String(rows[i][2]||'').trim();
        if (!cellC || cellC === '0') { targetRow = 6 + i; break; }
      }
    }

    // Если совсем не нашли — добавляем после последней строки
    if (targetRow < 0) targetRow = 6 + rows.filter(r => r[0] || r[1]).length;

    const { api } = getSheets(DASHBOARD_ID);
    await api.spreadsheets.values.update({
      spreadsheetId: DASHBOARD_ID,
      range: "Учёт по дням!C" + targetRow + ":E" + targetRow,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[rostaTotal, seller1 || '', seller2 || '']] }
    });
    console.log('Записано в Учёт по дням строка', targetRow, 'дата', date, 'оборот', rostaTotal);
    return true;
  } catch(e) { console.error('writeToUchetPoDnyam error:', e.message); return false; }
}

// ══════════════════════════════════════════════════════════════════════
// ДАШБОРД — версия 4.0
// Читает:
//   Дашборд!A1:H25  — оборот (строки 19,20,22), план (строка 6)
//   Итоги месяца!A1:H18 — ФОТ с разбивкой (строки 14,15,16)
// ══════════════════════════════════════════════════════════════════════
async function generateDashboardHTML() {
  try {
    const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const curMonth = nowAlm.getMonth() + 1;
    const curYear  = nowAlm.getFullYear();
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

    // Читаем продажи из Supabase
    const salesData = await dbGetSales(curMonth, curYear);

    // Считаем по продавцам
    const sellerSales = { 'Асель': 0, 'Зарина': 0, 'Луиза': 0 };
    let totalFact = 0;
    salesData.forEach(s => {
      const rev = Number(s.revenue || 0);
      totalFact += rev;
      // Делим оборот поровну между двумя продавцами
      const sellers = [s.seller1, s.seller2].filter(Boolean);
      if (sellers.length > 0) {
        const share = rev / sellers.length;
        sellers.forEach(name => { if (sellerSales[name] !== undefined) sellerSales[name] += share; });
      }
    });

    // Планы из Настройки (или дефолт пропорционально сменам)
    const plan = 27000000;
    // Июнь: Асель 19 смен, Зарина 23, Луиза 18 из 60 итого
    const totalShifts = 60;
    const shiftsMap = { 'Асель': 19, 'Зарина': 23, 'Луиза': 18 };
    const planMap = {};
    let planCheck = 0;
    Object.entries(shiftsMap).forEach(([name, shifts]) => {
      planMap[name] = Math.round(plan * shifts / totalShifts);
      planCheck += planMap[name];
    });
    // Корректируем округление
    planMap['Луиза'] += plan - planCheck;

    const aselFact   = Math.round(sellerSales['Асель']);
    const zarinaFact = Math.round(sellerSales['Зарина']);
    const luizaFact  = Math.round(sellerSales['Луиза']);
    const aselPlan   = planMap['Асель'];
    const zarinaPlan = planMap['Зарина'];
    const luizaPlan  = planMap['Луиза'];
    const aselLeft   = Math.max(0, aselPlan - aselFact);
    const zarinaLeft = Math.max(0, zarinaPlan - zarinaFact);
    const luizaLeft  = Math.max(0, luizaPlan - luizaFact);
    const aselPct    = aselPlan > 0 ? Math.round(aselFact / aselPlan * 100) : 0;
    const zarinaPct  = zarinaPlan > 0 ? Math.round(zarinaFact / zarinaPlan * 100) : 0;
    const luizaPct   = luizaPlan > 0 ? Math.round(luizaFact / luizaPlan * 100) : 0;
    const totalPct   = plan > 0 ? Math.round(totalFact / plan * 100) : 0;
    const totalLeft  = Math.max(0, plan - totalFact);

    // Расчёт зарплаты из Supabase
    const salaryCalc = await calcSalary(curMonth, curYear);
    const sc = salaryCalc ? salaryCalc.sellers : {};

    const aselFix     = sc['Асель'] ? sc['Асель'].ke : 0;
    const aselProcent = sc['Асель'] ? sc['Асель'].pct : 0;
    const aselBonus   = sc['Асель'] ? sc['Асель'].bonusGoodDay : 0;
    const aselRekord  = sc['Асель'] ? sc['Асель'].bonusRecord : 0;
    const aselPlanB   = sc['Асель'] ? sc['Асель'].bonusPlan : 0;
    const aselTotal   = sc['Асель'] ? sc['Асель'].total : 0;

    const zarinaFix     = sc['Зарина'] ? sc['Зарина'].ke : 0;
    const zarinaProcent = sc['Зарина'] ? sc['Зарина'].pct : 0;
    const zarinaBonus   = sc['Зарина'] ? sc['Зарина'].bonusGoodDay : 0;
    const zarinaRekord  = sc['Зарина'] ? sc['Зарина'].bonusRecord : 0;
    const zarinaPlanB   = sc['Зарина'] ? sc['Зарина'].bonusPlan : 0;
    const zarinaTotal   = sc['Зарина'] ? sc['Зарина'].total : 0;

    const luizaFix     = sc['Луиза'] ? sc['Луиза'].ke : 0;
    const luizaProcent = sc['Луиза'] ? sc['Луиза'].pct : 0;
    const luizaBonus   = sc['Луиза'] ? sc['Луиза'].bonusGoodDay : 0;
    const luizaRekord  = sc['Луиза'] ? sc['Луиза'].bonusRecord : 0;
    const luizaPlanB   = sc['Луиза'] ? sc['Луиза'].bonusPlan : 0;
    const luizaTotal   = sc['Луиза'] ? sc['Луиза'].total : 0;

    const totalFot = salaryCalc ? salaryCalc.totalFot : 0;

    const dash = []; const itogi = []; // не используются — данные из Supabase

    // ── Форматирование ────────────────────────────────────────────
    const fmt = n => Math.round(Number(n||0)).toLocaleString('ru-RU');
    const pctColor = p => p >= 100 ? '#1a8a5a' : p >= 80 ? '#b06a10' : '#c0392b';
    const barColor = p => p >= 100 ? '#27ae60' : p >= 80 ? '#e67e22' : '#e74c3c';
    const barW = p => Math.min(p, 100);
    const now = getNow();

    const sellers = [
      { name: 'Асель',  emoji: '💙', fact: aselFact,   plan: aselPlan,   pct: aselPct,   left: aselLeft,
        fix: aselFix,   procent: aselProcent, bonus: aselBonus, rekord: aselRekord, planB: aselPlanB, total: aselTotal },
      { name: 'Зарина', emoji: '💙', fact: zarinaFact, plan: zarinaPlan, pct: zarinaPct, left: zarinaLeft,
        fix: zarinaFix, procent: zarinaProcent, bonus: zarinaBonus, rekord: zarinaRekord, planB: zarinaPlanB, total: zarinaTotal },
      { name: 'Луиза',  emoji: '💚', fact: luizaFact,  plan: luizaPlan,  pct: luizaPct,  left: luizaLeft,
        fix: luizaFix,  procent: luizaProcent, bonus: luizaBonus, rekord: luizaRekord, planB: luizaPlanB, total: luizaTotal },
    ];

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NANÉ PARIS — Дашборд</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f0ede8;
  color: #1a1a1a;
  padding: 20px 16px;
}
.container { max-width: 680px; margin: 0 auto; }

/* ШАПКА */
.header { margin-bottom: 22px; }
.brand { font-size: 21px; font-weight: 700; letter-spacing: 0.07em; color: #1a1a1a; }
.brand-sub { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.12em; margin-top: 2px; }
.updated { font-size: 11px; color: #aaa; margin-top: 3px; }

/* СЕКЦИЯ */
.section-title {
  font-size: 10px; color: #999; text-transform: uppercase;
  letter-spacing: 0.12em; margin: 18px 0 8px;
}

/* КАРТОЧКИ */
.grid2 { display: grid; grid-template-columns: repeat(2,1fr); gap: 10px; margin-bottom: 10px; }
.card {
  background: #fff;
  border: 1px solid #e8e4de;
  border-radius: 12px;
  padding: 14px;
}
.card-label { font-size: 11px; color: #999; margin-bottom: 5px; }
.card-value { font-size: 22px; font-weight: 700; color: #1a1a1a; }
.card-sub { font-size: 12px; color: #aaa; margin-top: 4px; }

/* ПРОГРЕСС-БАР */
.bar-wrap { background: #ebe8e2; border-radius: 20px; height: 7px; overflow: hidden; margin: 8px 0 4px; }
.bar-fill { height: 7px; border-radius: 20px; }
.bar-labels { display: flex; justify-content: space-between; font-size: 10px; color: #bbb; }

/* КАРТОЧКА ПРОДАВЦА */
.seller-card {
  background: #fff;
  border: 1px solid #e8e4de;
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 10px;
}
.seller-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.seller-name { font-size: 14px; font-weight: 600; }
.seller-pct { font-size: 19px; font-weight: 700; }
.seller-fact { font-size: 12px; color: #999; margin-bottom: 8px; }
.seller-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.meta-box {
  background: #f7f4ef;
  border-radius: 8px;
  padding: 9px 11px;
}
.meta-label { font-size: 10px; color: #aaa; margin-bottom: 3px; }
.meta-value { font-size: 13px; font-weight: 500; color: #1a1a1a; }

/* ЗАРПЛАТА */
.fot-card {
  background: #fff;
  border: 1px solid #e8e4de;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 10px;
}
.fot-seller-block { border-bottom: 1px solid #f0ece6; padding: 12px 14px; }
.fot-seller-block:last-child { border-bottom: none; }
.fot-seller-name { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.fot-row {
  display: flex; justify-content: space-between;
  font-size: 12px; padding: 3px 0;
  border-bottom: 1px solid #f7f4ef;
}
.fot-row:last-child { border-bottom: none; }
.fot-row-label { color: #aaa; }
.fot-row-value { color: #555; font-weight: 500; }
.fot-total-row {
  display: flex; justify-content: space-between;
  font-size: 13px; font-weight: 700;
  padding: 6px 0 0;
  margin-top: 4px;
  border-top: 1px solid #ebe8e2;
}
.fot-total-value { color: #1a8a5a; }

/* ИТОГО ФОТ */
.fot-summary {
  background: #1a1a1a;
  border-radius: 12px;
  padding: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
}
.fot-summary-label { font-size: 13px; color: #888; }
.fot-summary-value { font-size: 20px; font-weight: 700; color: #fff; }
</style>
</head>
<body>
<div class="container">

  <!-- ШАПКА -->
  <div class="header">
    <div class="brand">NANÉ PARIS</div>
    <div class="brand-sub">Дашборд продаж — ${monthNames[curMonth]} ${curYear}</div>
    <div class="updated">Обновлено: ${now}</div>
  </div>

  <!-- МАГАЗИН ИТОГО -->
  <div class="section-title">Магазин итого</div>
  <div class="grid2">
    <div class="card">
      <div class="card-label">Оборот (факт)</div>
      <div class="card-value">${fmt(totalFact)} ₸</div>
      <div class="card-sub">из ${fmt(plan)} ₸</div>
    </div>
    <div class="card">
      <div class="card-label">Выполнение плана</div>
      <div class="card-value" style="color:${pctColor(totalPct)}">${totalPct}%</div>
      <div class="card-sub">осталось ${fmt(totalLeft > 0 ? totalLeft : 0)} ₸</div>
    </div>
  </div>
  <div class="card" style="margin-bottom:4px;">
    <div class="card-label">Прогресс к плану</div>
    <div class="bar-wrap">
      <div class="bar-fill" style="width:${barW(totalPct)}%; background:${barColor(totalPct)};"></div>
    </div>
    <div class="bar-labels">
      <span>0</span><span>${fmt(plan/2)} ₸</span><span>${fmt(plan)} ₸</span>
    </div>
  </div>

  <!-- ПРОДАВЦЫ -->
  <div class="section-title">Продавцы</div>
  ${sellers.map(s => `
  <div class="seller-card">
    <div class="seller-top">
      <div class="seller-name">${s.emoji} ${s.name}</div>
      <div class="seller-pct" style="color:${pctColor(s.pct)}">${s.pct}%</div>
    </div>
    <div class="seller-fact">${fmt(s.fact)} ₸ из ${fmt(s.plan)} ₸</div>
    <div class="bar-wrap">
      <div class="bar-fill" style="width:${barW(s.pct)}%; background:${barColor(s.pct)};"></div>
    </div>
    <div class="seller-meta">
      <div class="meta-box">
        <div class="meta-label">Осталось до плана</div>
        <div class="meta-value">${fmt(Math.max(0, s.left || (s.plan - s.fact)))} ₸</div>
      </div>
      <div class="meta-box">
        <div class="meta-label">К выплате</div>
        <div class="meta-value" style="color:#1a8a5a">${fmt(s.total)} ₸</div>
      </div>
    </div>
  </div>`).join('')}

  <!-- ЗАРПЛАТА -->
  <div class="section-title">Зарплата к выплате</div>
  <div class="fot-card">
    ${sellers.map(s => `
    <div class="fot-seller-block">
      <div class="fot-seller-name">${s.emoji} ${s.name}</div>
      <div class="fot-row"><span class="fot-row-label">Выход (фикс)</span><span class="fot-row-value">${fmt(s.fix)} ₸</span></div>
      <div class="fot-row"><span class="fot-row-label">% от продаж</span><span class="fot-row-value">${fmt(s.procent)} ₸</span></div>
      ${s.bonus > 0 ? `<div class="fot-row"><span class="fot-row-label">Бонус хор. день</span><span class="fot-row-value">${fmt(s.bonus)} ₸</span></div>` : ''}
      ${s.rekord > 0 ? `<div class="fot-row"><span class="fot-row-label">Рекорд ≥2 млн</span><span class="fot-row-value">${fmt(s.rekord)} ₸</span></div>` : ''}
      ${s.planB > 0 ? `<div class="fot-row"><span class="fot-row-label">Бонус план мес.</span><span class="fot-row-value">${fmt(s.planB)} ₸</span></div>` : ''}
      <div class="fot-total-row">
        <span>ИТОГО</span>
        <span class="fot-total-value">${fmt(s.total)} ₸</span>
      </div>
    </div>`).join('')}
  </div>

  <div class="fot-summary">
    <span class="fot-summary-label">Итого ФОТ</span>
    <span class="fot-summary-value">${fmt(totalFot)} ₸</span>
  </div>

</div>
</body>
</html>`;

  } catch(e) {
    console.error('generateDashboardHTML error:', e.message);
    return null;
  }
}

// ── Командный отчёт дня для продавцов ────────────────────────────────
function generateTeamDayHTML({ today, closeTime, rostaTotal, diff, s, kaspiNet, halykNet, channelDiffs, prepayExplanations }) {
  const fmt = n => Number(n||0).toLocaleString('ru-RU') + ' ₸';
  const isOk = channelDiffs.length === 0;
  const statusBg = isOk ? '#eaf3de' : '#fcebeb';
  const statusBorder = isOk ? '#c0dd97' : '#F7C1C1';
  const statusDot = isOk ? '#639922' : '#E24B4A';
  const statusText = isOk ? 'Смена закрыта корректно — все каналы сходятся' : 'Расхождение — руководитель уведомлён';
  const statusColor = isOk ? '#3B6D11' : '#A32D2D';

  const kaspiTotal = (s.rKaspi||0) + (s.rOnline||0);
  const halykTotal = (s.rHalyk||0) + (s.rHalykOnline||0);
  const personalTotal = s.rPersonal || 0;
  const cashTotal = s.rCash || 0;

  // Считаем расхождение по каждому каналу — так же как в отчёте владельца
  const kaspiDiff = kaspiNet - kaspiTotal;
  const halykDiff = halykNet - halykTotal;
  const cashSales = (s.cashActual||0)-(s.cashOpen||0)+(s.cashPayouts||0)+(s.inkasso||0)+(s.rRetCash||0);
  const cashDiff = cashSales - cashTotal;

  const getChannelStatus = (diff) => {
    if (Math.abs(diff) <= 500) return { text: 'Сходится', bg: '#eaf3de', color: '#3B6D11' };
    const sign = diff > 0 ? '+' : '';
    const dir = diff > 0 ? 'излишек' : 'недостача';
    return { text: sign + Number(diff).toLocaleString('ru-RU') + ' ₸ (' + dir + ')', bg: '#fcebeb', color: '#A32D2D' };
  };

  const kaspiStatus = getChannelStatus(kaspiDiff);
  const halykStatus = getChannelStatus(halykDiff);
  const cashStatus = getChannelStatus(cashDiff);

  const channels = [
    { name: 'Kaspi (QR + Онлайн)', amount: kaspiTotal, color: '#378ADD', status: kaspiStatus },
    { name: 'Halyk (QR + Онлайн)', amount: halykTotal, color: '#7F77DD', status: halykStatus },
    { name: 'Наличные', amount: cashTotal, color: '#1D9E75', status: cashStatus },
  ];
  if (personalTotal > 0) channels.push({ name: 'Личная карта Айнур', amount: personalTotal, color: '#BA7517', status: null });
  if ((s.rBonus||0) > 0) channels.push({ name: 'Бонусы', amount: s.rBonus||0, color: '#888', status: null });

  const channelRows = channels.map(ch => `
    <div style="padding:11px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;align-items:center;font-size:13px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${ch.color};flex-shrink:0;"></div>
        <span style="color:#555;">${ch.name}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-weight:500;">${fmt(ch.amount)}</span>
        ${ch.status ? `<span style="font-size:11px;background:${ch.status.bg};color:${ch.status.color};padding:2px 8px;border-radius:20px;">${ch.status.text}</span>` : ''}
      </div>
    </div>`).join('');

  // Блок предоплат если есть
  let teamPrepaySection = '';
  if (prepayExplanations && prepayExplanations.length > 0) {
    teamPrepaySection = `
  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Предоплаты закрыты сегодня</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px;">`;
    prepayExplanations.forEach(pe => {
      pe.prepays.forEach(p => {
        teamPrepaySection += `
    <div style="padding:11px 14px;border-bottom:1px solid #f0ece6;font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#555;">👤 ${p.client}</span>
        <span style="font-weight:500;color:#1a8a5a;">+${Number(p.amount).toLocaleString()} ₸</span>
      </div>
      <div style="font-size:11px;color:#aaa;margin-top:3px;">${pe.channel} · объясняет расхождение</div>
    </div>`;
      });
    });
    teamPrepaySection += `</div>`;
  }

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Итоги дня — ${today}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ede8;color:#1a1a1a;padding:20px 16px;margin:0;">
<div style="max-width:680px;margin:0 auto;">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
    <div>
      <div style="font-size:21px;font-weight:700;letter-spacing:0.07em;color:#1a1a1a;">NANÉ PARIS</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.12em;margin-top:2px;">Итоги дня</div>
    </div>
    <div style="text-align:right;font-size:13px;color:#555;">
      <strong style="color:#1a1a1a;display:block;font-size:14px;">${today}</strong>
      закрыто в ${closeTime}
    </div>
  </div>

  <div style="background:${statusBg};border:1px solid ${statusBorder};border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px;margin-bottom:20px;">
    <div style="width:8px;height:8px;border-radius:50%;background:${statusDot};flex-shrink:0;"></div>
    <span style="font-size:13px;font-weight:500;color:${statusColor};">${statusText}</span>
  </div>

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:0 0 8px;">Оборот дня</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;margin-bottom:10px;">
    <div style="font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:4px;">${fmt(rostaTotal)}</div>
    <div style="font-size:12px;color:#aaa;">итого по ROSTA</div>
  </div>

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Каналы продаж</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px;">
    ${channelRows}
    <div style="padding:11px 14px;display:flex;justify-content:space-between;font-size:13px;font-weight:600;">
      <span>Итого</span>
      <span>${fmt(rostaTotal)}</span>
    </div>
  </div>

  ${teamPrepaySection}

</div></body></html>`;
}

async function sendTelegram(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    const body = JSON.stringify({ chat_id: chatId, text: chunk });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + TELEGRAM_TOKEN + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => resolve()); });
      req.on('error', reject); req.write(body); req.end();
    });
    await new Promise(r => setTimeout(r, 300));
  }
}

async function sendTelegramDocument(chatId, filename, content, caption) {
  const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
  const fileBuffer = Buffer.from(content, 'utf8');
  let body = '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n';
  if (caption) body += '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
  body += '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + filename + '"\r\nContent-Type: text/html\r\n\r\n';
  const fullBody = Buffer.concat([Buffer.from(body, 'utf8'), fileBuffer, Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')]);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_TOKEN + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': fullBody.length }
    }, res => { let data = ''; res.on('data', d => data += d); res.on('end', () => { if (res.statusCode !== 200) console.error('sendDocument error:', data); resolve(); }); });
    req.on('error', reject); req.write(fullBody); req.end();
  });
}

function formatPrepayCardHTML(p, num) {
  const isClosed = p.status.includes('закрыт');
  const statusBg = isClosed ? '#eaf3de' : '#faeeda';
  const statusBorder = isClosed ? '#c0dd97' : '#FAC775';
  const statusText = isClosed ? '✅ Закрыта' : '🟡 Открыта';
  const statusColor = isClosed ? '#3B6D11' : '#854F0B';
  const initials = p.client.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const total = (p.amount || 0) + (p.balance || 0);
  const fmt = n => Number(n || 0).toLocaleString('ru-RU') + ' ₸';
  const debtBlock = p.balance > 0
    ? '<div style="background:#fcebeb; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:11px; color:#A32D2D; margin-bottom:4px;">Долг к доплате</div><div style="font-size:15px; font-weight:600; color:#A32D2D;">' + fmt(p.balance) + '</div></div>'
    : '<div style="background:#eaf3de; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:11px; color:#3B6D11; margin-bottom:4px;">Долг</div><div style="font-size:15px; font-weight:600; color:#3B6D11;">Оплачено</div></div>';
  return `<div style="background:#fff; border:1px solid #e8e8e4; border-radius:12px; padding:14px; margin-bottom:12px;">
  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
    <div style="display:flex; align-items:center; gap:10px;">
      <div style="width:38px; height:38px; border-radius:50%; background:${statusBg}; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:${statusColor};">${initials}</div>
      <div><div style="font-size:14px; font-weight:600; color:#1a1a1a;">${num}. ${p.client}</div><div style="font-size:11px; color:#888;">${p.id || ''} · ${p.date || ''}</div></div>
    </div>
    <div style="background:${statusBg}; border:1px solid ${statusBorder}; color:${statusColor}; font-size:11px; font-weight:600; padding:4px 10px; border-radius:20px;">${statusText}</div>
  </div>
  ${p.items && p.items.length ? '<div style="background:#f5f5f0; border-radius:8px; padding:8px 12px; margin-bottom:10px; font-size:13px; color:#1a1a1a;">👗 ' + p.items.join(', ') + '</div>' : ''}
  <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:10px;">
    <div style="background:#f5f5f0; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:11px; color:#888; margin-bottom:4px;">Цена товара</div><div style="font-size:14px; font-weight:600; color:#1a1a1a;">${fmt(total > 0 ? total : p.amount)}</div></div>
    <div style="background:#f5f5f0; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:11px; color:#888; margin-bottom:4px;">Аванс</div><div style="font-size:14px; font-weight:600; color:#1a1a1a;">${fmt(p.amount)}</div></div>
    ${debtBlock}
  </div>
  <div style="border-top:1px solid #f0f0ec; padding-top:8px; font-size:12px; color:#888;">${p.phone ? '📞 ' + p.phone + '&nbsp;&nbsp;' : ''}💳 ${p.channel || '—'}</div>
</div>`;
}

function generatePrepaysHTML(list, type) {
  const title = type === 'open' ? 'Открытые предоплаты' : 'Закрытые предоплаты';
  const totalDebt = list.filter(p => !p.status.includes('закрыт')).reduce((s,p) => s + (p.balance||0), 0);
  const totalAmount = list.reduce((s,p) => s + (p.amount||0), 0);
  const fmt = n => Number(n||0).toLocaleString('ru-RU') + ' ₸';
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>* { box-sizing:border-box; margin:0; padding:0; } body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f5f5f0; padding:20px 16px; } .container { max-width:680px; margin:0 auto; } .brand { font-size:20px; font-weight:600; letter-spacing:0.04em; } .brand-sub { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.1em; margin-top:2px; margin-bottom:16px; } .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px; } .stat { background:#efefea; border-radius:8px; padding:12px; } .stat-label { font-size:11px; color:#888; margin-bottom:4px; } .stat-value { font-size:18px; font-weight:600; color:#1a1a1a; }</style></head>
<body><div class="container">
  <div class="brand">NANÉ PARIS</div>
  <div class="brand-sub">${title} · ${list.length} шт · ${getNow()}</div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Всего позиций</div><div class="stat-value">${list.length}</div></div>
    <div class="stat"><div class="stat-label">Сумма авансов</div><div class="stat-value">${fmt(totalAmount)}</div></div>
    <div class="stat"><div class="stat-label">Сумма долгов</div><div class="stat-value" style="color:${totalDebt > 0 ? '#E24B4A' : '#1D9E75'};">${fmt(totalDebt)}</div></div>
  </div>
  ${list.map((p, i) => formatPrepayCardHTML(p, i + 1)).join('')}
</div></body></html>`;
}

function generateShiftHTML(data) {
  const { sellerName, date, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs, prepayExplanations } = data;
  const isOk = diff === 0;
  const isDanger = !isOk && Math.abs(diff) >= 500;
  const statusBg = isOk ? '#eaf3de' : isDanger ? '#fcebeb' : '#faeeda';
  const statusBorder = isOk ? '#c0dd97' : isDanger ? '#F7C1C1' : '#FAC775';
  const statusDot = isOk ? '#639922' : isDanger ? '#E24B4A' : '#BA7517';
  const statusText = isOk ? 'Все каналы сходятся — смена закрыта корректно' : isDanger ? 'РАСХОЖДЕНИЕ — требует внимания' : 'Незначительное расхождение';
  const statusColor = isOk ? '#3B6D11' : isDanger ? '#A32D2D' : '#854F0B';
  const diffColor = diff > 0 ? '#1D9E75' : diff < 0 ? '#E24B4A' : '#1D9E75';
  const diffSign = diff > 0 ? '+' : '';
  const fmt = n => Number(n || 0).toLocaleString('ru-RU') + ' ₸';
  let diffDetails = '';
  if (isDanger && channelDiffs && channelDiffs.length > 0) {
    diffDetails = '<div style="background:#fff8f8; border:1px solid #F7C1C1; border-radius:8px; padding:14px; margin-bottom:16px;"><div style="font-size:13px; font-weight:600; color:#A32D2D; margin-bottom:10px;">Расшифровка расхождений</div>';
    channelDiffs.forEach(cd => {
      const sign = cd.diff > 0 ? '+' : '';
      const color = cd.diff > 0 ? '#1D9E75' : '#E24B4A';
      const direction = cd.diff > 0 ? 'излишек' : 'недостача';
      diffDetails += '<div style="display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid #fde8e8;"><span style="color:#555;">' + cd.channel + '</span><span style="color:' + color + '; font-weight:600;">' + sign + fmt(cd.diff) + ' (' + direction + ')</span></div>';
    });
    diffDetails += '</div>';
  }
  let prepaySection = '';
  if (prepayExplanations && prepayExplanations.length > 0) {
    prepaySection = '<div style="background:#eaf3de; border:1px solid #c0dd97; border-radius:8px; padding:14px; margin-bottom:16px;"><div style="font-size:13px; font-weight:600; color:#3B6D11; margin-bottom:10px;">✅ Расхождение объяснено предоплатами</div>';
    prepayExplanations.forEach(pe => {
      const sign = pe.diff > 0 ? '+' : '';
      prepaySection += '<div style="font-size:12px; padding:5px 0; border-bottom:1px solid #c0dd97;"><span style="color:#555; font-weight:600;">' + pe.channel + ': ' + sign + Number(pe.diff).toLocaleString() + ' ₸</span></div>';
      pe.prepays.forEach(p => {
        prepaySection += '<div style="font-size:12px; padding:4px 0 4px 12px; color:#3B6D11;">→ ' + p.client + ' — ' + Number(p.amount).toLocaleString() + ' ₸</div>';
      });
    });
    prepaySection += '</div>';
  }
  // Валовые продажи и возвраты
  const grossSales = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0);
  const totalRetAll = (s.rRetKaspi||0)+(s.rRetHalyk||0)+(s.rRetCash||0);

  // Пояснения к расхождениям
  let notesSection = '';
  if (s.notes && s.notes.trim().length > 0) {
    notesSection = '<div style="background:#fffbe6;border:1px solid #FAC775;border-radius:8px;padding:14px;margin-bottom:16px;">' +
      '<div style="font-size:13px;font-weight:600;color:#854F0B;margin-bottom:8px;">📝 Пояснения к расхождениям</div>' +
      '<div style="font-size:12px;color:#555;line-height:1.6;">' + s.notes.replace(/;/g, '<br>') + '</div></div>';
  }

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт смены — ${sellerName}</title>
<style>* { box-sizing:border-box; margin:0; padding:0; } body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f5f5f0; color:#1a1a1a; padding:24px 16px; } .container { max-width:680px; margin:0 auto; } .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; } .brand { font-size:22px; font-weight:600; letter-spacing:0.04em; } .brand-sub { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.1em; margin-top:2px; } .header-right { text-align:right; font-size:13px; color:#555; } .header-right strong { color:#1a1a1a; display:block; font-size:14px; } .grid4 { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px; } .grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; } .grid2 { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:16px; } .metric { background:#efefea; border-radius:8px; padding:12px; } .metric-label { font-size:10px; color:#888; margin-bottom:4px; } .metric-value { font-size:16px; font-weight:600; } .card { background:#fff; border:1px solid #e8e8e4; border-radius:12px; padding:14px; } .card-title { display:flex; align-items:center; gap:7px; margin-bottom:12px; font-size:13px; font-weight:600; } .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; } .row { display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid #f0f0ec; } .row-label { color:#888; } .row-value { font-weight:500; } .row-total { display:flex; justify-content:space-between; font-size:13px; font-weight:600; padding:8px 0 0; } .sverka-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; } .sec { font-size:10px; color:#999; text-transform:uppercase; letter-spacing:0.12em; margin:18px 0 8px; }</style></head>
<body><div class="container">
  <div class="header"><div><div class="brand">NANÉ PARIS</div><div class="brand-sub">Отчёт смены</div></div><div class="header-right"><strong>${date}</strong>${sellerName} · закрыто в ${closeTime}</div></div>
  <div style="background:${statusBg};border:1px solid ${statusBorder};border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px;margin-bottom:20px;"><div style="width:8px;height:8px;border-radius:50%;background:${statusDot};flex-shrink:0;"></div><span style="font-size:13px;font-weight:600;color:${statusColor};">${statusText}</span></div>

  <div class="sec">Эффективность дня</div>
  <div class="grid4">
    <div class="metric"><div class="metric-label">Валовые продажи</div><div class="metric-value">${fmt(grossSales)}</div></div>
    <div class="metric"><div class="metric-label">Возвраты</div><div class="metric-value" style="color:#E24B4A;">${totalRetAll > 0 ? '-'+fmt(totalRetAll) : fmt(0)}</div></div>
    <div class="metric"><div class="metric-label">Чистые продажи</div><div class="metric-value">${fmt(rostaTotal)}</div></div>
    <div class="metric"><div class="metric-label">Получено денег</div><div class="metric-value">${fmt(factTotal)}</div></div>
  </div>

  ${diffDetails}
  ${prepaySection}
  ${notesSection}

  <div class="sec">Каналы продаж</div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
    <div class="card"><div class="card-title"><div class="dot" style="background:#378ADD"></div>Kaspi</div>
      <div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rOnline)}</span></div>
      <div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rKaspi)}</span></div>
      <div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tKaspi)}</span></div>
      ${(s.tKaspiRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tKaspiRet)+'</span></div>':''} 
      <div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(kaspiNet)}</span></div>
    </div>
    <div class="card"><div class="card-title"><div class="dot" style="background:#7F77DD"></div>Halyk</div>
      <div class="row"><span class="row-label">Онлайн (ROSTA)</span><span class="row-value">${fmt(s.rHalykOnline)}</span></div>
      <div class="row"><span class="row-label">QR (ROSTA)</span><span class="row-value">${fmt(s.rHalyk)}</span></div>
      <div class="row"><span class="row-label">Терминал (ФАКТ)</span><span class="row-value">${fmt(s.tHalyk)}</span></div>
      ${(s.tHalykRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tHalykRet)+'</span></div>':''} 
      <div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(halykNet)}</span></div>
    </div>
    <div class="card"><div class="card-title"><div class="dot" style="background:#1D9E75"></div>Прочие</div>
      <div class="row"><span class="row-label">Наличные</span><span class="row-value">${fmt(s.rCash)}</span></div>
      ${(s.rPersonal||0)>0?'<div class="row"><span class="row-label">Личная карта Айнур</span><span class="row-value">'+fmt(s.rPersonal)+'</span></div>':''} 
      ${(s.rBonus||0)>0?'<div class="row"><span class="row-label">Бонусы</span><span class="row-value">'+fmt(s.rBonus)+'</span></div>':''} 
      ${totalRetAll>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возвраты всего</span><span class="row-value" style="color:#E24B4A">-'+fmt(totalRetAll)+'</span></div>':''} 
      <div class="row-total"><span>Итого</span><span>${fmt((s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0))}</span></div>
    </div>
  </div>

  <div class="sec">Касса и сверка</div>
  <div class="grid2">
    <div class="card"><div class="card-title">💵 Касса</div>
      <div class="row"><span class="row-label">Открытие</span><span class="row-value">${fmt(s.cashOpen)}</span></div>
      <div class="row"><span class="row-label">Закрытие</span><span class="row-value">${fmt(s.cashActual)}</span></div>
      <div class="row"><span class="row-label">Продажи нал</span><span class="row-value">${fmt(cashSales)}</span></div>
      ${(s.inkasso||0)>0?'<div class="row"><span class="row-label">Инкассация</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.inkasso)+'</span></div>':''} 
      ${(s.cashPayouts||0)>0?'<div class="row"><span class="row-label">Расходы из кассы</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.cashPayouts)+'</span></div>':''} 
    </div>
    <div class="card"><div class="card-title">🔍 Сверка</div>
      <div class="row"><span class="row-label">ROSTA</span><span class="row-value">${fmt(rostaTotal)}</span></div>
      <div class="row"><span class="row-label">ФАКТ</span><span class="row-value">${fmt(factTotal)}</span></div>
      <div class="row"><span class="row-label">Разница</span><span class="row-value" style="color:${diffColor};font-weight:600;">${diffSign}${fmt(diff)}</span></div>
    </div>
  </div>

  <div class="sverka-grid" style="margin-bottom:24px;">
    ${[
      {label:'Kaspi', d: Math.abs(kaspiNet-((s.rKaspi||0)+(s.rOnline||0)))},
      {label:'Halyk', d: Math.abs(halykNet-((s.rHalyk||0)+(s.rHalykOnline||0)))},
      {label:'Наличные', d: 0}
    ].map(item => {
      const ok = item.d <= 500;
      return '<div style="background:'+(ok?'#eaf3de':'#fcebeb')+';border:1px solid '+(ok?'#c0dd97':'#F7C1C1')+';border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:#888;margin-bottom:4px;">'+item.label+'</div><div style="font-size:13px;font-weight:600;color:'+(ok?'#3B6D11':'#A32D2D')+';">'+(ok?'Сходится':'Расхождение')+'</div></div>';
    }).join('')}
  </div>

  <div style="border-top:1px solid #e8e8e4;padding-top:16px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
    <div style="font-size:12px;color:#aaa;">Подпись продавца: ${sellerName}</div>
    <div style="border-bottom:1px solid #1a1a1a;width:180px;height:24px;"></div>
  </div>

</div></body></html>`;
}

async function loadOwnerData() {
  const prepays_raw = await dbGetPrepays('open');
  const shifts = [];
  const prepays = prepays_raw.map(p => [p.prep_id, p.prep_date, p.client_name, p.phone, p.item, p.channel, p.amount, p.balance, p.status, '', p.notes]);
  const recentShifts = shifts.slice(-30).map(r => ({ date: r[0], seller: r[1], rostaTotal: r[19], factTotal: r[20], diff: r[21], status: r[22] }));
  const openPrepays = prepays.slice(1).filter(r => r[0] && String(r[8]||'').toLowerCase().includes('открыт')).map(r => ({ id: r[0], date: r[1], client: r[2], phone: r[3], item: r[4], channel: r[5], amount: r[6], balance: r[7] }));
  return { recentShifts, openPrepays };
}

async function loadPrepays(type) {
  const rawData = await dbGetPrepays(type === 'open' ? 'open' : type === 'closed' ? 'closed' : 'all');
  const list = rawData.map(p => ({
    id: p.prep_id,
    date: p.prep_date ? String(p.prep_date) : '',
    client: p.client_name || '',
    phone: p.phone || '',
    channel: p.channel || '—',
    amount: Number(p.amount || 0),
    balance: Number(p.balance || 0),
    status: p.status || '🟡 Открыта',
    items: p.item ? [p.item] : [],
    notes: p.notes || ''
  }));
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  return list;
}

function getSellerPrompt(sellerName, shopName, hasOpenShift, isSecondSeller, firstSellerName) {
  const today = getDate();
  const now = getTime();

  // Второй продавец — упрощённый сценарий
  if (isSecondSeller) {
    return 'Ты — Томи, AI-управляющая NANE PARIS (Астана). Ты — женщина.\n' +
      'Сегодня: ' + today + ', время: ' + now + '\nПродавец: ' + sellerName + '\n' +
      'РОЛЬ: Второй продавец смены. Смену уже открыл(а) ' + (firstSellerName || 'первый продавец') + '.\n\n' +
      'ХАРАКТЕР: Строгий профессионал. Четко, по делу. Женский род.\n' +
      'Один вопрос за раз. Только русский. Никакого Markdown.\n\n' +
      'ЧЕК-ЛИСТ ПРИХОДА (второй продавец):\n' +
      'Если позже 11:00 => LATE_ALERT:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'ШАГ 0 — ВНЕШНИЙ ВИД: макияж, одежда, готовность\n' +
      'ШАГ 1 — ГЕОЛОКАЦИЯ: "Пришли геолокацию через скрепку."\n' +
      'Когда система написала что геолокация получена — выдай SECOND_ARRIVE и попрощайся.\n' +
      '=> SECOND_ARRIVE:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'После этого — поприветствуй и пожелай хорошей смены. Больше ничего не спрашивай.\n\n' +
      'УХОД (второй продавец уходит раньше закрытия):\n' +
      'Когда пишет "Ухожу" или "Заканчиваю" — попроси геолокацию.\n' +
      'Когда система написала что геолокация получена — выдай SECOND_LEAVE.\n' +
      '=> SECOND_LEAVE:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'Попрощайся и пожелай хорошего вечера.\n\n' +
      'ПРЕДОПЛАТЫ (доступны всегда, без открытия смены):\n' +
      'Новая => PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}\n' +
      'Выкуп => PREPAY_LIST:открытые => PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}\n' +
      'Удаление — запрос руководителю => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента","reason":""}\n\n' +
      'ВАЖНО: на приветствия без "Начала смену" просто отвечай приветствием — НЕ начинай чек-лист.\n\n' +
      'ОБУЧЕНИЕ (доступно всегда, даже без открытой смены):\n' +
      'Когда продавец пишет "Обучение", "Учиться", "Урок" или "Тест" — переходи в режим обучения.\n' +
      'В режиме обучения ты — строгий но справедливый тренер по продажам. Используй мировые практики fashion retail.\n\n' +
      'МЕНЮ ОБУЧЕНИЯ (показывай когда просят):\n' +
      '1. Встреча покупателя — первый контакт, приветствие, установление контакта\n' +
      '2. Выявление потребности — вопросы SPIN, активное слушание\n' +
      '3. Презентация товара — техника FAB (Feature-Advantage-Benefit)\n' +
      '4. Работа с возражением «Дорого»\n' +
      '5. Работа с возражением «Подумаю»\n' +
      '6. Допродажа — upsell и cross-sell в fashion\n' +
      '7. Завершение сделки — техники закрытия\n' +
      '8. Конфликтный клиент — деэскалация\n' +
      '9. Стандарты NANE PARIS — внешний вид, речь, поведение\n' +
      '10. Тест — проверка знаний по любой теме\n\n' +
      'КАК ПРОВОДИТЬ УРОК:\n' +
      '- Сначала короткая теория (3-5 ключевых пунктов) с примерами из fashion retail\n' +
      '- Потом практический пример диалога продавец-покупатель\n' +
      '- В конце 3 вопроса для проверки — продавец отвечает, ты оцениваешь\n' +
      '- Итог урока фиксируй: => TRAINING_RESULT:{"seller":"","topic":"","score":0,"date":""}\n\n' +
      'СТАНДАРТЫ NANE PARIS (всегда применяй в обучении):\n' +
      '- Бренд: корейская женская мода, премиум сегмент, Астана\n' +
      '- Тон общения: тёплый, профессиональный, как личный стилист\n' +
      '- Запрещено: слово «нет», «не знаю», «не можем»\n' +
      '- Приветствие: «Добро пожаловать в NANE PARIS!»\n' +
      '- Внешний вид продавца: всегда безупречный, одежда из ассортимента магазина\n' +
      '- Корейские размеры: S=42-44, M=44-46, L=46-48, XL=48-50 (казахстанский)';
  }

  const shiftStatus = hasOpenShift
    ? 'СМЕНА УЖЕ ОТКРЫТА. Не начинай чек-лист открытия заново. Продолжай работу.'
    : 'Смена не открыта. ВАЖНО: начинай чек-лист ТОЛЬКО когда продавец явно напишет "Начала смену", "Открываю смену" или "Начинаю смену". На приветствия просто отвечай приветствием — НЕ начинай чек-лист.';

  return 'Ты — Томи, AI-управляющая NANE PARIS (Астана). Ты — женщина.\n' +
    'Сегодня: ' + today + ', время: ' + now + '\nПродавец: ' + sellerName + '\n' +
    'СТАТУС СМЕНЫ: ' + shiftStatus + '\n\n' +
    'ХАРАКТЕР: Строгий профессионал. Четко, по делу. Женский род.\n' +
    'Один вопрос за раз. Только русский. Никакого Markdown.\n\n' +

    'ПРЕДОПЛАТЫ (доступны ВСЕГДА — даже если смена не открыта):\n' +
    'Новая => PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}\n' +
    'Выкуп => PREPAY_LIST:открытые => PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}\n' +
    'Удаление — запрос руководителю => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента","reason":""}\n' +
    'Если продавец говорит имя клиента вместо ID — сначала найди предоплату через PREPAY_LIST, потом удали по найденному ID или имени.\n' +
    'Просмотр => PREPAY_LIST:открытые или PREPAY_LIST:закрытые\n' +
    'ВАЖНО: если продавец спрашивает про предоплату — обрабатывай сразу, не требуй сначала открыть смену.\n\n' +

    'ЧЕК-ЛИСТ ОТКРЫТИЯ (строго по порядку, один шаг за раз, не повторять уже отвеченные шаги):\n' +
    'КРИТИЧНО: каждый шаг задаётся ОДИН РАЗ. Если продавец уже ответил на вопрос — не спрашивай снова.\n' +
    'Проверяй историю диалога перед каждым вопросом — если ответ уже есть, переходи к следующему шагу.\n\n' +
    'ШАГ 0 — ВНЕШНИЙ ВИД\n' +
    'Спроси: макияж готов? одежда в порядке?\n' +
    'ВАЖНО: смена должна быть открыта до 11:00. Если уже 11:00+ — это опоздание.\n' +
    'Если позже 11:00 => LATE_ALERT:{"seller":"' + sellerName + '","time":"' + now + '"}\n\n' +
    'ШАГ 1 — ГЕОЛОКАЦИЯ\n' +
    'Спроси: "Пришли геолокацию через скрепку."\n' +
    'Когда получишь сообщение с числом метров и словом ок — это подтверждение геолокации. Сразу без лишних слов спроси шаг 2: "Сколько наличных в кассе?"\n\n' +
    'ШАГ 2 — КАССА\n' +
    'Спроси: сколько наличных в кассе на начало смены?\n' +
    'Запомни сумму — она войдёт в SHIFT_OPEN как cashOpen.\n' +
    'ВАЖНО: в cashOpen подставь РЕАЛЬНУЮ сумму которую назвала продавец, НЕ 0!\n' +
    'После SHIFT_OPEN система автоматически сравнит с остатком предыдущей смены.\n' +
    'Если система сообщила о расхождении кассы — ты ОБЯЗАНА дожать объяснение:\n' +
    '  Спроси: "Откуда разница? Была инкассация? Расходы из кассы? Ошибка счёта?"\n' +
    '  Не переходи к следующим шагам пока не получишь внятный ответ.\n' +
    '  "Не знаю" — не принимается. Дожимай.\n\n' +
    'ШАГ 3 — ТЕРМИНАЛЫ\n' +
    'Спроси: пришли фото экрана Kaspi терминала.\n' +
    'Потом: пришли фото экрана Halyk терминала.\n' +
    'Если не работает => TERMINAL_ALERT:{"seller":"' + sellerName + '","terminal":"","reason":""}\n\n' +
    'ШАГ 4 — ЗАЛ\n' +
    'Спроси одним сообщением: пыль убрана? ценники на месте? выкладка в порядке? освещение включено? музыка играет?\n\n' +
    'ШАГ 5 — ПРИМЕРОЧНЫЕ\n' +
    'Спроси одним сообщением: примерочные чистые? крючки на месте? зеркала чистые?\n\n' +
    'ШАГ 6 — ГОСТЕВАЯ ЗОНА\n' +
    'Спроси одним сообщением: чай/кофе есть? вода есть? посуда чистая?\n\n' +
    'ШАГ 7 — УПАКОВКА\n' +
    'Спроси: пакеты и коробки есть в достаточном количестве?\n\n' +
    'ШАГ 8 — ТЕЛЕФОН\n' +
    'Спроси: телефон заряжен?\n\n' +
    'ШАГ 9 — ROSTA\n' +
    'Спроси: ROSTA открыта?\n' +
    'После "да" — выдай SHIFT_OPEN с суммой кассы из шага 2.\n' +
    'ВАЖНО: в cashOpen подставь РЕАЛЬНУЮ сумму которую назвала продавец на шаге 2, НЕ 0!\n' +
    'Например если сказала "15000" — пиши cashOpen:15000\n' +
    '=> SHIFT_OPEN:{"seller":"' + sellerName + '","shop":"' + shopName + '","cashOpen":СУММА_ИЗ_ШАГА_2,"time":"' + now + '"}\n\n' +

    'ЗАКРЫТИЕ СМЕНЫ — ЖЁСТКИЙ КОНТРОЛЬ:\n' +
    'ШАГ 1 — Z-ОТЧЕТ: попроси фото экрана ROSTA. Считай все суммы по каналам.\n' +
    'ШАГ 2 — KASPI ТЕРМИНАЛ: попроси фото. Считай брутто и возвраты.\n' +
    '   Сравни: ROSTA Kaspi (QR + Онлайн) vs ФАКТ терминал.\n' +
    '   Если разница >500 тг — СТОП. Спроси: "По Kaspi расхождение X тг. Причина?"\n' +
    '   Не переходи дальше пока не получишь объяснение.\n' +
    'ШАГ 3 — HALYK ТЕРМИНАЛ: попроси фото. Считай брутто и возвраты.\n' +
    '   Сравни: ROSTA Halyk (QR + Онлайн) vs ФАКТ терминал.\n' +
    '   Если разница >500 тг — СТОП. Спроси: "По Halyk расхождение X тг. Причина?"\n' +
    '   Не переходи дальше пока не получишь объяснение.\n' +
    'ШАГ 4 — НАЛИЧНЫЕ: спроси сколько в кассе на конец.\n' +
    '   Считай: продажи нал = касса конец - касса начало + расходы + инкассация.\n' +
    '   Сравни с ROSTA наличными.\n' +
    '   Если разница >500 тг — СТОП. Спроси: "По наличным расхождение X тг. Причина?"\n' +
    '   Варианты: выдача сдачи? расходы из кассы? забрали раньше? ошибка счёта?\n' +
    '   Не переходи дальше пока не получишь объяснение.\n' +
    'ШАГ 5 — ЛИЧНАЯ КАРТА: сумма из ROSTA (не с терминала).\n' +
    'ШАГ 6 — ИНКАССАЦИЯ: была ли? => INKASSO_CHECK:{"sellerAmount":0,"ownerAmount":0}\n' +
    'ШАГ 7 — ЗАЛ: товар убран, ценники на месте?\n' +
    'ШАГ 8 — ГОСТЕВАЯ: посуда вымыта, стол чистый?\n' +
    'ШАГ 9 — ГЕОЛОКАЦИЯ: "Пришли геолокацию для закрытия."\n' +
    'Когда получишь сообщение с числом метров и словом ок — это подтверждение геолокации. Сразу выдай SHIFT_CLOSE со всеми данными.\n' +
    '=> SHIFT_CLOSE:{...,"notes":"объяснение расхождений если были"}\n\n' +
    'КРИТИЧНО: система сама заблокирует закрытие если в notes нет объяснения при расхождении >500 тг.\n' +
    'Ты как AI должна САМА провести анализ — не просто принять цифры, а проверить логику.\n' +
    'Если продавец говорит "не знаю" — это не объяснение. Дожимай до конкретной причины.\n\n' +
    'rKaspi=QR Kaspi ROSTA, rOnline=Онлайн Kaspi ROSTA, rHalyk=QR Halyk ROSTA, rHalykOnline=Онлайн Halyk ROSTA\n' +
    'rCash=Наличные, rPersonal=Личная карта ROSTA, rBonus=Бонусы\n' +
    'tKaspi=Kaspi ФАКТ, tKaspiRet=возврат Kaspi, tHalyk=Halyk ФАКТ, tHalykRet=возврат Halyk\n' +
    'cashOpen=начало, cashActual=конец\n' +
    '=> SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}\n\n' +
    'Необъясненное расхождение >500 тг — НЕ ЗАКРЫВАЙ смену, уточни причину. Один вопрос за раз.\n\n' +
    'ОБУЧЕНИЕ (доступно всегда, даже без открытой смены):\n' +
    'Когда продавец пишет "Обучение", "Учиться", "Урок", "Тест" или спрашивает про технику продаж — переходи в режим обучения.\n' +
    'В режиме обучения ты — строгий но справедливый тренер по продажам в fashion retail. Давай конкретные практические советы.\n\n' +
    'МЕНЮ ОБУЧЕНИЯ:\n' +
    '1. Встреча покупателя — первый контакт, приветствие, установление доверия\n' +
    '2. Выявление потребности — вопросы SPIN, активное слушание\n' +
    '3. Презентация товара — техника FAB (Feature-Advantage-Benefit)\n' +
    '4. Работа с возражением «Дорого»\n' +
    '5. Работа с возражением «Подумаю»\n' +
    '6. Допродажа — upsell и cross-sell в fashion\n' +
    '7. Завершение сделки — техники закрытия\n' +
    '8. Конфликтный клиент — деэскалация\n' +
    '9. Стандарты NANE PARIS\n' +
    '10. Тест — проверка знаний\n\n' +
    'КАК ПРОВОДИТЬ УРОК:\n' +
    'Теория (3-5 пунктов с примерами из fashion) → Диалог-пример продавец/покупатель → 3 вопроса для проверки → оценка ответов → итог\n' +
    'Итог фиксируй: => TRAINING_RESULT:{"seller":"","topic":"","score":0,"date":""}\n\n' +
    'ПОДТВЕРЖДЕНИЕ УРОКА:\n' +
    'Когда продавец пишет «Урок изучен», «Изучила», «Готово», «Прочитала» — подтверди и зафикисруй => LESSON_CONFIRMED\n' +
    'Похвали за своевременное прохождение.\n\n' +
    'ПОВТОРНЫЙ ДОСТУП К МАТЕРИАЛАМ:\n' +
    'Если продавец пишет «Повтори урок», «Пришли материал», «Урок» — отправь команду LESSON_REPEAT\n' +
    'Если пишет название темы (например «урок про возражения», «про допродажу») — сразу расскажи эту тему кратко\n' +
    'Если пишет «Все темы» или «Список тем» — покажи список всех 5 тем обучения\n' +
    '=> LESSON_REPEAT (без параметров — система пришлёт последний урок)\n\n' +
    'СТАНДАРТЫ NANE PARIS:\n' +
    'Бренд: корейская женская мода, премиум, Астана. Тон: тёплый, как личный стилист.\n' +
    'Запрещено говорить: «нет», «не знаю», «не можем». Приветствие: «Добро пожаловать в NANE PARIS!»\n' +
    'Размеры корейские: S=42-44, M=44-46, L=46-48, XL=48-50 (казахстанский).\n' +
    'Внешний вид: безупречный, одежда из ассортимента магазина.';
}

function getOwnerPrompt(ownerName, data) {
  const today = getDate();
  const now = getTime();
  const totalPrepay = data.openPrepays.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  return 'Ты — Томи, AI-партнер NANE PARIS. Ты — женщина.\n' +
    'Сегодня: ' + today + ', время: ' + now + '\nВладелец: ' + ownerName + '\n\n' +
    'ХАРАКТЕР: Партнер на равных. Прямо, честно, с цифрами. Никакого Markdown.\n\n' +
    'ДАННЫЕ:\nПоследние смены: ' + JSON.stringify(data.recentShifts) + '\n' +
    'Открытые предоплаты (' + data.openPrepays.length + ' шт, итого: ' + totalPrepay.toLocaleString() + ' тг):\n' +
    JSON.stringify(data.openPrepays.slice(0, 20)) + '\n\n' +
    'ВАЖНО: При каждом закрытии смены ты автоматически записываешь данные в Google Sheets "Учёт по дням".\n\n' +
    'КОМАНДЫ:\n' +
    '"Отчет" — итог за сутки\n' +
    '"Аналитика" — недельная сводка\n' +
    '"Предоплаты" => PREPAY_LIST:открытые\n' +
    'Удалить предоплату: "удали PREP-XXXX" или "удали предоплату Иванова" => PREPAY_DELETE:{"id":"PREP-XXXX или имя клиента"}\n' +
    '"Команда" — сводка по продавцам\n' +
    '"Зарплата" — расчет ФОТ\n' +
    '"Дашборд" => DASHBOARD_HTML\n' +
    '"Повторно вышли отчёт" или "вышли html" — запрос на повторную отправку отчёта закрытия => RESEND_REPORT\n' +
    '"Отчёт недели" — еженедельный HTML отчёт прямо сейчас => WEEKLY_REPORT\n' +
    '"P&L" — финансовый отчёт месяца => PL_REPORT\n' +
    'Расходы: если пишет "Аренда 500000" или "Закупка 12000000 корея" и т.д — распознай категорию и сумму => EXPENSE_SAVE:{"date":"","category":"","amount":0,"note":""}\n' +
    'Удаление расхода: "удали последний расход" или "удали аренду" => EXPENSE_DELETE:{"note":"что удалить"}\n' +
    'Напоминания: "напомни завтра в 10:00 позвонить поставщику" => REMINDER_SAVE:{"text":"","remind_at":"ISO datetime","user_id":""}\n' +
    'Для remind_at используй реальную дату и время по Алматы в ISO формате. Сегодня: ' + getNow() + '\n' +
    'Категории расходов: Аренда, Закупка товара, Коммунальные, Зарплата персонала, Реклама, Транспорт, Прочее\n\n' +
    '"Инкассация [сумма]" => OWNER_INKASSO:{"amount":0,"time":"' + now + '"}\n' +
    '"Обучение команды" или "Статистика обучения" — покажи результаты тестов продавцов из листа Дисциплина => TRAINING_STATS\n' +
    '"Запусти обучение" — отправить урок продавцам прямо сейчас => TRAINING_NOW\n' +
    '"Продажи за май" / "Продажи за июнь" / "Продажи за месяц" / "Оборот" — показать данные по продажам => SALES_LIST:{"month":0,"year":0}\n' +
    '"Зарплата" / "ФОТ" / "Расчёт зарплаты" / "Зарплата за май" — расчёт зарплаты => SALARY_CALC:{"month":0,"year":0}\n' +
    '"KPI Асель 3" / "KPI Зарина 2" / «поставь KPI Луизе 1» — выставить KPI продавцу (0-3) => KPI_SET:{"seller":"Имя","score":0,"month":0,"year":0}\n' +
    '"KPI" / "Посмотри KPI" — показать текущие KPI => KPI_LIST:{"month":0,"year":0}\n' +
    'Расход / трата / потратил — если владелец упоминает расход или трату с суммой => EXPENSE_NEW:{"amount":0,"description":""}\n' +
    'ВАЖНО: в EXPENSE_NEW всегда ставь текущую дату ' + now + ', не выдумывай даты из контекста\n' +
    '"Мои расходы" / "Расходы за месяц" / "Расходы за неделю" / "Покажи расходы" / "Покажи все расходы" / "Какие расходы" / "Расходы" — любой запрос на просмотр расходов => EXPENSE_LIST:{"period":"month"}\n' +
    'КРИТИЧЕСКИ ВАЖНО: при любом запросе посмотреть расходы — ВСЕГДА выдавай EXPENSE_LIST, НЕ отвечай текстом что не знаешь данных\n' +
    '"Останови обучение" или «Отмени обучение» — поставить на паузу => TRAINING_PAUSE\n' +
    '"Возобнови обучение" — снять с паузы => TRAINING_RESUME\n\n' +
    'ШКАЛА ФОТ: до 500к — 1.2%, 500к-750к — 1.7%, 750к-1млн — 2.2%, 1млн+ — 2.7%\n' +
    'Бонусы: от 700к +5000 тг/чел, от 2млн +40000 тг/чел\nФикс: Асель 14000, Зарина 14000, Луиза 14000\n\nПо-русски. Прямо, с цифрами.';
}

async function downloadTelegramFile(fileId) {
  const fileInfo = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + fileId, method: 'GET' }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject); req.end();
  });
  const fileData = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: '/file/bot' + TELEGRAM_TOKEN + '/' + fileInfo.result.file_path, method: 'GET' }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end();
  });
  return fileData.toString('base64');
}

async function readPhotoWithClaude(base64Image, photoType) {
  let prompt = photoType === 'zreport'
    ? 'Это Z-отчет из ROSTA. Верни ТОЛЬКО JSON: {"kaspi_qr":0,"online_kaspi":0,"halyk_qr":0,"online_halyk":0,"cash":0,"personal":0,"bonus":0,"ret_kaspi":0,"ret_halyk":0,"ret_cash":0}'
    : photoType === 'kaspi_terminal' ? 'Это отчет Kaspi терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}'
    : photoType === 'halyk_terminal' ? 'Это отчет Halyk терминала. Верни ТОЛЬКО JSON: {"gross":0,"returns":0,"net":0}'
    : 'Опиши документ. Извлеки все числовые данные по продажам и кассе.';
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
      { type: 'text', text: prompt }
    ]}]
  });
  return response.content[0].text;
}

function detectPhotoType(conversation) {
  const last = conversation.slice(-6).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).toLowerCase()).join(' ');
  if (last.includes('z-отчет') || last.includes('rosta') || last.includes('роста')) return 'zreport';
  if (last.includes('kaspi терминал') || last.includes('терминал kaspi')) return 'kaspi_terminal';
  if (last.includes('halyk терминал') || last.includes('терминал halyk')) return 'halyk_terminal';
  return 'unknown';
}

async function handleSystemCommands(reply, userId, sellerName, messageText) {
  let cleanReply = reply;

  if (reply.includes('REMINDER_SAVE:')) {
    try {
      const jsonStr = reply.match(/REMINDER_SAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const r = JSON.parse(jsonStr);
        // Всегда используем реальный userId из webhook, игнорируем user_id из JSON
        await saveReminder(userId, r.text, r.remind_at);
      }
    } catch(e) { console.error('REMINDER_SAVE error:', e.message); }
    cleanReply = reply.replace(/REMINDER_SAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('EXPENSE_DELETE:')) {
    try {
      const deleted = await deleteLastExpense(userId);
      if (deleted) {
        await sendTelegram(userId, '🗑 Удалена запись:\n' + (deleted[0]||'') + ' · ' + (deleted[1]||'') + ' · ' + Number(deleted[2]||0).toLocaleString() + ' тг');
      } else {
        await sendTelegram(userId, '❌ Нет записей для удаления.');
      }
    } catch(e) { console.error('EXPENSE_DELETE error:', e.message); }
    cleanReply = reply.replace(/EXPENSE_DELETE:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('EXPENSE_SAVE:')) {
    try {
      const jsonStr = reply.match(/EXPENSE_SAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const e = JSON.parse(jsonStr);
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
        const month = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', month: 'long' });
        const year = new Date().getFullYear();
        const date = e.date || today;
        await appendSheet('Расходы!A:F', [date, e.category||'Прочее', e.amount||0, e.note||'', month, year], DASHBOARD_ID);
        console.log('Расход записан:', e.category, e.amount);
      }
    } catch(e) { console.error('EXPENSE_SAVE error:', e.message); }
    cleanReply = reply.replace(/EXPENSE_SAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PL_REPORT')) {
    cleanReply = reply.replace(/PL_REPORT/g, '').trim();
    await sendTelegram(userId, '📊 Формирую P&L...');
    const html = await generatePLReport();
    if (html) {
      const filename = 'pl_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
      await sendTelegramDocument(userId, filename, html, '📊 P&L отчёт — открой в браузере');
    } else {
      await sendTelegram(userId, '❌ Не удалось сформировать P&L.');
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('WEEKLY_REPORT')) {
    cleanReply = reply.replace(/WEEKLY_REPORT/g, '').trim();
    await sendWeeklySalesReport();
    if (!cleanReply) return '';
  }

  if (reply.includes('RESEND_REPORT')) {
    cleanReply = reply.replace(/RESEND_REPORT/g, '').trim();
    const report = lastShiftReports[String(userId)];
    if (!report) {
      await sendTelegram(userId, '📋 Отчёт закрытия не найден — смена ещё не закрывалась сегодня.');
    } else {
      const sellerNameLocal = ALLOWED_MAP[String(userId)] || 'Продавец';
      // Отправляем запрос владельцу
      for (const ownerId of OWNER_IDS) {
        pendingResendApprovals[String(ownerId)] = { sellerId: String(userId), sellerName: sellerNameLocal };
        await sendTelegram(ownerId, '📋 ' + sellerNameLocal + ' запрашивает повторную отправку отчёта закрытия смены.\n\nОтветь ДА чтобы отправить или НЕТ чтобы отказать.');
      }
      await sendTelegram(userId, '⏳ Запрос отправлен руководителю. Ожидай разрешения.');
    }
    if (!cleanReply) return '';
  }

  // Обработка выбора типа расхода (1 = NANE, 2 = Личный)
  if (OWNER_IDS.includes(String(userId)) && pendingExpense[String(userId)]) {
    const choice = (messageText || '').trim();
    if (choice === '1' || choice === '2') {
      const exp = pendingExpense[String(userId)];
      delete pendingExpense[String(userId)];
      const isNane = choice === '1';
      const category = detectCategory(exp.description);

      try {
        if (isNane) {
          // Пишем в Google Sheets лист Расходы: A=Дата, B=Категория, C=Сумма, D=Примечание, E=Месяц, F=Год
          const expMonth = exp.date.split('.')[1] || '';
          const expYear  = exp.date.split('.')[2] || '';
          await dbSaveExpense(exp.date, category, exp.amount, exp.description, false, userId);
          await sendTelegram(userId, '✅ Записано в NANE PARIS\n📁 ' + category + '\n💸 ' + Number(exp.amount).toLocaleString('ru-RU') + ' тг — ' + exp.description);
        } else {
          // Пишем в Supabase personal_expenses
          await dbSaveExpense(exp.date, category, exp.amount, exp.description, true, userId);
          await sendTelegram(userId, '✅ Записано в личные расходы\n📁 ' + category + '\n💸 ' + Number(exp.amount).toLocaleString('ru-RU') + ' тг — ' + exp.description);
        }
      } catch(e) { console.error('expense save error:', e.message); }
      return '';
    }
  }

  // Обработка ДА/НЕТ от владельца на удаление предоплаты
  if (OWNER_IDS.includes(String(userId)) && pendingPrepayDelete[String(userId)]) {
    const msgLower2 = (messageText||'').toLowerCase().trim();
    if (msgLower2 === 'да' || msgLower2 === 'yes') {
      const { sellerId, sellerName: sName, prepayId } = pendingPrepayDelete[String(userId)];
      delete pendingPrepayDelete[String(userId)];
      try {
        // Удаляем из Supabase по prep_id
        const { error } = await supabase.from('prepayments')
          .delete().ilike('prep_id', prepayId);
        if (!error) {
          await sendTelegram(userId, '✅ Предоплата удалена.');
          await sendTelegram(sellerId, '✅ Руководитель подтвердил — предоплата удалена.');
        } else {
          await sendTelegram(userId, '❌ Ошибка удаления: ' + error.message);
        }
      } catch(e) { console.error('prepay delete confirm error:', e.message); }
      return '';
    } else if (msgLower2 === 'нет' || msgLower2 === 'no') {
      const { sellerId, prepayId } = pendingPrepayDelete[String(userId)];
      delete pendingPrepayDelete[String(userId)];
      await sendTelegram(sellerId, '❌ Руководитель отказал в удалении предоплаты ' + prepayId + '.');
      await sendTelegram(userId, '❌ Удаление отменено.');
      return '';
    }
  }

  // Обработка ДА/НЕТ от владельца на запрос повторной отправки отчёта
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
        await sendTelegram(sellerId, '✅ Руководитель разрешил — отчёт отправлен повторно.');
      }
      return '';
    } else if (msgLower === 'нет' || msgLower === 'no') {
      const { sellerId, sellerName: sName } = pendingResendApprovals[String(userId)];
      delete pendingResendApprovals[String(userId)];
      await sendTelegram(sellerId, '❌ Руководитель не разрешил повторную отправку отчёта.');
      await sendTelegram(userId, '❌ Отказано в повторной отправке для ' + sName + '.');
      return '';
    }
  }

  if (reply.includes('DIGEST_NOW')) {
    cleanReply = reply.replace(/DIGEST_NOW/g, '').trim();
    await sendMorningDigest();
    if (!cleanReply) return '';
  }

  if (reply.includes('DASHBOARD_HTML')) {
    cleanReply = reply.replace(/DASHBOARD_HTML/g, '').trim();
    await sendTelegram(userId, '📊 Читаю дашборд...');
    const html = await generateDashboardHTML();
    if (html) {
      const filename = 'dashboard_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
      await sendTelegramDocument(userId, filename, html, '📊 Дашборд NANÉ PARIS — открой в браузере');
    } else {
      await sendTelegram(userId, '❌ Не удалось загрузить данные дашборда.');
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
      const header = (type === 'open' ? '📋 Открытые предоплаты: ' + list.length + ' шт' : '📋 Закрытые предоплаты: ' + list.length + ' шт') +
        (totalDebt > 0 ? '\n💰 Общий долг: ' + Number(totalDebt).toLocaleString() + ' тг' : '') + '\n\n';
      for (let i = 0; i < list.length; i += 8) {
        let msg = i === 0 ? header : '📋 ...продолжение:\n\n';
        list.slice(i, i + 8).forEach((p, num) => {
          const isClosed = p.status.includes('закрыт');
          const icon = isClosed ? '✅' : '🟡';
          const total = (p.amount||0) + (p.balance||0);
          msg += icon + ' №' + (i + num + 1) + '\n';
          msg += '👤 ' + p.client + '\n';
          if (p.id) msg += '🆔 ' + p.id + ' · ' + p.date + '\n';
          if (p.phone) msg += '📞 ' + p.phone + '\n';
          if (p.items && p.items.length) msg += '👗 ' + p.items.join(', ') + '\n';
          msg += '\n';
          if (total > 0) msg += '💵 Цена товара:    ' + Number(total).toLocaleString() + ' тг\n';
          msg += '💰 Аванс:          ' + Number(p.amount).toLocaleString() + ' тг\n';
          if (p.balance > 0) msg += '⚠️ Долг к доплате: ' + Number(p.balance).toLocaleString() + ' тг\n';
          else msg += '✅ Оплачено полностью\n';
          msg += '💳 ' + p.channel + '\n';
          msg += '─────────────────────\n';
        });
        await sendTelegram(userId, msg);
      }
      const htmlContent = generatePrepaysHTML(list, type);
      const filename = (type === 'open' ? 'prepays_open' : 'prepays_closed') + '_' + new Date().toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
      await sendTelegramDocument(userId, filename, htmlContent, '📋 Красивые карточки — открой в браузере');
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
        for (const row of rows) {
          if (String(row.prep_id).trim().toUpperCase() === String(p.id).trim().toUpperCase()) {
            await supabase.from('prepayments').update({ status: '🟢 Закрыта', notes: p.notes||'Товар выдан' }).eq('prep_id', row.prep_id);
            break;
          }
        }
      }
    } catch(e) {}
    cleanReply = reply.replace(/PREPAY_CLOSE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('PREPAY_DELETE:')) {
    try {
      const jsonStr = reply.match(/PREPAY_DELETE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        // Находим строку — по ID или по имени клиента
        const findPrepayRow = async (searchStr) => {
          const rows = await dbGetPrepays('all');
          const search = String(searchStr).trim().toLowerCase();
          for (const row of rows) {
            const rowId = String(row.prep_id || '').trim().toUpperCase();
            const rowClient = String(row.client_name || '').trim().toLowerCase();
            if (rowId === search.toUpperCase() || rowClient.includes(search)) {
              return { id: row.prep_id, client: row.client_name, supabaseId: row.id };
            }
          }
          return null;
        };

        if (OWNER_IDS.includes(String(userId))) {
          // Владелец удаляет сам через Supabase
          const found = await findPrepayRow(p.id);
          if (found) {
            await supabase.from('prepayments').delete().eq('id', found.supabaseId);
            console.log('Предоплата удалена:', found.id, found.client);
          } else {
            await sendTelegram(userId, '❌ Предоплата не найдена: ' + p.id);
          }
        } else {
          // Продавец — находим предоплату и отправляем запрос владельцу
          const found = await findPrepayRow(p.id);
          const displayId = found ? found.id + ' (' + found.client + ')' : p.id;
          const sellerNameLocal = ALLOWED_MAP[String(userId)] || 'Продавец';
          if (!found) {
            await sendTelegram(userId, '❌ Предоплата не найдена: ' + p.id + '. Проверь имя или ID.');
          } else {
            for (const ownerId of OWNER_IDS) {
              pendingPrepayDelete[String(ownerId)] = {
                sellerId: String(userId),
                sellerName: sellerNameLocal,
                prepayId: found.id,
                rowNum: found.rowNum,
                reason: p.reason || ''
              };
              await sendTelegram(ownerId,
                '🗑 Запрос на удаление предоплаты\n\n' +
                '👤 Продавец: ' + sellerNameLocal + '\n' +
                '🆔 ' + found.id + ' — ' + found.client + '\n' +
                (p.reason ? '📝 Причина: ' + p.reason + '\n' : '') +
                '\nОтветь ДА чтобы удалить или НЕТ чтобы отказать.'
              );
            }
            await sendTelegram(userId, '⏳ Запрос на удаление предоплаты ' + found.client + ' отправлен руководителю.');
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

        // ── Проверка остатка кассы от предыдущей смены ──────────────
        const lastCash = await loadLastCash();
        const cashOpen = parseFloat(s.cashOpen) || 0;
        console.log('SHIFT_OPEN проверка кассы: cashOpen=', cashOpen, 'lastCash=', lastCash);
        if (lastCash !== null && lastCash > 0) {
          const cashDiff = cashOpen - lastCash;
          console.log('Разница кассы:', cashDiff);
          if (Math.abs(cashDiff) > 500) {
            const direction = cashDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            const sign = cashDiff > 0 ? '+' : '';

            // Алерт владельцу
            for (const ownerId of OWNER_IDS) {
              await sendTelegram(ownerId,
                '🚨 РАСХОЖДЕНИЕ КАССЫ при открытии!\n' +
                '👤 ' + s.seller + ' · ' + getTime() + '\n\n' +
                '💰 Закрыли прошлый раз: ' + Number(lastCash).toLocaleString() + ' тг\n' +
                '💰 Открыли сейчас: ' + Number(cashOpen).toLocaleString() + ' тг\n' +
                '❌ ' + direction + ': ' + sign + Number(cashDiff).toLocaleString() + ' тг\n\n' +
                'Ожидаю объяснение от продавца.'
              );
            }

            // Продавцу — смена открыта НО нужно объяснение
            await sendTelegram(userId,
              '⚠️ РАСХОЖДЕНИЕ КАССЫ!\n\n' +
              '💰 Остаток прошлой смены: ' + Number(lastCash).toLocaleString() + ' тг\n' +
              '💰 Ты пересчитала: ' + Number(cashOpen).toLocaleString() + ' тг\n' +
              '❌ ' + direction + ': ' + sign + Number(cashDiff).toLocaleString() + ' тг\n\n' +
              'Смена открыта, но объясни причину расхождения — откуда разница?\n' +
              'Варианты: инкассация была? расходы из кассы? ошибка счёта?'
            );
          } else {
            console.log('Касса в норме, расхождение в пределах 500 тг');
          }
        } else {
          console.log('lastCash null или 0 — пропускаем проверку');
        }

        const shiftData = { seller: s.seller, shop: s.shop, cash_open: s.cashOpen, start_time: new Date().toISOString() };
        openShifts[String(userId)] = shiftData;
        await saveOpenShift(userId, shiftData);
        clearChecklistTimer(userId); // Чек-лист закрыт — таймер отменяем
        const timeStr = getTime();
        const hour = parseInt(timeStr.split(':')[0]);
        const min = parseInt(timeStr.split(':')[1]);
        if (hour > 11 || (hour === 11 && min > 0)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + s.seller + '\n🕐 ' + timeStr);
        }
        if ((s.cashOpen||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ — касса\nНаличных: ' + Number(s.cashOpen).toLocaleString() + ' тг\n👤 ' + s.seller);
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
        const rostaTotal = (s.rKaspi||0)+(s.rOnline||0)+(s.rHalyk||0)+(s.rHalykOnline||0)+(s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0)-(s.rRetKaspi||0)-(s.rRetHalyk||0)-(s.rRetCash||0);
        const kaspiNet = (s.tKaspi||0)-(s.tKaspiRet||0);
        const halykNet = (s.tHalyk||0)-(s.tHalykRet||0);
        const cashSales = (s.cashActual||0)-(s.cashOpen||0)+(s.cashPayouts||0)+(s.inkasso||0)+(s.rRetCash||0);
        const factTotal = kaspiNet + halykNet + cashSales + (s.rPersonal||0) + (s.rBonus||0);
        const diff = factTotal - rostaTotal;
        const totalRet = (s.rRetKaspi||0)+(s.rRetHalyk||0)+(s.rRetCash||0);

        // ── Жёсткая проверка по каждому каналу ──────────────────────
        const channelDiffs = [];
        const kaspiDiff = kaspiNet - ((s.rKaspi||0)+(s.rOnline||0));
        const halykDiff = halykNet - ((s.rHalyk||0)+(s.rHalykOnline||0));
        const cashDiff = cashSales - (s.rCash||0);

        if (Math.abs(kaspiDiff) > 500) channelDiffs.push({ channel: 'Kaspi', diff: kaspiDiff, rosta: (s.rKaspi||0)+(s.rOnline||0), fact: kaspiNet });
        if (Math.abs(halykDiff) > 500) channelDiffs.push({ channel: 'Halyk', diff: halykDiff, rosta: (s.rHalyk||0)+(s.rHalykOnline||0), fact: halykNet });
        if (Math.abs(cashDiff) > 500) channelDiffs.push({ channel: 'Наличные', diff: cashDiff, rosta: s.rCash||0, fact: cashSales });

        // ── Проверяем закрытые сегодня предоплаты ───────────────────
        const todayShort = today; // формат DD.MM.YYYY
        const allPrepays = await readSheet('Предоплаты!A:K');
        const todayClosedPrepays = allPrepays.slice(1).filter(r => {
          const closeDate = String(r[9]||'').trim();
          const status = String(r[8]||'').toLowerCase();
          return status.includes('закрыт') && (closeDate === todayShort || closeDate === new Date().toISOString().split('T')[0]);
        }).map(r => ({
          id: String(r[0]||''),
          client: String(r[2]||''),
          amount: parseFloat(String(r[6]||'0').replace(/[^0-9.]/g,'')) || 0,
          channel: String(r[5]||''),
          note: String(r[10]||'')
        }));

        // Сопоставляем предоплаты с расхождениями
        const prepayExplanations = [];
        const explainedDiffs = new Set();

        channelDiffs.forEach(cd => {
          if (cd.diff > 0) { // излишек — ищем предоплату на эту сумму
            const matching = todayClosedPrepays.filter(p => {
              const channelMatch =
                (cd.channel === 'Kaspi' && (p.channel.toLowerCase().includes('kaspi') || p.channel.toLowerCase().includes('каспи'))) ||
                (cd.channel === 'Halyk' && (p.channel.toLowerCase().includes('halyk') || p.channel.toLowerCase().includes('халык'))) ||
                (cd.channel === 'Наличные' && (p.channel.toLowerCase().includes('нал') || p.channel.toLowerCase().includes('cash')));
              const amountMatch = Math.abs(p.amount - Math.abs(cd.diff)) < 1000;
              return channelMatch || amountMatch;
            });
            if (matching.length > 0) {
              prepayExplanations.push({ channel: cd.channel, diff: cd.diff, prepays: matching });
              explainedDiffs.add(cd.channel);
            }
          }
        });

        // Если есть необъяснённые расхождения — БЛОКИРУЕМ закрытие
        const unexplainedDiffs = channelDiffs.filter(cd => !explainedDiffs.has(cd.channel));
        const hasNotes = s.notes && s.notes.trim().length > 10;
        const hasAutoExplanation = prepayExplanations.length > 0;

        // Формируем автообъяснение через предоплаты
        let autoNotes = s.notes || '';
        if (hasAutoExplanation) {
          prepayExplanations.forEach(pe => {
            const prepayNames = pe.prepays.map(p => p.client + ' ' + Number(p.amount).toLocaleString() + ' тг').join(', ');
            autoNotes += (autoNotes ? '; ' : '') + pe.channel + ': предоплата ' + prepayNames;
          });
        }

        if (unexplainedDiffs.length > 0 && !hasNotes && !hasAutoExplanation) {
          // Формируем детальное сообщение с требованием объяснения
          let blockMsg = '🚫 СМЕНА НЕ ЗАКРЫТА — есть необъяснённые расхождения!\n\n';
          unexplainedDiffs.forEach(cd => {
            const sign = cd.diff > 0 ? '+' : '';
            const direction = cd.diff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            blockMsg += '❌ ' + cd.channel + ': ' + direction + ' ' + sign + Number(cd.diff).toLocaleString() + ' тг\n';
            blockMsg += '   ROSTA: ' + Number(cd.rosta).toLocaleString() + ' тг\n';
            blockMsg += '   ФАКТ: ' + Number(cd.fact).toLocaleString() + ' тг\n\n';
          });
          blockMsg += 'Объясни причину каждого расхождения:\n';
          blockMsg += '• Наличные — была выдача? расходы? сдача? забрали раньше?\n';
          blockMsg += '• Kaspi/Halyk — отмена операции? задержка зачисления?\n\n';
          blockMsg += 'Пока не объяснишь — смену не закрою. Пиши объяснение.';

          await sendTelegram(userId, blockMsg);

          let ownerAlert = '⚠️ РАСХОЖДЕНИЕ при закрытии смены!\n👤 ' + (shift.seller || sellerName) + ' · ' + today + '\n\n';
          unexplainedDiffs.forEach(cd => {
            const sign = cd.diff > 0 ? '+' : '';
            ownerAlert += cd.channel + ': ' + sign + Number(cd.diff).toLocaleString() + ' тг\n';
          });
          ownerAlert += '\nОбщее расхождение: ' + (diff > 0 ? '+' : '') + Number(diff).toLocaleString() + ' тг\nЖду объяснения от продавца.';
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, ownerAlert);

          // Не закрываем смену — выходим
          cleanReply = reply.replace(/SHIFT_CLOSE:\{.*?\}/s, '').trim();
          return cleanReply || '';
        }

        // ── Всё ок или есть объяснение — закрываем ──────────────────
        const sellerFinal = shift.seller || sellerName;
        const finalNotes = autoNotes || s.notes || '';

        // Алерт владельцу если есть предоплаты объясняющие расхождение
        if (hasAutoExplanation) {
          for (const ownerId of OWNER_IDS) {
            let prepayMsg = '✅ Расхождение при закрытии объяснено предоплатами:\n👤 ' + sellerFinal + ' · ' + today + '\n\n';
            prepayExplanations.forEach(pe => {
              prepayMsg += '💳 ' + pe.channel + ': ' + (pe.diff > 0 ? '+' : '') + Number(pe.diff).toLocaleString() + ' тг\n';
              pe.prepays.forEach(p => {
                prepayMsg += '   → Предоплата: ' + p.client + ' — ' + Number(p.amount).toLocaleString() + ' тг\n';
              });
            });
            await sendTelegram(ownerId, prepayMsg);
          }
        }

        await appendSheet('Смены!A:Y', [
          today, sellerFinal, shift.shop||'',
          s.rKaspi||0, s.rOnline||0, s.rHalyk||0, s.rHalykOnline||0,
          s.rCash||0, s.rPersonal||0, s.rBonus||0,
          s.rRetKaspi||0, s.rRetHalyk||0,
          s.inkasso||0, s.cashPayouts||0, s.cashOpen||0, s.cashActual||0,
          s.tKaspi||0, s.tHalyk||0, s.rPersonal||0,
          rostaTotal, factTotal, diff,
          diff===0 ? 'Корректно' : Math.abs(diff)<500 ? 'Незначительное' : (hasAutoExplanation ? 'Предоплата' : 'Расхождение (объяснено)'),
          finalNotes, getNow()
        ]);

        console.log('Сохраняю продажи в Supabase: дата=', today, 'оборот=', rostaTotal);
        await dbSaveSale(today, rostaTotal, sellerFinal, '');
        console.log('dbSaveSale завершена');

        if ((s.cashActual||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ ИНКАССАЦИИ\nНаличных: ' + Number(s.cashActual).toLocaleString() + ' тг\n👤 ' + sellerFinal);
        }

        const htmlReport = generateShiftHTML({ sellerName: sellerFinal, date: today, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs, prepayExplanations });
        const filename = 'otchet_' + today.replace(/\./g,'_') + '_' + sellerFinal + '.html';

        // Сохраняем последний отчёт для возможной повторной отправки
        lastShiftReports[String(userId)] = { html: htmlReport, filename, caption: '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime };
        await saveLastReport(userId, htmlReport, filename, '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime);
        for (const ownerId of OWNER_IDS) {
          await sendTelegramDocument(ownerId, filename, htmlReport, '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime);
        }

        // ── Командный отчёт дня — отправляем всем продавцам ──────────
        const teamFilename = 'den_' + today.replace(/\./g,'_') + '.html';
        for (const [sellerId, sellerName2] of Object.entries(ALLOWED_MAP)) {
          if (!OWNER_IDS.includes(sellerId)) {
            await sendTelegramDocument(sellerId, teamFilename, htmlReport, '📊 Итоги дня ' + today + ' — открой в браузере');
          }
        }

        delete openShifts[String(userId)];
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
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ\nНаличных: ' + Number(a.amount).toLocaleString() + ' тг\n👤 ' + sellerName + '\n🕐 ' + getTime());
      }
    } catch(e) {}
    cleanReply = reply.replace(/CASH_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('LATE_ALERT:')) {
    try {
      const jsonStr = reply.match(/LATE_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const timeStr = a.time || getTime();

        // Записываем опоздание в лист "Дисциплина"
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
        await dbSaveDiscipline(today, a.seller, 'Опоздание', timeStr, 'Открытие смены позже 11:00');

        // Считаем опоздания за текущий месяц
        const monthStr = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', month: '2-digit', year: 'numeric' });
        const discRows = await readSheet('Дисциплина!A:E', DASHBOARD_ID);
        const lateCount = discRows.filter(r =>
          r[1] === a.seller &&
          r[2] === 'Опоздание' &&
          String(r[0]||'').includes(monthStr.split('.')[0] + '.' + monthStr.split('.')[1])
        ).length;

        // Алерт владельцу
        let alertMsg = '⚠️ Опоздание!\n👤 ' + a.seller + '\n🕐 ' + timeStr + '\n📅 ' + today;
        alertMsg += '\n\nОпозданий за месяц: ' + lateCount;

        // При 3-м опоздании — расширенный алерт
        if (lateCount >= 3) {
          const history = discRows.filter(r =>
            r[1] === a.seller &&
            r[2] === 'Опоздание' &&
            String(r[0]||'').includes(monthStr.split('.')[0] + '.' + monthStr.split('.')[1])
          ).slice(-5);
          alertMsg = '🚨 ' + a.seller + ' — ' + lateCount + '-е опоздание за месяц!\n\n';
          alertMsg += 'История опозданий:\n';
          history.forEach(r => { alertMsg += '• ' + r[0] + ' в ' + r[3] + '\n'; });
          alertMsg += '\nРекомендую провести разговор с продавцом.';
        }

        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, alertMsg);
      }
    } catch(e) { console.error('LATE_ALERT error:', e.message); }
    cleanReply = reply.replace(/LATE_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('CHECKLIST_TIMEOUT:')) {
    try {
      const jsonStr = reply.match(/CHECKLIST_TIMEOUT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
        await dbSaveDiscipline(today, a.seller, 'Таймаут чек-листа', getTime(), 'Чек-лист не закрыт за 15 минут');
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId, '⚠️ Чек-лист не закрыт!\n👤 ' + a.seller + '\n🕐 Начала в ' + a.startTime + ', прошло 15 минут\n📋 Незакрыто: ' + (a.remaining || 'неизвестно'));
        }
      }
    } catch(e) {}
    cleanReply = reply.replace(/CHECKLIST_TIMEOUT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('TERMINAL_ALERT:')) {
    try {
      const jsonStr = reply.match(/TERMINAL_ALERT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Терминал не работает\n👤 ' + a.seller + '\n💳 ' + a.terminal + '\n📝 ' + a.reason);
      }
    } catch(e) {}
    cleanReply = reply.replace(/TERMINAL_ALERT:\{.*?\}/s, '').trim();
  }

  if (reply.includes('INKASSO_CHECK:')) {
    try {
      const jsonStr = reply.match(/INKASSO_CHECK:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const inkDiff = Math.abs((parseFloat(a.sellerAmount)||0)-(parseFloat(a.ownerAmount)||0));
        if (inkDiff > 500) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '🚨 РАСХОЖДЕНИЕ ИНКАССАЦИИ!\nЕрмек: ' + Number(a.ownerAmount).toLocaleString() + ' тг\nПродавец: ' + Number(a.sellerAmount).toLocaleString() + ' тг\nРасхождение: ' + Number(inkDiff).toLocaleString() + ' тг');
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
        await appendSheet('Логи!A:F', [getNow(), 'Инкассация', 'Владелец', '', 'Инкассация: ' + a.amount + ' тг', '']);
      }
    } catch(e) {}
    cleanReply = reply.replace(/OWNER_INKASSO:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SECOND_ARRIVE:')) {
    try {
      const jsonStr = reply.match(/SECOND_ARRIVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const timeStr = a.time || getTime();
        const hour = parseInt(timeStr.split(':')[0]);
        const min = parseInt(timeStr.split(':')[1]);
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId, '✅ Второй продавец на месте\n👤 ' + a.seller + '\n🕐 ' + timeStr);
        }
        if (hour > 11 || (hour === 11 && min > 15)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + a.seller + '\n🕐 ' + timeStr);
        }
        await appendSheet('Логи!A:F', [getNow(), 'Приход', a.seller, String(userId), 'Второй продавец пришёл в ' + timeStr, '']);
      }
    } catch(e) {}
    cleanReply = reply.replace(/SECOND_ARRIVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SECOND_LEAVE:')) {
    try {
      const jsonStr = reply.match(/SECOND_LEAVE:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const a = JSON.parse(jsonStr);
        const timeStr = a.time || getTime();
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId, '👋 Второй продавец ушёл\n👤 ' + a.seller + '\n🕐 ' + timeStr);
        }
        await appendSheet('Логи!A:F', [getNow(), 'Уход', a.seller, String(userId), 'Второй продавец ушёл в ' + timeStr, '']);
      }
    } catch(e) {}
    cleanReply = reply.replace(/SECOND_LEAVE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('EXPENSE_NEW:')) {
    try {
      const jsonStr = reply.match(/EXPENSE_NEW:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const e = JSON.parse(jsonStr);
        // Сохраняем в pending и спрашиваем тип
        const expDate = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric' });
        pendingExpense[String(userId)] = {
          amount: e.amount,
          description: e.description,
          date: expDate,  // дата берётся из системы, не из Claude
          time: getTime()
        };
        await sendTelegram(userId,
          '💸 Расход: ' + e.description + ' — ' + Number(e.amount).toLocaleString('ru-RU') + ' тг\n\n' +
          'Куда записать?\n\n' +
          '1. NANE PARIS\n' +
          '2. Личный'
        );
      }
    } catch(e2) { console.error('EXPENSE_NEW error:', e2.message); }
    cleanReply = reply.replace(/EXPENSE_NEW:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('EXPENSE_LIST:')) {
    try {
      const jsonStr = reply.match(/EXPENSE_LIST:(\{.*?\})/s)?.[1];
      const period = jsonStr ? JSON.parse(jsonStr).period : 'month';

      // Читаем NANE расходы из Google Sheets
      const naneRows = await readSheet('Расходы!A:E', SPREADSHEET_ID);
      // Читаем личные расходы из Supabase
      const { data: personalRows } = await supabase
        .from('personal_expenses')
        .select('*')
        .eq('user_id', String(userId))
        .order('created_at', { ascending: false })
        .limit(200);

      // Фильтр по периоду
      const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      const monthStart = nowAlm.getMonth() + 1;
      const yearNow = nowAlm.getFullYear();
      const weekAgo = new Date(nowAlm); weekAgo.setDate(nowAlm.getDate() - 7);

      // Парсим NANE расходы (формат даты DD.MM.YYYY)
      const naneExpenses = (naneRows || []).slice(2).filter(r => r[0] && r[2]).map(r => ({
        date: r[0], category: r[1] || 'Прочее',
        amount: Number(String(r[2]).replace(/[^0-9.]/g,'')),
        description: r[3] || r[1] || '', type: 'NANE'
      })).filter(e => {
        const parts = String(e.date).split('.');
        if (parts.length < 3) return false;
        const m = parseInt(parts[1]), y = parseInt(parts[2]);
        if (period === 'week') {
          const d = new Date(y, m-1, parseInt(parts[0]));
          return d >= weekAgo;
        }
        return m === monthStart && y === yearNow;
      });

      // Парсим личные расходы
      const personalExpenses = (personalRows || []).filter(e => {
        const d = new Date(e.created_at);
        if (period === 'week') return d >= weekAgo;
        return d.getMonth()+1 === monthStart && d.getFullYear() === yearNow;
      }).map(e => ({
        date: e.expense_date || '', description: e.description || '',
        amount: Number(e.amount), category: e.category || 'Прочее', type: 'Личный'
      }));

      const allExpenses = [...naneExpenses, ...personalExpenses];

      if (allExpenses.length === 0) {
        await sendTelegram(userId, '📊 Расходов за ' + (period === 'week' ? 'неделю' : 'этот месяц') + ' пока нет.');
      } else {
        const periodLabel = period === 'week' ? 'неделю' : 'месяц';
        let naneTotal = 0, personalTotal = 0;

        // NANE расходы по категориям
        const naneBycat = {};
        naneExpenses.forEach(e => {
          if (!naneBycat[e.category]) naneBycat[e.category] = { sum: 0, items: [] };
          naneBycat[e.category].sum += e.amount;
          naneBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
          naneTotal += e.amount;
        });

        // Личные расходы по категориям
        const persBycat = {};
        personalExpenses.forEach(e => {
          if (!persBycat[e.category]) persBycat[e.category] = { sum: 0, items: [] };
          persBycat[e.category].sum += e.amount;
          persBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
          personalTotal += e.amount;
        });

        let msg = '📊 Расходы за ' + periodLabel + '\n\n';

        if (naneExpenses.length > 0) {
          msg += '🏪 NANE PARIS: ' + naneTotal.toLocaleString('ru-RU') + ' тг\n';
          Object.entries(naneBycat).forEach(([cat, data]) => {
            msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
            data.items.slice(0, 3).forEach(i => { msg += '    · ' + i + '\n'; });
          });
          msg += '\n';
        }

        if (personalExpenses.length > 0) {
          msg += '👤 Личные: ' + personalTotal.toLocaleString('ru-RU') + ' тг\n';
          Object.entries(persBycat).forEach(([cat, data]) => {
            msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
            data.items.slice(0, 3).forEach(i => { msg += '    · ' + i + '\n'; });
          });
          msg += '\n';
        }

        msg += '💰 Всего: ' + (naneTotal + personalTotal).toLocaleString('ru-RU') + ' тг';
        await sendTelegram(userId, msg);
      }
    } catch(e2) { console.error('EXPENSE_LIST error:', e2.message); }
    cleanReply = reply.replace(/EXPENSE_LIST:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_PAUSE')) {
    trainingPaused = true;
    cleanReply = reply.replace(/TRAINING_PAUSE/g, '').trim();
    for (const ownerId of OWNER_IDS) {
      await sendTelegram(ownerId, '⏸ Автоматическое обучение поставлено на паузу.\nПродавцы не получат уроки и тесты до возобновления.\nЧтобы возобновить — напиши «Возобнови обучение».');
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_RESUME')) {
    trainingPaused = false;
    cleanReply = reply.replace(/TRAINING_RESUME/g, '').trim();
    for (const ownerId of OWNER_IDS) {
      await sendTelegram(ownerId, '▶️ Автоматическое обучение возобновлено.\nУроки будут отправляться по расписанию (пн 12:00) и тесты (пт 12:00).');
    }
    if (!cleanReply) return '';
  }

  if (reply.includes('LESSON_CONFIRMED')) {
    try {
      const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = getTime();
      // Фиксируем прохождение урока
      trainingCompleted[String(userId)] = {
        ...(trainingCompleted[String(userId)] || {}),
        lesson: true,
        date: today
      };
      // Записываем в Дисциплина
      await appendSheet('Дисциплина!A:E', [
        today, sellerName, 'Урок изучен', timeStr, '✅ Выполнено в срок'
      ], DASHBOARD_ID);
      // Уведомляем владельца
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId, '✅ ' + sellerName + ' подтвердила изучение урока · ' + timeStr);
      }
      console.log('LESSON_CONFIRMED:', sellerName, today, timeStr);
    } catch(e) { console.error('LESSON_CONFIRMED error:', e.message); }
    cleanReply = reply.replace(/LESSON_CONFIRMED/g, '').trim();
  }

  if (reply.includes('LESSON_REPEAT')) {
    cleanReply = reply.replace(/LESSON_REPEAT/g, '').trim();
    try {
      const { data } = await supabase.from('last_reports')
        .select('*').eq('user_id', 'training_last_lesson').maybeSingle();
      if (data && data.html) {
        const lesson = JSON.parse(data.html);
        await sendTelegram(userId, lesson.lesson);
      } else {
        await sendTelegram(userId, '📚 Урок пока не проводился. Первый урок придёт в понедельник в 10:00.');
      }
    } catch(e) { console.error('LESSON_REPEAT error:', e.message); }
    if (!cleanReply) return '';
  }

  if (reply.includes('SALARY_CALC:')) {
    try {
      const jsonStr = reply.match(/SALARY_CALC:(\{.*?\})/s)?.[1];
      let month = new Date().getMonth() + 1, year = new Date().getFullYear();
      if (jsonStr) { const p = JSON.parse(jsonStr); if (p.month) month = p.month; if (p.year) year = p.year; }
      await showSalaryReport(userId, month, year);
    } catch(e2) { console.error('SALARY_CALC error:', e2.message); }
    cleanReply = reply.replace(/SALARY_CALC:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('SALES_LIST:')) {
    try {
      const jsonStr = reply.match(/SALES_LIST:(\{.*?\})/s)?.[1];
      let month, year;
      if (jsonStr) {
        const p = JSON.parse(jsonStr);
        month = p.month || (new Date().getMonth() + 1);
        year  = p.year  || new Date().getFullYear();
      } else {
        month = new Date().getMonth() + 1;
        year  = new Date().getFullYear();
      }
      // Если month=0 — текущий месяц
      if (!month || month === 0) month = new Date().getMonth() + 1;
      if (!year  || year  === 0) year  = new Date().getFullYear();

      const sales = await dbGetSales(month, year);
      const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

      if (!sales || sales.length === 0) {
        await sendTelegram(userId, '📈 Продаж за ' + (monthNames[month]||month) + ' ' + year + ' пока нет.');
      } else {
        let total = 0;
        let best = { revenue: 0, date: '' };
        let msg = '📈 Продажи — ' + (monthNames[month]||month) + ' ' + year + '\n\n';
        sales.forEach(s => {
          const d = s.sale_date ? s.sale_date.slice(8,10) + '.' + s.sale_date.slice(5,7) : '?';
          const sellers = [s.seller1, s.seller2].filter(Boolean).join('+');
          msg += d + ': ' + Number(s.revenue).toLocaleString('ru-RU') + ' тг';
          if (sellers) msg += ' · ' + sellers;
          msg += '\n';
          total += Number(s.revenue);
          if (Number(s.revenue) > best.revenue) best = { revenue: Number(s.revenue), date: d };
        });
        msg += '\n📊 Итого: ' + total.toLocaleString('ru-RU') + ' тг';
        if (best.date) msg += '\n🏆 Лучший день: ' + best.date + ' — ' + best.revenue.toLocaleString('ru-RU') + ' тг';
        await sendTelegram(userId, msg);
      }
    } catch(e2) { console.error('SALES_LIST error:', e2.message); }
    cleanReply = reply.replace(/SALES_LIST:\{.*?\}/s, '').trim();
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_NOW')) {
    cleanReply = reply.replace(/TRAINING_NOW/g, '').trim();
    await sendTelegram(userId, '📚 Запускаю обучение для продавцов...');
    await sendWeeklyTraining(true);
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_STATS')) {
    cleanReply = reply.replace(/TRAINING_STATS/g, '').trim();
    try {
      const discRows = await readSheet('Дисциплина!A:E', DASHBOARD_ID);
      const trainRows = (discRows || []).filter(r => r[2] && String(r[2]).startsWith('Обучение:'));
      if (trainRows.length === 0) {
        await sendTelegram(userId, '📚 Результатов обучения пока нет.');
      } else {
        let msg = '📚 СТАТИСТИКА ОБУЧЕНИЯ\n\n';
        const bySeller = {};
        trainRows.forEach(r => {
          const name = r[1] || '?';
          if (!bySeller[name]) bySeller[name] = [];
          bySeller[name].push({ date: r[0], topic: String(r[2]).replace('Обучение: ', ''), result: r[4] });
        });
        Object.entries(bySeller).forEach(([name, results]) => {
          msg += '👤 ' + name + '\n';
          results.slice(-5).forEach(r => {
            msg += '  📖 ' + r.topic + ' · ' + r.result + ' · ' + r.date + '\n';
          });
          msg += '\n';
        });
        await sendTelegram(userId, msg);
      }
    } catch(e) { console.error('TRAINING_STATS error:', e.message); }
    if (!cleanReply) return '';
  }

  if (reply.includes('TRAINING_RESULT:')) {
    try {
      const jsonStr = reply.match(/TRAINING_RESULT:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const t = JSON.parse(jsonStr);
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = getTime();
        const score = parseInt(t.score) || 0;
        const emoji = score >= 3 ? '✅' : score >= 2 ? '⚠️' : '❌';

        // Фиксируем прохождение теста
        trainingCompleted[String(userId)] = {
          ...(trainingCompleted[String(userId)] || {}),
          test: true,
          date: today
        };

        // Записываем в лист Дисциплина (раздел обучения)
        await appendSheet('Дисциплина!A:E', [
          today, t.seller || sellerName, 'Обучение: ' + (t.topic || ''), timeStr,
          'Результат: ' + score + '/3 ' + emoji
        ], DASHBOARD_ID);

        // Алерт владельцу
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId,
            '📚 Обучение завершено\n\n' +
            '👤 ' + (t.seller || sellerName) + '\n' +
            '📖 Тема: ' + (t.topic || 'не указана') + '\n' +
            '🎯 Результат: ' + score + '/3 ' + emoji + '\n' +
            '📅 ' + today + ' · ' + timeStr
          );
        }
        console.log('TRAINING_RESULT:', t.seller, t.topic, score);
      }
    } catch(e) { console.error('TRAINING_RESULT error:', e.message); }
    cleanReply = reply.replace(/TRAINING_RESULT:\{.*?\}/s, '').trim();
  }

  return cleanReply;
}

async function handleMessage(userId, messageText, photoFileId) {
  const senderName = ALLOWED_MAP[String(userId)];
  if (!senderName) { await sendTelegram(userId, '🔒 Доступ закрыт.'); return; }
  const isOwner = OWNER_IDS.includes(String(userId));
  const userKey = String(userId);

  // ── Прямой перехват KPI команд — без Claude ──
  if (OWNER_IDS.includes(String(userId)) && messageText) {
    const msgLK = messageText.toLowerCase().trim();
    const kpiMatch = msgLK.match(/kpi\s+(асель|зарина|луиза)\s+(\d)/i) ||
                     msgLK.match(/(асель|зарина|луиза).*kpi.*(\d)/i) ||
                     msgLK.match(/kpi\s+(\w+)\s+(\d)/i);
    if (kpiMatch) {
      const sellerRaw = kpiMatch[1];
      const score = parseInt(kpiMatch[2]);
      const sellerName = sellerRaw.charAt(0).toUpperCase() + sellerRaw.slice(1).toLowerCase();
      const nowA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
      const kpiMonth = nowA.getMonth() + 1;
      const kpiYear = nowA.getFullYear();
      if (score >= 0 && score <= 3) {
        await saveKPI(sellerName, score, kpiMonth, kpiYear);
        const kpiAmt = score * 25000;
        await sendTelegram(userId,
          '✅ KPI выставлен\n👤 ' + sellerName + '\n' +
          '⭐ ' + score + '/3 метрики\n' +
          '💰 ' + kpiAmt.toLocaleString('ru-RU') + ' тг'
        );
        return;
      }
    }
  }

  // ── Прямой перехват команды зарплаты — без Claude ──
  if (OWNER_IDS.includes(String(userId)) && messageText) {
    const msgLZ = messageText.toLowerCase().trim();
    if (/зарплат|фот|расчёт зп|расчет зп/.test(msgLZ)) {
      const monthNamesZ = {май:5,майя:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let salMonth = new Date().getMonth() + 1;
      let salYear  = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesZ)) {
        if (msgLZ.includes(name)) { salMonth = num; break; }
      }
      await showSalaryReport(userId, salMonth, salYear);
      return;
    }
  }

  // ── Прямой перехват команды продаж — без Claude ──
  if (OWNER_IDS.includes(String(userId)) && messageText) {
    const msgLS = messageText.toLowerCase().trim();
    const monthNames2 = {май:5,майя:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
    if (/продаж|оборот|выручк/.test(msgLS)) {
      let month = new Date().getMonth() + 1, year = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNames2)) {
        if (msgLS.includes(name)) { month = num; break; }
      }
      // Временный вызов через handleSystemCommands
      const fakeSalesReply = 'SALES_LIST:{"month":' + month + ',"year":' + year + '}';
      await handleSystemCommands(fakeSalesReply, userId, ALLOWED_MAP[String(userId)] || 'Руководитель', messageText);
      return;
    }
  }

  // ── Прямой перехват команды расходов — без Claude ──
  if (OWNER_IDS.includes(String(userId)) && messageText) {
    const msgL = messageText.toLowerCase().trim();
    // Любое сообщение со словом "расход" или "затрат" — показываем расходы
    const isExpenseView = /расход|затрат/.test(msgL);
    if (isExpenseView && !/внести|добавить|записать|потратил|трата|расход \d/.test(msgL)) {
      // Определяем месяц
      const monthNamesExp = {май:5,майя:5,мая:5,июнь:6,июня:6,июль:7,июля:7,август:8,сентябрь:9,октябрь:10,ноябрь:11,декабрь:12,январь:1,февраль:2,март:3,апрель:4};
      let expMonth = new Date().getMonth() + 1;
      let expYear  = new Date().getFullYear();
      for (const [name, num] of Object.entries(monthNamesExp)) {
        if (msgL.includes(name)) { expMonth = num; break; }
      }
      const period = /недел/.test(msgL) ? 'week' : 'month';
      await showExpensesByMonth(userId, expMonth, expYear, period);
      return;
    }
  }

  // ── Прямой перехват предоплат для продавцов ──
  if (!isOwner && messageText) {
    const msgLP = messageText.toLowerCase().trim();
    if (/предоплат|prepay/.test(msgLP) && !/новая|создать|добавить|внести/.test(msgLP)) {
      const list = await loadPrepays('open');
      if (list.length === 0) {
        await sendTelegram(userId, '📋 Открытых предоплат нет.');
      } else {
        let msg = '📋 Открытые предоплаты: ' + list.length + '\n\n';
        list.forEach((p, i) => {
          msg += '🟡 №' + (i+1) + ' ' + p.client + '\n';
          if (p.id) msg += '🆔 ' + p.id + '\n';
          if (p.items && p.items.length) msg += '👗 ' + p.items.join(', ') + '\n';
          msg += '💰 Аванс: ' + Number(p.amount).toLocaleString('ru-RU') + ' тг\n\n';
        });
        await sendTelegram(userId, msg);
      }
      return;
    }
  }

  if (!conversations[userKey]) conversations[userKey] = await loadConversation(userId);
  if (!openShifts[userKey]) {
    const dbShift = await loadOpenShift(userId);
    if (dbShift) openShifts[userKey] = dbShift;
  }

  // ── Проверка: смена открыта вчера или раньше — автоматически сбрасываем ──
  if (openShifts[userKey] && openShifts[userKey].start_time) {
    const shiftDate = new Date(openShifts[userKey].start_time);
    const todayStr = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
    const shiftDateStr = shiftDate.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
    if (shiftDateStr !== todayStr) {
      console.log('Смена устарела — открыта', shiftDateStr, ', сегодня', todayStr, '— сбрасываем');
      delete openShifts[userKey];
      await deleteOpenShift(userId);
      // Уведомляем владельца
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId, '⚠️ Смена ' + senderName + ' от ' + shiftDateStr + ' не была закрыта!\nАвтоматически сброшена. Проверь данные.');
      }
    }
  }

  const hasOpenShift = !!openShifts[userKey];
  // Если смена открыта с флагом is_second — продавец является вторым
  const isSecondSellerFromShift = !!(openShifts[userKey] && openShifts[userKey].is_second);
  console.log('handleMessage:', senderName, 'hasOpenShift:', hasOpenShift, 'is_second:', isSecondSellerFromShift, 'shift:', JSON.stringify(openShifts[userKey]));

  // ── Перехват запроса повторной отправки отчёта ───────────────────
  if (!isOwner && !hasOpenShift && messageText) {
    const msgLow = messageText.toLowerCase();
    if (msgLow.includes('повторно') || msgLow.includes('вышли отчёт') || msgLow.includes('вышли html') || msgLow.includes('html файл')) {
      let report = lastShiftReports[userKey];
      if (!report) report = await loadLastReport(userId);
      if (!report) {
        await sendTelegram(userId, '📋 Отчёт закрытия не найден — смена ещё не закрывалась сегодня.');
      } else {
        for (const ownerId of OWNER_IDS) {
          pendingResendApprovals[String(ownerId)] = { sellerId: userKey, sellerName: senderName };
          await sendTelegram(ownerId, '📋 ' + senderName + ' запрашивает повторную отправку отчёта закрытия смены.\n\nОтветь ДА чтобы отправить или НЕТ чтобы отказать.');
        }
        await sendTelegram(userId, '⏳ Запрос отправлен руководителю. Ожидай разрешения.');
      }
      return;
    }
  }
  // но у ДРУГОГО продавца смена уже открыта сегодня
  let isSecondSeller = isSecondSellerFromShift; // читаем из сохранённой смены
  let firstSellerName = '';
  if (!isOwner && !hasOpenShift) {
    // Проверяем память
    for (const [otherId, shiftData] of Object.entries(openShifts)) {
      if (otherId !== userKey && shiftData && shiftData.seller) {
        isSecondSeller = true;
        firstSellerName = shiftData.seller;
        break;
      }
    }
    // Если в памяти нет — проверяем Supabase
    if (!isSecondSeller) {
      try {
        const { data: allShifts } = await supabase.from('open_shifts').select('*').neq('phone', userKey);
        if (allShifts && allShifts.length > 0) {
          isSecondSeller = true;
          firstSellerName = allShifts[0].seller || 'первый продавец';
        }
      } catch(e) {}
    }
  }

  let userContent;
  if (photoFileId) {
    try {
      await sendTelegram(userId, '📷 Читаю фото...');
      const base64 = await downloadTelegramFile(photoFileId);
      const photoType = detectPhotoType(conversations[userKey] || []);
      const ocrResult = await readPhotoWithClaude(base64, photoType);
      let contextText = photoType === 'zreport' ? 'Прочитала Z-отчет ROSTA:\n' + ocrResult
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
      systemPrompt = getSellerPrompt(senderName, 'NANE PARIS Астана', hasOpenShift, isSecondSeller, firstSellerName);
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

    await appendSheet('Логи!A:F', [getNow(), isOwner ? 'Руководитель' : 'Продавец', senderName, String(userId), messageText || '[фото]', cleanReply ? cleanReply.slice(0, 500) : '']);
  } catch(e) {
    console.error('Claude error:', e.message);
    await sendTelegram(userId, 'Произошла ошибка. Попробуй еще раз.');
  }
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
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Попытка не из магазина!\n👤 ' + senderName + '\n📍 ' + distance + ' м\n🕐 ' + getTime());
        }
        return;
      }
      // ── Определяем действие по геолокации ──
      // Проверяем есть ли ДРУГИЕ открытые смены (не наша)
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

      // Если есть другая смена — это второй продавец (его смена уже открыта, геолокация = приход)
      // Если нет других смен — это первый продавец или закрытие
      const ownShift = openShifts[String(userId)] || await loadOpenShift(userId);
      let action;
      if (pendingGeoAction[userId]) {
        action = pendingGeoAction[userId];
      } else if (geoOtherShift && ownShift) {
        // Есть наша смена И чужая — мы второй продавец, геолокация для прихода
        action = 'second_arrive';
      } else if (ownShift) {
        // Есть только наша смена — закрытие
        action = 'close_shift';
      } else {
        action = 'open_shift';
      }
      console.log('GEO DEBUG userId:', userId, 'geoOtherShift:', geoOtherShift, 'ownShift:', !!ownShift, 'action:', action);
      delete pendingGeoAction[userId];

      if (action === 'second_arrive') {
        // ВТОРОЙ ПРОДАВЕЦ — обрабатываем сами без Claude
        const sName = ALLOWED_MAP[String(userId)] || 'Продавец';
        const tStr = getTime();
        for (const ownerId of OWNER_IDS) {
          await sendTelegram(ownerId, '✅ Второй продавец на месте\n👤 ' + sName + '\n🕐 ' + tStr);
        }
        await appendSheet('Логи!A:F', [getNow(), 'Приход', sName, String(userId), 'Второй продавец пришёл в ' + tStr, '']);
        const h = parseInt(tStr.split(':')[0]), m = parseInt(tStr.split(':')[1]);
        if (h > 11 || (h === 11 && m > 15)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + sName + '\n🕐 ' + tStr);
        }
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

      // ── Владелец отвечает ДА/НЕТ на запрос повторного открытия ──
      if (OWNER_IDS.includes(String(userId))) {
        for (const [sellerUserId, approval] of Object.entries(pendingReopenApprovals)) {
          if (approval.waitingForOwner) {
            if (lower === 'да' || lower === 'yes') {
              approval.waitingForOwner = false;
              // Очищаем смену и историю продавца
              delete openShifts[sellerUserId];
              await deleteOpenShift(sellerUserId);
              delete conversations[sellerUserId];
              await supabase.from('conversations').delete().eq('phone', String(sellerUserId));
              clearChecklistTimer(sellerUserId);
              delete pendingReopenApprovals[sellerUserId];
              await sendTelegram(sellerUserId, '✅ Руководитель разрешил повторное открытие смены.\nНапиши "Начала смену" чтобы начать.');
              await sendTelegram(userId, '✅ Разрешение выдано. Смена и история ' + approval.sellerName + ' очищены.');
              return;
            } else if (lower === 'нет' || lower === 'no') {
              approval.waitingForOwner = false;
              delete pendingReopenApprovals[sellerUserId];
              await sendTelegram(sellerUserId, '❌ Руководитель не разрешил повторное открытие смены.\nЕсли есть вопросы — свяжись с руководителем.');
              await sendTelegram(userId, '❌ Отказ отправлен продавцу.');
              return;
            }
          }
        }
      }

      if (lower.includes('начала смену') || lower.includes('открываю смену') || lower.includes('начинаю смену')) {

        // Если уже ждём ответа владельца — не дублируем запрос
        if (pendingReopenApprovals[String(userId)] && pendingReopenApprovals[String(userId)].waitingForOwner) {
          await sendTelegram(userId, '⏳ Запрос уже отправлен руководителю. Ожидай ответа.');
          return;
        }

        // Проверяем — есть ли уже открытая смена у этого продавца
        // Источники: память, Supabase open_shifts, история диалога
        let existingShift = openShifts[String(userId)];
        console.log('REOPEN CHECK: userId=', userId, 'inMemory=', !!existingShift);
        if (!existingShift) {
          const dbShift = await loadOpenShift(userId);
          console.log('REOPEN CHECK: dbShift=', JSON.stringify(dbShift));
          if (dbShift) existingShift = dbShift;
        }
        // Дополнительно: проверяем историю диалога — если есть сообщения сегодня, смена может быть открыта
        if (!existingShift) {
          const history = await loadConversation(userId);
          if (history && history.length > 0) {
            // Есть история — значит продавец уже общалась с Томи сегодня
            // Проверяем последнее сообщение ассистента на признак открытой смены
            const lastMessages = history.slice(-10).map(m => String(m.content || '').toLowerCase()).join(' ');
            if (lastMessages.includes('смена открыта') || lastMessages.includes('shift_open') || lastMessages.includes('удачной работы') || lastMessages.includes('хорошей смены')) {
              existingShift = { time: 'ранее сегодня', fromHistory: true };
              console.log('REOPEN CHECK: found open shift in conversation history');
            }
          }
        }
        console.log('REOPEN CHECK: existingShift=', JSON.stringify(existingShift));

        if (existingShift) {
          const sellerNameLocal = ALLOWED_MAP[String(userId)] || 'Продавец';
          const openedAt = existingShift.time || existingShift.start_time || 'неизвестно';

          // Смена уже открыта — запрашиваем согласование владельца
          pendingReopenApprovals[String(userId)] = {
            sellerName: sellerNameLocal,
            openedAt,
            waitingForOwner: true,
            timestamp: Date.now()
          };

          await sendTelegram(userId, '⚠️ Смена уже открыта сегодня в ' + openedAt + '.\nПовторное открытие требует разрешения руководителя.\nОжидай — я уже отправила запрос.');

          for (const ownerId of OWNER_IDS) {
            await sendTelegram(ownerId,
              '🔐 ЗАПРОС ПОВТОРНОГО ОТКРЫТИЯ СМЕНЫ\n\n' +
              '👤 ' + sellerNameLocal + '\n' +
              '🕐 Смена открыта в ' + openedAt + '\n\n' +
              'Продавец запрашивает повторное открытие.\n\n' +
              'Ответь:\n✅ ДА — разрешить (смена и история будут сброшены)\n❌ НЕТ — отказать\n\n' +
              '⏰ Если не ответишь в течение 10 минут — смена не откроется автоматически.'
            );
          }

          setTimeout(async () => {
            if (pendingReopenApprovals[String(userId)] && pendingReopenApprovals[String(userId)].waitingForOwner) {
              delete pendingReopenApprovals[String(userId)];
              await sendTelegram(userId, '⏰ Руководитель не ответил в течение 10 минут.\nПовторное открытие отклонено. Свяжись с руководителем напрямую.');
              for (const ownerId of OWNER_IDS) {
                await sendTelegram(ownerId, '⏰ Запрос ' + sellerNameLocal + ' на повторное открытие истёк (10 мин без ответа).');
              }
            }
          }, 10 * 60 * 1000);

          return; // СТОП — не передаём в handleMessage
        }

        // Смены нет — очищаем историю и начинаем чисто
        delete conversations[String(userId)];
        try { await supabase.from('conversations').delete().eq('phone', String(userId)); } catch(e) {}

        pendingGeoAction[userId] = 'open_shift';
        const sellerName = ALLOWED_MAP[String(userId)] || 'Продавец';
        startChecklistTimer(userId, sellerName, getTime());

        // Проверяем второго продавца ДО сохранения своей смены
        let isSecondSellerCheck = false;
        // Сначала смотрим в памяти
        for (const [otherId, shiftData] of Object.entries(openShifts)) {
          if (otherId !== String(userId) && shiftData && shiftData.seller) {
            isSecondSellerCheck = true;
            break;
          }
        }
        // Если в памяти нет — проверяем Supabase
        if (!isSecondSellerCheck) {
          try {
            const { data: otherShifts } = await supabase.from('open_shifts').select('*').neq('phone', String(userId));
            if (otherShifts && otherShifts.length > 0) isSecondSellerCheck = true;
          } catch(e) {}
        }

        // Теперь сохраняем свою смену с флагом второго продавца
        await saveOpenShift(userId, { seller: sellerName, shop: 'NANE PARIS', cash_open: 0, start_time: new Date().toISOString(), is_second: isSecondSellerCheck });
        // Также сохраняем в памяти
        openShifts[String(userId)] = { seller: sellerName, shop: 'NANE PARIS', cash_open: 0, start_time: new Date().toISOString(), is_second: isSecondSellerCheck };

        let checklistFirstQ;
        if (isSecondSellerCheck) {
          checklistFirstQ = 'Привет! Ты второй продавец сегодня.\n\nШАГ 0 — Внешний вид: макияж готов? одежда в порядке?';
        } else {
          checklistFirstQ = 'Отлично! Начинаем чек-лист открытия.\n\nШАГ 0 — Внешний вид: макияж готов? одежда в порядке?';
        }

        const checklistStartMsg = isSecondSellerCheck
          ? 'Второй продавец начинает смену. Упрощённый чек-лист: только внешний вид и геолокация. Кассу не спрашивай.'
          : 'Продавец начинает смену. Начинаем чек-лист открытия с шага 0.';

        conversations[String(userId)] = [
          { role: 'user', content: checklistStartMsg },
          { role: 'assistant', content: checklistFirstQ }
        ];
        await saveMessages(userId, checklistStartMsg, checklistFirstQ);

        await sendTelegram(userId, checklistFirstQ);
        return;

      } else if (lower.includes('закрываю смену') || lower.includes('закрытие смены')) {
        pendingGeoAction[userId] = 'close_shift';
      }
    }

    if (!messageText && !photoFileId) return;
    await handleMessage(userId, messageText, photoFileId);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'TOMI NANE PARIS Telegram', version: '4.2' }));

// ══════════════════════════════════════════════════════════════════════
// УТРЕННИЙ ДАЙДЖЕСТ — каждый день в 09:00 по Алматы
// ══════════════════════════════════════════════════════════════════════
// ── Таймер чек-листа — запускается при написании "Начала смену" ──────

function startChecklistTimer(userId, sellerName, startTime) {
  // Очищаем старый таймер если есть
  if (checklistTimers[userId]) {
    clearTimeout(checklistTimers[userId].timeout15);
    clearTimeout(checklistTimers[userId].timeout20);
  }

  const startTimeStr = startTime || getTime();

  // Через 15 минут — первый алерт
  const timeout15 = setTimeout(async () => {
    // Проверяем — смена уже открыта (SHIFT_OPEN выполнен) — значит чек-лист закрыт
    if (openShifts[String(userId)] && openShifts[String(userId)].start_time) {
      const shiftStart = new Date(openShifts[String(userId)].start_time);
      const now = new Date();
      const diffMin = (now - shiftStart) / 60000;
      if (diffMin < 20) return; // смена открылась нормально
    }

    console.log('Таймаут чек-листа 15 мин:', sellerName);
    await sendTelegram(userId, '⏰ ' + sellerName + ', прошло 15 минут — чек-лист ещё не закрыт!\nЗакрой немедленно, иначе уведомлю руководителя.');

    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
    await dbSaveDiscipline(today, sellerName, 'Таймаут чек-листа', getTime(), 'Не закрыт за 15 минут');
    for (const ownerId of OWNER_IDS) {
      await sendTelegram(ownerId, '⚠️ Чек-лист не закрыт за 15 минут!\n👤 ' + sellerName + '\n🕐 Начала в ' + startTimeStr + '\nПродавец получила напоминание.');
    }

    // Через ещё 5 минут — повторный алерт владельцу
    checklistTimers[userId].timeout20 = setTimeout(async () => {
      if (openShifts[String(userId)]) return; // успела закрыть
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId, '🚨 Чек-лист до сих пор не закрыт!\n👤 ' + sellerName + '\n🕐 Прошло 20 минут с начала смены. Требуется вмешательство.');
      }
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

// ── Еженедельная сводка по дисциплине (понедельник 09:00) ─────────────
async function sendWeeklyDisciplineReport() {
  try {
    const discRows = await readSheet('Дисциплина!A:E', DASHBOARD_ID);
    if (!discRows || discRows.length < 2) return;

    // Данные за последние 7 дней
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const weekRows = discRows.slice(1).filter(r => {
      if (!r[0]) return false;
      const parts = String(r[0]).split('.');
      if (parts.length < 3) return false;
      const d = new Date(parts[2], parts[1]-1, parts[0]);
      return d >= weekAgo;
    });

    if (weekRows.length === 0) {
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId, '📋 ДИСЦИПЛИНА — неделя\n\n✅ Нарушений за неделю нет. Команда работает чисто.');
      }
      return;
    }

    // Группируем по продавцу
    const byName = {};
    weekRows.forEach(r => {
      const name = r[1] || 'Неизвестно';
      const type = r[2] || '';
      if (!byName[name]) byName[name] = { late: 0, timeout: 0, other: 0 };
      if (type === 'Опоздание') byName[name].late++;
      else if (type === 'Таймаут чек-листа') byName[name].timeout++;
      else byName[name].other++;
    });

    let msg = '📋 ДИСЦИПЛИНА — неделя\n\n';
    let hasIssues = false;

    Object.entries(byName).forEach(([name, stats]) => {
      const total = stats.late + stats.timeout + stats.other;
      if (total > 0) {
        hasIssues = true;
        msg += '👤 ' + name + '\n';
        if (stats.late > 0) msg += '  ⏰ Опозданий: ' + stats.late + '\n';
        if (stats.timeout > 0) msg += '  📋 Таймаут чек-листа: ' + stats.timeout + '\n';
        if (stats.other > 0) msg += '  ⚠️ Другие: ' + stats.other + '\n';
        msg += '\n';
      }
    });

    if (!hasIssues) msg += '✅ Нарушений нет\n';

    msg += 'Итого нарушений за неделю: ' + weekRows.length;

    for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, msg);
    console.log('Еженедельная сводка по дисциплине отправлена');
  } catch(e) { console.error('Ошибка еженедельной сводки:', e.message); }
}

// ── Еженедельный отчёт по продажам (HTML) ────────────────────────────
// ── Напоминания ───────────────────────────────────────────────────────
async function saveReminder(userId, text, remindAt) {
  try {
    await supabase.from('reminders').insert({ user_id: String(userId), text, remind_at: remindAt, done: false });
    console.log('Напоминание сохранено:', text, remindAt);
  } catch(e) { console.error('saveReminder error:', e.message); }
}

async function checkReminders() {
  try {
    const now = new Date().toISOString();
    const { data } = await supabase.from('reminders').select('*').eq('done', false).lte('remind_at', now);
    if (!data || data.length === 0) return;
    for (const r of data) {
      await sendTelegram(r.user_id, '⏰ Напоминание: ' + r.text);
      await supabase.from('reminders').update({ done: true }).eq('id', r.id);
      console.log('Напоминание отправлено:', r.text);
    }
  } catch(e) { console.error('checkReminders error:', e.message); }
}

async function deleteLastExpense(userId) {
  try {
    const rows = await readSheet('Расходы!A:F', DASHBOARD_ID);
    // Ищем последнюю непустую строку с данными (с строки 3)
    let lastRow = -1;
    for (let i = rows.length - 1; i >= 2; i--) {
      if (rows[i] && rows[i][0] && rows[i][2]) { lastRow = i + 1; break; }
    }
    if (lastRow < 0) return null;
    const { api } = getSheets(DASHBOARD_ID);
    // Очищаем строку
    await api.spreadsheets.values.clear({
      spreadsheetId: DASHBOARD_ID,
      range: 'Расходы!A' + lastRow + ':F' + lastRow
    });
    return rows[lastRow - 1];
  } catch(e) { console.error('deleteLastExpense error:', e.message); return null; }
}
async function generatePLReport() {
  try {
    const fmt = n => Math.round(Number(n||0)).toLocaleString('ru-RU');
    const now = getNow();
    const monthName = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', month: 'long', year: 'numeric' });

    // Данные из Итоги месяца
    const itogi = await readSheet("'Итоги месяца'!A1:H18", DASHBOARD_ID);
    const getNum = (rows, ri, ci) => {
      try { return parseFloat(String(rows[ri]&&rows[ri][ci]||'0').replace(/[^0-9.,-]/g,'').replace(',','.')) || 0; } catch(e) { return 0; }
    };

    const revenue = getNum(itogi, 4, 1); // Оборот
    const fotTotal = getNum(itogi, 17, 7); // ФОТ итого
    const tax = getNum(itogi, 'R' in itogi ? 15 : 15, 1) || Math.round(revenue * 0.03); // Налог 3%

    // Читаем дашборд для оборота
    const dash = await readSheet("'Дашборд'!A1:H25", DASHBOARD_ID);
    const totalFact = getNum(dash, 18, 6) || (getNum(dash,18,2)+getNum(dash,18,3)+getNum(dash,18,4));

    // Расходы из листа Расходы
    const expRows = await readSheet('Расходы!A:F', DASHBOARD_ID);
    const currentMonth = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', month: 'long' });

    const expenses = {};
    let totalExpenses = 0;
    expRows.slice(2).forEach(r => {
      if (!r[0] || !r[1] || !r[2]) return;
      if (String(r[4]||'').toLowerCase() !== currentMonth.toLowerCase()) return;
      const cat = String(r[1]).trim();
      const amount = parseFloat(String(r[2]).replace(/[^0-9.]/g,'')) || 0;
      if (!expenses[cat]) expenses[cat] = 0;
      expenses[cat] += amount;
      totalExpenses += amount;
    });

    const taxCalc = Math.round(totalFact * 0.03);
    const grossProfit = totalFact - fotTotal - taxCalc - totalExpenses;

    // Цвета
    const profitColor = grossProfit >= 0 ? '#1a8a5a' : '#c0392b';
    const profitBg = grossProfit >= 0 ? '#eaf3de' : '#fcebeb';
    const profitBorder = grossProfit >= 0 ? '#c0dd97' : '#F7C1C1';

    // Строки расходов
    const expenseRows = Object.entries(expenses).map(([cat, amount]) => `
      <div style="padding:10px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
        <span style="color:#555;">${cat}</span>
        <span style="font-weight:500;color:#c0392b;">-${fmt(amount)} ₸</span>
      </div>`).join('');

    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>P&L — ${monthName}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ede8;color:#1a1a1a;padding:20px 16px;margin:0;">
<div style="max-width:680px;margin:0 auto;">

  <div style="margin-bottom:20px;">
    <div style="font-size:21px;font-weight:700;letter-spacing:0.07em;color:#1a1a1a;">NANÉ PARIS</div>
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.12em;margin-top:2px;">P&L — ${monthName}</div>
    <div style="font-size:11px;color:#aaa;margin-top:3px;">Сформирован: ${now}</div>
  </div>

  <!-- Итог -->
  <div style="background:${profitBg};border:1px solid ${profitBorder};border-radius:12px;padding:16px;margin-bottom:16px;text-align:center;">
    <div style="font-size:12px;color:#888;margin-bottom:6px;">Чистая прибыль</div>
    <div style="font-size:32px;font-weight:700;color:${profitColor};">${grossProfit >= 0 ? '+' : ''}${fmt(grossProfit)} ₸</div>
  </div>

  <!-- Доходы -->
  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:0 0 8px;">Доходы</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px;">
    <div style="padding:12px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#555;">Оборот магазина</span>
      <span style="font-weight:500;color:#1a8a5a;">+${fmt(totalFact)} ₸</span>
    </div>
    <div style="padding:10px 14px;display:flex;justify-content:space-between;font-size:13px;font-weight:600;">
      <span>Итого доходы</span>
      <span style="color:#1a8a5a;">+${fmt(totalFact)} ₸</span>
    </div>
  </div>

  <!-- Расходы фиксированные -->
  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Расходы</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px;">
    <div style="padding:12px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#555;">ФОТ (зарплата команды)</span>
      <span style="font-weight:500;color:#c0392b;">-${fmt(fotTotal)} ₸</span>
    </div>
    <div style="padding:12px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#555;">Налог 3%</span>
      <span style="font-weight:500;color:#c0392b;">-${fmt(taxCalc)} ₸</span>
    </div>
    ${expenseRows || '<div style="padding:12px 14px;font-size:13px;color:#aaa;">Расходы не внесены</div>'}
    <div style="padding:10px 14px;display:flex;justify-content:space-between;font-size:13px;font-weight:600;">
      <span>Итого расходы</span>
      <span style="color:#c0392b;">-${fmt(fotTotal + taxCalc + totalExpenses)} ₸</span>
    </div>
  </div>

  <!-- Детализация -->
  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Детализация</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;">
    <div style="padding:10px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:12px;">
      <span style="color:#aaa;">Оборот</span><span>+${fmt(totalFact)} ₸</span>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:12px;">
      <span style="color:#aaa;">ФОТ</span><span>-${fmt(fotTotal)} ₸</span>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:12px;">
      <span style="color:#aaa;">Налог 3%</span><span>-${fmt(taxCalc)} ₸</span>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:12px;">
      <span style="color:#aaa;">Прочие расходы</span><span>-${fmt(totalExpenses)} ₸</span>
    </div>
    <div style="padding:12px 14px;display:flex;justify-content:space-between;font-size:14px;font-weight:700;border-top:2px solid #e8e4de;">
      <span>Чистая прибыль</span>
      <span style="color:${profitColor};">${grossProfit >= 0 ? '+' : ''}${fmt(grossProfit)} ₸</span>
    </div>
  </div>

</div></body></html>`;
  } catch(e) {
    console.error('generatePLReport error:', e.message);
    return null;
  }
}

async function sendWeeklySalesReport() {
  try {
    console.log('Формирую еженедельный отчёт по продажам...');
    const fmt = n => Math.round(Number(n||0)).toLocaleString('ru-RU');
    const pctColor = p => p >= 100 ? '#1a8a5a' : p >= 80 ? '#b06a10' : '#c0392b';
    const barColor = p => p >= 100 ? '#27ae60' : p >= 80 ? '#e67e22' : '#e74c3c';

    // Даты недели
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = weekAgo.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: 'long' });
    const weekEnd = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: 'long', year: 'numeric' });

    // Читаем смены за неделю
    const shifts = await readSheet('Смены!A:Y', SPREADSHEET_ID);
    const weekShifts = shifts.slice(1).filter(r => {
      if (!r[0]) return false;
      const parts = String(r[0]).split('.');
      if (parts.length < 3) return false;
      const d = new Date(parts[2], parts[1]-1, parts[0]);
      return d >= weekAgo && d <= now;
    });

    // Итоги по дням
    const byDay = {};
    weekShifts.forEach(r => {
      const date = r[0];
      const rostaTotal = parseFloat(String(r[19]||'0').replace(/[^0-9.]/g,'')) || 0;
      if (!byDay[date]) byDay[date] = 0;
      byDay[date] += rostaTotal;
    });

    const dayTotals = Object.values(byDay);
    const weekTotal = dayTotals.reduce((s, v) => s + v, 0);
    const avgDay = dayTotals.length > 0 ? weekTotal / dayTotals.length : 0;
    const bestDay = dayTotals.length > 0 ? Math.max(...dayTotals) : 0;
    const worstDay = dayTotals.length > 0 ? Math.min(...dayTotals) : 0;
    const bestDayDate = Object.keys(byDay).find(k => byDay[k] === bestDay) || '—';
    const worstDayDate = Object.keys(byDay).find(k => byDay[k] === worstDay) || '—';

    // Итоги по продавцам
    const bySeller = {};
    weekShifts.forEach(r => {
      const seller = r[1];
      if (!seller) return;
      const rostaTotal = parseFloat(String(r[19]||'0').replace(/[^0-9.]/g,'')) || 0;
      if (!bySeller[seller]) bySeller[seller] = { total: 0, shifts: 0 };
      bySeller[seller].total += rostaTotal;
      bySeller[seller].shifts++;
    });

    // Дисциплина за неделю
    const discRows = await readSheet('Дисциплина!A:E', DASHBOARD_ID);
    const weekDisc = (discRows || []).slice(1).filter(r => {
      if (!r[0]) return false;
      const parts = String(r[0]).split('.');
      if (parts.length < 3) return false;
      const d = new Date(parts[2], parts[1]-1, parts[0]);
      return d >= weekAgo && d <= now;
    });
    const lateCount = weekDisc.filter(r => r[2] === 'Опоздание').length;
    const timeoutCount = weekDisc.filter(r => r[2] === 'Таймаут чек-листа').length;
    const reopenCount = weekDisc.filter(r => r[2] === 'Повторное открытие').length;

    // Дашборд — план месяца
    const dash = await readSheet("'Дашборд'!A1:H25", DASHBOARD_ID);
    const getNum = (rows, ri, ci) => {
      try { return parseFloat(String(rows[ri]&&rows[ri][ci]||'0').replace(/[^0-9.,-]/g,'').replace(',','.')) || 0; } catch(e) { return 0; }
    };
    const plan = getNum(dash, 5, 2) || 27000000;
    const totalFact = getNum(dash, 18, 6) || 0;
    const totalPct = plan > 0 ? Math.round(totalFact / plan * 100) : 0;
    const remains = Math.max(0, plan - totalFact);
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
    const daysLeft = daysInMonth - today.getDate();
    const dailyNeed = daysLeft > 0 ? Math.round(remains / daysLeft) : 0;

    // Личные планы продавцов
    const aselPlan = getNum(dash, 13, 2);
    const zarinaPlan = getNum(dash, 13, 3);
    const luizaPlan = getNum(dash, 13, 4);
    const planMap = { 'Асель': aselPlan, 'Зарина': zarinaPlan, 'Луиза': luizaPlan };
    const emojiMap = { 'Асель': '💙', 'Зарина': '💙', 'Луиза': '💚' };

    // Факт по продавцам из дашборда
    const aselFact = getNum(dash, 18, 2);
    const zarinaFact = getNum(dash, 18, 3);
    const luizaFact = getNum(dash, 18, 4);
    const factMap = { 'Асель': aselFact, 'Зарина': zarinaFact, 'Луиза': luizaFact };

    // Дисциплина по продавцам за неделю
    const discBySeller = {};
    weekDisc.forEach(r => {
      const name = r[1];
      if (!name) return;
      if (!discBySeller[name]) discBySeller[name] = 0;
      if (r[2] === 'Опоздание') discBySeller[name]++;
    });

    const sellers = ['Асель', 'Зарина', 'Луиза'];

    const sellerBlocks = sellers.map(name => {
      const weekData = bySeller[name] || { total: 0, shifts: 0 };
      const monthFact = factMap[name] || 0;
      const monthPlan = planMap[name] || 1;
      const pct = Math.round(monthFact / monthPlan * 100);
      const avgSellerDay = weekData.shifts > 0 ? Math.round(weekData.total / weekData.shifts) : 0;
      const late = discBySeller[name] || 0;
      const emoji = emojiMap[name] || '💙';
      return `
    <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:600;color:#1a1a1a;">${emoji} ${name}</div>
        <div style="font-size:16px;font-weight:700;color:${pctColor(pct)}">${pct}%</div>
      </div>
      <div style="font-size:12px;color:#999;margin-bottom:8px;">${fmt(monthFact)} ₸ из ${fmt(monthPlan)} ₸ (месяц) · Осталось: ${fmt(Math.max(0, monthPlan - monthFact))} ₸</div>
      <div style="background:#ebe8e2;border-radius:20px;height:6px;overflow:hidden;margin-bottom:8px;">
        <div style="width:${Math.min(pct,100)}%;height:6px;border-radius:20px;background:${barColor(pct)};"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        <div style="background:#f7f4ef;border-radius:8px;padding:8px;">
          <div style="font-size:10px;color:#aaa;margin-bottom:2px;">Смен за неделю</div>
          <div style="font-size:13px;font-weight:500;">${weekData.shifts}</div>
        </div>
        <div style="background:#f7f4ef;border-radius:8px;padding:8px;">
          <div style="font-size:10px;color:#aaa;margin-bottom:2px;">Средний день</div>
          <div style="font-size:13px;font-weight:500;">${fmt(avgSellerDay)} ₸</div>
        </div>
        <div style="background:#f7f4ef;border-radius:8px;padding:8px;">
          <div style="font-size:10px;color:#aaa;margin-bottom:2px;">Опозданий</div>
          <div style="font-size:13px;font-weight:500;color:${late > 0 ? '#c0392b' : '#1a8a5a'}">${late}</div>
        </div>
      </div>
    </div>`;
    }).join('');

    const nowStr = getNow();
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NANÉ PARIS — Еженедельный отчёт</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ede8;color:#1a1a1a;padding:20px 16px;margin:0;">
<div style="max-width:680px;margin:0 auto;">

  <div style="margin-bottom:20px;">
    <div style="font-size:21px;font-weight:700;letter-spacing:0.07em;color:#1a1a1a;">NANÉ PARIS</div>
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.12em;margin-top:2px;">Еженедельный отчёт — ${weekStart} — ${weekEnd}</div>
    <div style="font-size:11px;color:#aaa;margin-top:3px;">Сформирован: ${nowStr}</div>
  </div>

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:0 0 8px;">Итоги недели</div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px;">
    <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;">
      <div style="font-size:11px;color:#999;margin-bottom:5px;">Оборот за неделю</div>
      <div style="font-size:22px;font-weight:700;color:#1a1a1a;">${fmt(weekTotal)} ₸</div>
      <div style="font-size:12px;color:#aaa;margin-top:4px;">${dayTotals.length} рабочих дней</div>
    </div>
    <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;">
      <div style="font-size:11px;color:#999;margin-bottom:5px;">Средний день</div>
      <div style="font-size:22px;font-weight:700;color:#1a1a1a;">${fmt(avgDay)} ₸</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px;">
    <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;">
      <div style="font-size:11px;color:#999;margin-bottom:5px;">Лучший день</div>
      <div style="font-size:18px;font-weight:700;color:#1a8a5a;">${fmt(bestDay)} ₸</div>
      <div style="font-size:12px;color:#aaa;margin-top:4px;">${bestDayDate}</div>
    </div>
    <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;">
      <div style="font-size:11px;color:#999;margin-bottom:5px;">Худший день</div>
      <div style="font-size:18px;font-weight:700;color:#c0392b;">${fmt(worstDay)} ₸</div>
      <div style="font-size:12px;color:#aaa;margin-top:4px;">${worstDayDate}</div>
    </div>
  </div>

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">План месяца</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;padding:14px;margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:13px;color:#1a1a1a;font-weight:500;">Выполнено: ${fmt(totalFact)} ₸</div>
      <div style="font-size:18px;font-weight:700;color:${pctColor(totalPct)}">${totalPct}%</div>
    </div>
    <div style="background:#ebe8e2;border-radius:20px;height:8px;overflow:hidden;margin-bottom:6px;">
      <div style="width:${Math.min(totalPct,100)}%;height:8px;border-radius:20px;background:${barColor(totalPct)};"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:#bbb;">
      <span>0</span><span>${fmt(plan/2)} ₸</span><span>${fmt(plan)} ₸</span>
    </div>
    <div style="margin-top:10px;font-size:12px;color:#888;">Осталось: ${fmt(remains)} ₸ · До конца месяца: ${daysLeft} дн · Нужно в день: ${fmt(dailyNeed)} ₸</div>
  </div>

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Продавцы за неделю</div>
  ${sellerBlocks}

  <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.12em;margin:18px 0 8px;">Дисциплина за неделю</div>
  <div style="background:#fff;border:1px solid #e8e4de;border-radius:12px;overflow:hidden;margin-bottom:10px;">
    <div style="padding:12px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#aaa;">Опозданий</span>
      <span style="font-weight:500;color:${lateCount > 0 ? '#c0392b' : '#1a8a5a'}">${lateCount}</span>
    </div>
    <div style="padding:12px 14px;border-bottom:1px solid #f0ece6;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#aaa;">Таймаут чек-листа</span>
      <span style="font-weight:500;color:${timeoutCount > 0 ? '#c0392b' : '#1a8a5a'}">${timeoutCount}</span>
    </div>
    <div style="padding:12px 14px;display:flex;justify-content:space-between;font-size:13px;">
      <span style="color:#aaa;">Повторных открытий смены</span>
      <span style="font-weight:500;color:${reopenCount > 0 ? '#b06a10' : '#1a8a5a'}">${reopenCount}</span>
    </div>
  </div>

</div></body></html>`;

    const filename = 'weekly_' + now.toLocaleDateString('ru-RU', {timeZone:'Asia/Almaty'}).replace(/\./g,'_') + '.html';
    for (const ownerId of OWNER_IDS) {
      await sendTelegramDocument(ownerId, filename, html, '📊 Еженедельный отчёт NANÉ PARIS — открой в браузере');
    }
    console.log('Еженедельный отчёт по продажам отправлен');
  } catch(e) { console.error('Ошибка еженедельного отчёта:', e.message); }
}

async function sendMorningDigest() {
  try {
    console.log('Отправляю утренний дайджест...');

    const fmt = n => Math.round(Number(n||0)).toLocaleString('ru-RU');

    // 1. Итоги вчера из листа "Смены"
    const shifts = await readSheet('Смены!A:Y', SPREADSHEET_ID);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });

    const yesterdayShifts = shifts.filter(r => r[0] === yesterdayStr);
    let yesterdayTotal = 0;
    let yesterdayHasIssues = false;
    let yesterdaySellers = [];
    yesterdayShifts.forEach(r => {
      const rostaTotal = parseFloat(String(r[19]||'0').replace(/[^0-9.]/g,'')) || 0;
      const diff = parseFloat(String(r[21]||'0').replace(/[^0-9.]/g,'')) || 0;
      yesterdayTotal += rostaTotal;
      if (Math.abs(diff) >= 500) yesterdayHasIssues = true;
      if (r[1]) yesterdaySellers.push(r[1]);
    });

    // 2. Кто работает сегодня из "Учёт по дням"
    const today = new Date();
    const todayDay = today.getDate(); // число месяца
    const uchet = await readSheet("'Учёт по дням'!A6:E200", DASHBOARD_ID);
    let todaySeller1 = '';
    let todaySeller2 = '';
    uchet.forEach(r => {
      const rowNum = parseInt(r[0]);
      if (rowNum === todayDay) {
        todaySeller1 = r[3] || '';
        todaySeller2 = r[4] || '';
      }
    });

    // 3. Открытые предоплаты
    const prepays = await readSheet('Предоплаты!A:K', SPREADSHEET_ID);
    const openPrepays = prepays.slice(1).filter(r =>
      r[0] && String(r[8]||'').toLowerCase().includes('открыт')
    );
    const totalDebt = openPrepays.reduce((s, r) => {
      return s + (parseFloat(String(r[7]||'0').replace(/[^0-9.]/g,'')) || 0);
    }, 0);

    // 4. % плана месяца из дашборда
    const dash = await readSheet("'Дашборд'!A1:H25", DASHBOARD_ID);
    const getNum = (rows, ri, ci) => {
      try { return parseFloat(String(rows[ri]&&rows[ri][ci]||'0').replace(/[^0-9.,-]/g,'').replace(',','.')) || 0; } catch(e) { return 0; }
    };
    const plan = getNum(dash, 5, 2) || 27000000;
    const totalFact = getNum(dash, 18, 6) || (getNum(dash,18,2)+getNum(dash,18,3)+getNum(dash,18,4));
    const pct = plan > 0 ? Math.round(totalFact / plan * 100) : 0;
    const remains = Math.max(0, plan - totalFact);

    // Дней прошло и осталось в месяце
    const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
    const daysPassed = today.getDate();
    const daysLeft = daysInMonth - daysPassed;
    const dailyNeed = daysLeft > 0 ? Math.round(remains / daysLeft) : 0;

    // Формируем сообщение
    const todayDateStr = today.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'long', day: 'numeric', month: 'long' });

    let msg = '☀️ Доброе утро, Ермек!\n';
    msg += todayDateStr.charAt(0).toUpperCase() + todayDateStr.slice(1) + '\n\n';

    // Итоги вчера
    msg += '📊 ВЧЕРА (' + yesterdayStr + ')\n';
    if (yesterdayShifts.length > 0) {
      msg += '💰 Оборот: ' + fmt(yesterdayTotal) + ' тг\n';
      msg += '👤 Работали: ' + (yesterdaySellers.join(', ') || '—') + '\n';
      msg += yesterdayHasIssues ? '⚠️ Были расхождения — проверь отчёт\n' : '✅ Расхождений нет\n';
    } else {
      msg += 'Данных за вчера нет\n';
    }

    // Месяц
    msg += '\n📈 ПЛАН МЕСЯЦА\n';
    msg += '✅ Выполнено: ' + fmt(totalFact) + ' тг (' + pct + '%)\n';
    msg += '🎯 Осталось: ' + fmt(remains) + ' тг\n';
    msg += '📅 Дней осталось: ' + daysLeft + '\n';
    msg += '📌 Нужно в день: ' + fmt(dailyNeed) + ' тг\n';

    // Сегодня кто работает
    msg += '\n👥 СЕГОДНЯ РАБОТАЮТ\n';
    if (todaySeller1 || todaySeller2) {
      if (todaySeller1) msg += '• ' + todaySeller1 + '\n';
      if (todaySeller2) msg += '• ' + todaySeller2 + '\n';
    } else {
      msg += 'График не указан\n';
    }

    // Предоплаты
    msg += '\n💳 ПРЕДОПЛАТЫ\n';
    if (openPrepays.length > 0) {
      msg += '📋 Открытых: ' + openPrepays.length + ' шт\n';
      msg += '💵 Общий долг: ' + fmt(totalDebt) + ' тг\n';
      // Показать первые 3 с долгом
      const withDebt = openPrepays.filter(r => parseFloat(String(r[7]||'0').replace(/[^0-9.]/g,'')) > 0).slice(0, 3);
      if (withDebt.length > 0) {
        msg += 'Ближайшие:\n';
        withDebt.forEach(r => {
          const client = String(r[2]||'').trim();
          const debt = parseFloat(String(r[7]||'0').replace(/[^0-9.]/g,'')) || 0;
          msg += '  • ' + client + ' — ' + fmt(debt) + ' тг\n';
        });
      }
    } else {
      msg += '✅ Открытых предоплат нет\n';
    }

    msg += '\nХорошего дня! 💪';

    for (const ownerId of OWNER_IDS) {
      await sendTelegram(ownerId, msg);
    }
    console.log('Утренний дайджест отправлен');

  } catch(e) {
    console.error('Ошибка дайджеста:', e.message);
  }
}

// Планировщик — каждую минуту проверяем время
// ══════════════════════════════════════════════════════════════════════
// АВТОМАТИЧЕСКОЕ ОБУЧЕНИЕ — каждую среду в 10:00
// Неделя 1: урок → Неделя 2: тест по прошлой теме
// ══════════════════════════════════════════════════════════════════════

const TRAINING_TOPICS = [
  {
    topic: 'Встреча покупателя и первый контакт',
    lesson: `📖 УРОК 1: Встреча покупателя

Первые 7 секунд определяют всё. Исследования показывают: покупатель решает остаться или уйти в первые 30 секунд.

━━━ 3 ЭТАПА ПЕРВОГО КОНТАКТА ━━━

ШАГ 1 — ПРИВЕТСТВИЕ (0-10 сек)
Встань, улыбнись, установи зрительный контакт.
✅ «Добро пожаловать в NANE PARIS!»
❌ «Здравствуйте, вам помочь?» — ответ всегда «нет», это закрытый вопрос

ШАГ 2 — ПАУЗА (10-60 сек)
Дай покупателю осмотреться. Не преследуй. Будь в зоне видимости.
Наблюдай: на что смотрит, что трогает — это подсказки о потребности.

ШАГ 3 — ВХОД В ДИАЛОГ (через 30-60 сек)
Используй наблюдение как повод:
✅ «Вы посмотрели на наши корейские платья — эта коллекция только что приехала, очень нежные фасоны»
✅ «Это наше собственное производство — кожа ручной выделки, таких в городе больше нет»
✅ «У нас сейчас итальянская линейка — европейский крой, очень практичные вещи»

━━━ ТИПЫ ПОКУПАТЕЛЕЙ И ПОДХОД ━━━

🔵 Молчаливый — заходит, смотрит, не реагирует
→ Не давить. Через минуту: «Если понадоблюсь — я рядом»
→ Через 3-5 мин если смотрит на одно: «Хотите примерить? Я помогу с размером»

🟡 Активный — сразу спрашивает, общительный
→ Подходи быстро, включайся в диалог
→ «Отличный вкус! Давайте я покажу ещё несколько вариантов»

🔴 Торопливый — смотрит быстро, явно спешит
→ «Скажите что ищете — я сразу покажу нужное»
→ Не растягивай, давай конкретику

━━━ СТАНДАРТЫ NANE PARIS ━━━
• Вставай при входе покупателя
• Улыбка обязательна — это часть образа бренда
• Никогда не сидеть за телефоном когда есть покупатели
• Одежда продавца — из ассортимента магазина, всегда безупречная`
  },
  {
    topic: 'Выявление потребности',
    lesson: `📖 УРОК 2: Выявление потребности

Продавец который слушает — продаёт больше продавца который говорит.
80% времени говорит покупатель. 20% — ты.

━━━ МЕТОД SPIN ━━━

S — Ситуационные вопросы (понять контекст)
«На какой повод подбираете?»
«Для работы или повседневно?»
«Что сейчас носите чаще всего?»

P — Проблемные вопросы (найти боль)
«Есть что-то чего не хватает в гардеробе?»
«Бывает что нечего надеть на важное событие?»
«С чем сложнее всего сочетать вещи?»

I — Извлекающие вопросы (усилить боль)
«Если найдём идеальное пальто — как часто будете надевать?»
«Насколько важно чтобы вещь носилась несколько сезонов?»

N — Направляющие вопросы (к решению)
«Значит вам нужно универсальное — и на деловую встречу и на выход?»
«Если я правильно понимаю — ищете что-то практичное но с характером?»

━━━ ПРАВИЛО 3 ВОПРОСОВ ━━━
Задай 3 вопроса ПРЕЖДЕ чем что-то предложить.
Покупатель чувствует что его понимают — не просто продают.

━━━ ТРИ ЛИНЕЙКИ — ТРИ РАЗНЫХ ПОКУПАТЕЛЯ ━━━

🇰🇷 Корея — премиум
Покупатель: ценит качество, готов платить, хочет эксклюзив
Вопросы: «Вы предпочитаете что-то более утончённое?» / «Качество ткани важно?»

🇮🇹 Италия — масс-маркет premium
Покупатель: хочет выглядеть хорошо, следит за трендами, практичный
Вопросы: «Нужно что-то универсальное на каждый день?» / «Важна практичность?»

🏭 Собственное производство (кожа, замша, дублёнки)
Покупатель: ищет инвестицию, хочет уникальность, понимает материалы
Вопросы: «Рассматриваете что-то на несколько сезонов?» / «Натуральные материалы важны?»

━━━ АКТИВНОЕ СЛУШАНИЕ ━━━
• Кивай, поддакивай — «да», «понимаю», «конечно»
• Повторяй ключевые слова: «Значит, важна практичность...»
• Не перебивай
• Записывай мысленно: повод, бюджет, стиль, цвет`
  },
  {
    topic: 'Презентация товара (FAB + линейки)',
    lesson: `📖 УРОК 3: Презентация товара

Не рассказывай о товаре — рассказывай о жизни покупателя с этим товаром.

━━━ ТЕХНИКА FAB ━━━

F — Feature (Характеристика): факт о товаре
A — Advantage (Преимущество): чем лучше аналогов
B — Benefit (Выгода): что это значит КОНКРЕТНО для этого покупателя

ФОРМУЛА: «[Характеристика], что означает [Преимущество], а значит вы [Выгода]»

━━━ FAB ДЛЯ КАЖДОЙ ЛИНЕЙКИ ━━━

🇰🇷 КОРЕЯ — ПРЕМИУМ:
«Это платье сшито по корейским лекалам (F) — они делают чуть свободный крой в плечах (A) — поэтому оно сидит идеально даже если верх и низ разные размеры (B)»

«Корейская вискоза с лайкрой (F) — ткань не мнётся и тянется под тело (A) — можно надеть утром на работу и вечером на ужин, выглядишь свежо весь день (B)»

«Ручная вышивка на воротнике (F) — такого нет в масс-маркете (A) — вы будете единственной в этом образе (B)»

🇮🇹 ИТАЛИЯ — МАСС-МАРКЕТ PREMIUM:
«Итальянский крой (F) — европейские стандарты посадки (A) — вещь выглядит дороже своей цены, никто не догадается (B)»

«Состав: хлопок с полиэстером (F) — не требует глажки, легко стирается (A) — идеально для занятой женщины (B)»

🏭 СОБСТВЕННОЕ ПРОИЗВОДСТВО — КОЖА/ЗАМША/ДУБЛЁНКИ:
«Это наше собственное производство (F) — кожа ручной выделки, каждое изделие уникально (A) — вы инвестируете в вещь которая будет с вами 10-15 лет (B)»

«Натуральная замша из Казахстана (F) — экологически чистая, дышит (A) — ощущение роскоши каждый день, и это поддержка местного производства (B)»

«Натуральная дублёнка ручной работы (F) — греет при -30°C лучше синтетики (A) — один раз купить и забыть про холод на годы (B)»

━━━ КАК ДЕРЖАТЬ ТОВАР ━━━
• Всегда бери вещь в руки — не показывай пальцем
• Покажи фактуру: дай потрогать ткань
• Приложи к покупателю: «Смотрите как ваш цвет»
• Веди к примерочной: «Давайте примерим — на вешалке и на человеке это небо и земля»

━━━ ПРАВИЛО ТРЁХ ВАРИАНТОВ ━━━
Всегда показывай 3 варианта:
1. Именно то что просит
2. Чуть дороже — лучше качество
3. Из другой линейки — альтернатива`
  },
  {
    topic: 'Работа с возражениями',
    lesson: `📖 УРОК 4: Работа с возражениями

Возражение — это не отказ. Это вопрос который покупатель боится задать напрямую.

━━━ АЛГОРИТМ РАБОТЫ С ЛЮБЫМ ВОЗРАЖЕНИЕМ ━━━

1. ВЫСЛУШАЙ — не перебивай
2. СОГЛАСИСЬ — с чувством, не с возражением
3. УТОЧНИ — «Что именно вас смущает?»
4. ОТВЕТЬ — конкретно, с фактами
5. ПОДТВЕРДИ — «Это отвечает на ваш вопрос?»

━━━ «ДОРОГО» ━━━

❌ «Ну это же качество!»
✅ Техники:

Согласие + обоснование:
«Да, цена выше среднего — это потому что [конкретная причина]»
• Корея: «корейское производство, мелкие партии, ручная работа»
• Италия: «европейский крой, сертифицированные ткани»
• Собственное: «натуральная кожа ручной выделки, срок службы 10-15 лет»

Разбивка на дни:
«Это пальто стоит 45 000 тг. Если носить 3 сезона — это 50 тг в день. Чашка кофе стоит больше»

Сравнение с конкурентами:
«В других магазинах похожее стоит столько же, но там синтетика. Здесь натуральная кожа»

Инвестиционный подход:
«Это не трата — это инвестиция. Дешёвая вещь покупается каждый сезон. Эта — один раз»

━━━ «ПОДУМАЮ» ━━━

Это значит: «Ты меня не убедил» или «Боюсь пожалеть»

«Конечно, это важное решение. Скажите — что останавливает? Может я могу помочь?»

Если молчит:
«Вы сомневаетесь в размере? Цвете? Или в цене?»

Создай мягкий дефицит:
«Эта модель у нас в единственном экземпляре вашего размера. Не могу обещать что будет завтра»

━━━ «Я ПРОСТО СМОТРЮ» ━━━
«Конечно! Если увидите что-то интересное — я рядом»
Через 5 минут: «Кстати, посмотрите вот это — только что пришло»

━━━ «НЕ МОЙ СТИЛЬ» ━━━
«А какой ваш стиль? Давайте я покажу что-то более подходящее»
Никогда не спорь со вкусом покупателя

━━━ «У ПОДРУГИ ВИДЕЛА ДЕШЕВЛЕ» ━━━
«Интересно, где именно? [пауза] У нас натуральные материалы и собственное производство — это влияет на цену. Давайте я покажу разницу в качестве»`
  },
  {
    topic: 'Допродажа и закрытие сделки',
    lesson: `📖 УРОК 5: Допродажа и закрытие сделки

Средний чек — это твоя зарплата. Каждые +1 000 тг к чеку = +% к твоим продажам.

━━━ UPSELL — ПРЕДЛОЖИ ЛУЧШЕ ━━━

Когда: покупатель выбрал товар но ещё не сказал «беру»
Как: «Есть очень похожая модель — чуть дороже, но посмотрите разницу»

Примеры:
«Это платье за 8 000 тг хорошее, но вот это за 12 000 — корейское производство, ткань в два раза плотнее. Ощутите разницу» [даёт потрогать]

«Итальянская куртка за 15 000 тг практична. Но если рассматриваете вложение на годы — вот наша кожаная, собственное производство, 45 000 тг. Через 5 лет будет выглядеть так же»

━━━ CROSS-SELL — ПРЕДЛОЖИ ДОПОЛНЕНИЕ ━━━

Когда: покупатель уже решил взять основной товар
Правило: максимум 1-2 дополнения, не перегружай

Примеры:
«Отличный выбор! К этому платью идеально подойдёт вот этот ремень — образ сразу законченный» [берёт ремень, прикладывает]

«К кожаному пальто мы рекомендуем этот уход — он сохранит кожу на годы. Стоит 2 000 тг, но продлит жизнь пальто на несколько лет»

«К этому костюму есть блузка из той же коллекции — специально подбирали, смотрите как сочетается»

━━━ ТЕХНИКИ ЗАКРЫТИЯ СДЕЛКИ ━━━

Альтернативный вопрос (не давай ответить «нет»):
«Вы берёте это или то?» — не «Берёте?»
«Упаковать в фирменный пакет или сразу наденете?»

Допущение покупки:
«Вам на кассу или нужна примерочная?»
«Оплата Kaspi или наличными?»

Мягкий дедлайн:
«Эта модель последняя в вашем размере. Если хотите — лучше сейчас»

Резюме:
«Итак, мы берём платье + ремень. Это 12 500 тг. Оформляем?»

━━━ ПРАВИЛО ТИШИНЫ ━━━
После вопроса о покупке — МОЛЧИ.
Кто заговорит первым — тот проиграл.
Дай покупателю время принять решение.

━━━ ПОСЛЕ ПРОДАЖИ ━━━
«Отличный выбор! Вы будете смотреться великолепно»
«Если будут вопросы по уходу — обращайтесь»
«Будем рады видеть вас снова в NANE PARIS»

Никогда не говори «До свидания» первой — жди пока покупатель уходит.`
  }
];

let currentTrainingWeek = 0; // чётная = урок, нечётная = тест

// Хранилище кто прошёл урок/тест сегодня
const trainingCompleted = {}; // userId -> { lesson: bool, test: bool, date: string }
let trainingPaused = false; // флаг паузы обучения

async function checkTrainingDeadline(type) {
  try {
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
    const sellers = Object.entries(ALLOWED_MAP).filter(([id]) => !OWNER_IDS.includes(id));
    const notDone = [];

    for (const [sellerId, sellerName] of sellers) {
      const done = trainingCompleted[sellerId];
      const completed = done && done.date === today && done[type];
      if (!completed) {
        notDone.push({ sellerId, sellerName });
        // Предупреждение продавцу
        const typeLabel = type === 'lesson' ? 'урок' : 'тест';
        await sendTelegram(sellerId,
          '⚠️ ' + sellerName + ', ты ещё не прошла ' + typeLabel + ' сегодня!\n\n' +
          '⏰ До 23:59 осталось меньше 30 минут.\n\n' +
          '❗️ Если не пройдёшь — это будет зафиксировано как нарушение KPI.\n' +
          'Это повлияет на расчёт твоей зарплаты в конце месяца.\n\n' +
          (type === 'lesson' ? 'Напиши «Повтори урок» и подтверди «Урок изучен».' : 'Напиши «Тест» чтобы начать.')
        );
      }
    }

    // Алерт владельцу
    if (notDone.length > 0) {
      const typeLabel = type === 'lesson' ? 'урок' : 'тест';
      let ownerMsg = '⚠️ Дедлайн через 30 минут — не прошли ' + typeLabel + ':\n\n';
      notDone.forEach(s => { ownerMsg += '❌ ' + s.sellerName + '\n'; });
      ownerMsg += '\nЗафиксировано в KPI.';
      for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, ownerMsg);

      // Фиксируем нарушение в Дисциплина
      const today2 = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' });
      for (const s of notDone) {
        await appendSheet('Дисциплина!A:E', [
          today2, s.sellerName,
          type === 'lesson' ? 'Пропуск урока' : 'Пропуск теста',
          '23:30', 'Не выполнено до дедлайна — минус KPI'
        ], DASHBOARD_ID);
      }
    }
  } catch(e) { console.error('checkTrainingDeadline error:', e.message); }
}

async function showExpensesByMonth(userId, month, year, period) {
  try {
    const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const weekAgo = new Date(nowAlm); weekAgo.setDate(nowAlm.getDate() - 7);
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

    const naneRaw = await dbGetExpenses(month, year, false, userId);
    const personalRaw = await dbGetExpenses(month, year, true, userId);

    const naneExpenses = naneRaw.map(e => ({ date: e.expense_date, category: e.category||'Прочее', amount: Number(e.amount), description: e.description||'' }));
    const personalExpenses = personalRaw.map(e => ({ date: e.expense_date||'', description: e.description||'', amount: Number(e.amount), category: e.category||'Прочее' }));

    if (naneExpenses.length === 0 && personalExpenses.length === 0) {
      await sendTelegram(userId, '📊 Расходов за ' + (monthNames[month]||month) + ' ' + year + ' пока нет.');
      return;
    }

    let naneTotal = 0, personalTotal = 0;
    const naneBycat = {}, persBycat = {};

    naneExpenses.forEach(e => {
      if (!naneBycat[e.category]) naneBycat[e.category] = { sum:0, items:[] };
      naneBycat[e.category].sum += e.amount;
      naneBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
      naneTotal += e.amount;
    });
    personalExpenses.forEach(e => {
      if (!persBycat[e.category]) persBycat[e.category] = { sum:0, items:[] };
      persBycat[e.category].sum += e.amount;
      persBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
      personalTotal += e.amount;
    });

    let msg = '📊 Расходы — ' + (monthNames[month]||month) + ' ' + year + '\n\n';
    if (naneExpenses.length > 0) {
      msg += '🏪 NANE PARIS: ' + naneTotal.toLocaleString('ru-RU') + ' тг\n';
      Object.entries(naneBycat).forEach(([cat, data]) => {
        msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
        data.items.forEach(i => { msg += '    · ' + i + '\n'; });
      });
      msg += '\n';
    }
    if (personalExpenses.length > 0) {
      msg += '👤 Личные: ' + personalTotal.toLocaleString('ru-RU') + ' тг\n';
      Object.entries(persBycat).forEach(([cat, data]) => {
        msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
        data.items.forEach(i => { msg += '    · ' + i + '\n'; });
      });
      msg += '\n';
    }
    msg += '💰 Всего: ' + (naneTotal + personalTotal).toLocaleString('ru-RU') + ' тг';
    await sendTelegram(userId, msg);
  } catch(e) { console.error('showExpensesByMonth error:', e.message); }
}

async function showExpenses(userId, period) {
  try {
    const nowAlm = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const monthStart = nowAlm.getMonth() + 1;
    const yearNow = nowAlm.getFullYear();
    const weekAgo = new Date(nowAlm); weekAgo.setDate(nowAlm.getDate() - 7);

    // Читаем из Supabase
    const naneRaw = await dbGetExpenses(monthStart, yearNow, false, userId);
    const personalRaw = await dbGetExpenses(monthStart, yearNow, true, userId);
    console.log('showExpenses: naneRaw=', naneRaw.length, 'personalRaw=', personalRaw.length);

    const naneExpenses = naneRaw.filter(e => {
      if (period === 'week') return new Date(e.expense_date) >= weekAgo;
      return e.month === monthStart && e.year === yearNow;
    }).map(e => ({ date: e.expense_date, category: e.category||'Прочее', amount: Number(e.amount), description: e.description||'' }));

    const personalExpenses = personalRaw.filter(e => {
      const d = new Date(e.created_at);
      if (period === 'week') return d >= weekAgo;
      return d.getMonth()+1 === monthStart && d.getFullYear() === yearNow;
    }).map(e => ({ date: e.expense_date||'', description: e.description||'', amount: Number(e.amount), category: e.category||'Прочее' }));

    if (naneExpenses.length === 0 && personalExpenses.length === 0) {
      await sendTelegram(userId, '📊 Расходов за ' + (period==='week'?'неделю':'этот месяц') + ' пока нет.');
      return;
    }

    const periodLabel = period === 'week' ? 'неделю' : 'месяц';
    let naneTotal = 0, personalTotal = 0;
    const naneBycat = {}, persBycat = {};

    naneExpenses.forEach(e => {
      if (!naneBycat[e.category]) naneBycat[e.category] = { sum:0, items:[] };
      naneBycat[e.category].sum += e.amount;
      naneBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
      naneTotal += e.amount;
    });
    personalExpenses.forEach(e => {
      if (!persBycat[e.category]) persBycat[e.category] = { sum:0, items:[] };
      persBycat[e.category].sum += e.amount;
      persBycat[e.category].items.push(e.description + ' — ' + e.amount.toLocaleString('ru-RU') + ' тг');
      personalTotal += e.amount;
    });

    let msg = '📊 Расходы за ' + periodLabel + '\n\n';
    if (naneExpenses.length > 0) {
      msg += '🏪 NANE PARIS: ' + naneTotal.toLocaleString('ru-RU') + ' тг\n';
      Object.entries(naneBycat).forEach(([cat, data]) => {
        msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
        data.items.slice(0,3).forEach(i => { msg += '    · ' + i + '\n'; });
      });
      msg += '\n';
    }
    if (personalExpenses.length > 0) {
      msg += '👤 Личные: ' + personalTotal.toLocaleString('ru-RU') + ' тг\n';
      Object.entries(persBycat).forEach(([cat, data]) => {
        msg += '  📁 ' + cat + ': ' + data.sum.toLocaleString('ru-RU') + ' тг\n';
        data.items.slice(0,3).forEach(i => { msg += '    · ' + i + '\n'; });
      });
      msg += '\n';
    }
    msg += '💰 Всего: ' + (naneTotal + personalTotal).toLocaleString('ru-RU') + ' тг';
    await sendTelegram(userId, msg);
  } catch(e) { console.error('showExpenses error:', e.message); }
}

async function sendWeeklyTraining(forceLesson) {
  try {
    if (trainingPaused && !forceLesson) {
      console.log('Обучение на паузе — пропускаем');
      return;
    }
    console.log('Запускаю еженедельное обучение...');
    const sellers = Object.entries(ALLOWED_MAP).filter(([id]) => !OWNER_IDS.includes(id));
    if (sellers.length === 0) return;

    const almatyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const dayOfWeek = almatyNow.getDay(); // 1=пн, 5=пт
    // Понедельник = урок, Пятница = тест. Если вызвали вручную (forceLesson) — урок
    const isTestWeek = !forceLesson && dayOfWeek === 5;

    const topicIndex = currentTrainingWeek % TRAINING_TOPICS.length;
    if (!isTestWeek) currentTrainingWeek++; // увеличиваем только после урока
    const topic = TRAINING_TOPICS[topicIndex];

    if (!isTestWeek) {
      // НЕДЕЛЯ УРОКА — отправляем урок всем продавцам
      const lessonMsg = '📚 ОБУЧЕНИЕ NANE PARIS\n\n' +
        '🗓 Тема: ' + topic.topic + '\n' +
        '⏰ Дедлайн: сегодня до 23:59\n' +
        '━━━━━━━━━━━━━━━━━\n\n' +
        topic.lesson + '\n\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '⚠️ ВАЖНО: напиши «Урок изучен» до 23:59 сегодня.\n' +
        'Опоздание фиксируется и влияет на KPI и расчёт зарплаты в конце месяца.\n\n' +
        'В пятницу будет тест. Повторить материал: напиши «Повтори урок». Удачи! 💪';

      // Сохраняем урок для повторного доступа
      try {
        await supabase.from('last_reports').upsert({
          user_id: 'training_last_lesson',
          html: JSON.stringify({ topic: topic.topic, lesson: lessonMsg }),
          filename: 'lesson',
          caption: topic.topic
        }, { onConflict: 'user_id' });
      } catch(e) {}

      for (const [sellerId, sellerName] of sellers) {
        await sendTelegram(sellerId, lessonMsg);
        await new Promise(r => setTimeout(r, 1000));
      }
      // Уведомляем владельца
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId,
          '📚 Еженедельное обучение отправлено\n' +
          '📖 Тема: ' + topic.topic + '\n' +
          '👥 Продавцов: ' + sellers.length + '\n' +
          'На следующей неделе автоматически отправлю тест.'
        );
      }
    } else {
      // НЕДЕЛЯ ТЕСТА — отправляем тест всем продавцам
      const testMsg = '🎯 ТЕСТ — ' + topic.topic + '\n' +
        '⏰ Дедлайн: сегодня до 23:59\n\n' +
        '⚠️ Несданный тест фиксируется как нарушение и влияет на KPI и расчёт зарплаты.\n\n' +
        'Отвечай своими словами — я оценю каждый ответ.\n\n' +
        'Вопрос 1: Назови 3 главных правила из урока про «' + topic.topic + '».\n\n' +
        'Жду твой ответ! ✍️';

      for (const [sellerId] of sellers) {
        await sendTelegram(sellerId, testMsg);
        await new Promise(r => setTimeout(r, 1000));
      }
      for (const ownerId of OWNER_IDS) {
        await sendTelegram(ownerId,
          '🎯 Тест по теме «' + topic.topic + '» отправлен продавцам.\n' +
          'Результаты придут после ответов.'
        );
      }
    }
  } catch(e) { console.error('sendWeeklyTraining error:', e.message); }
}

function startDailyScheduler() {
  // Проверяем напоминания каждую минуту
  setInterval(() => { checkReminders(); }, 60000);

  setInterval(() => {
    const now = new Date();
    const almatyTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    const hours = almatyTime.getHours();
    const minutes = almatyTime.getMinutes();
    const seconds = almatyTime.getSeconds();
    // Запускаем в 09:00:00 - 09:00:59
    if (hours === 9 && minutes === 0 && seconds < 60) {
      const todayKey = almatyTime.toDateString();
      if (startDailyScheduler.lastRun !== todayKey) {
        startDailyScheduler.lastRun = todayKey;
        sendMorningDigest();
        // По понедельникам — сводка по дисциплине (0 = воскресенье, 1 = понедельник)
        if (almatyTime.getDay() === 1) {
          sendWeeklyDisciplineReport();
          sendWeeklySalesReport();
        }
        // Понедельник 12:00 — урок, Пятница 12:00 — тест
        if ((almatyTime.getDay() === 1 || almatyTime.getDay() === 5) && hours === 12 && minutes === 0) {
          sendWeeklyTraining();
        }
        // Понедельник 23:30 — напоминание не прошедшим урок
        if (almatyTime.getDay() === 1 && hours === 23 && minutes === 30) {
          checkTrainingDeadline('lesson');
        }
        // Пятница 23:30 — напоминание не сдавшим тест
        if (almatyTime.getDay() === 5 && hours === 23 && minutes === 30) {
          checkTrainingDeadline('test');
        }
      }
    }
  }, 30000); // проверяем каждые 30 секунд
  console.log('Планировщик дайджеста запущен — каждый день в 09:00');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Томи Telegram запущена на порту ' + PORT);
  await restoreOpenShifts();
  startDailyScheduler();
  const webhookUrl = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/webhook';
  const body = JSON.stringify({ url: webhookUrl });
  https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + TELEGRAM_TOKEN + '/setWebhook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log('Webhook установлен:', data));
  }).end(body);
});
