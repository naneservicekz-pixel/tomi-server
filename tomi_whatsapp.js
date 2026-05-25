// ══════════════════════════════════════════════════════════════════════
// ТОМИ — Telegram AI Управляющий NANE PARIS
// Версия 4.0 — исправлен дашборд: данные, ФОТ с разбивкой, светлый дизайн
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
  try { await supabase.from('open_shifts').upsert({ phone: String(userId), ...shiftData }, { onConflict: 'phone' }); } catch(e) {}
}

async function deleteOpenShift(userId) {
  try { await supabase.from('open_shifts').delete().eq('phone', String(userId)); } catch(e) {}
}

// Сохраняем остаток кассы после закрытия смены
async function saveLastCash(cashActual) {
  try {
    await supabase.from('open_shifts').upsert(
      { phone: 'last_cash_balance', cashActual, updated_at: new Date().toISOString() },
      { onConflict: 'phone' }
    );
  } catch(e) {}
}

// Читаем остаток кассы от последней закрытой смены
async function loadLastCash() {
  try {
    const { data } = await supabase.from('open_shifts').select('cashActual').eq('phone', 'last_cash_balance').maybeSingle();
    return data ? (parseFloat(data.cashActual) || 0) : null;
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
    const rows = await readSheet("'Учёт по дням'!B6:B200", DASHBOARD_ID);
    const nextRow = 6 + (rows ? rows.filter(r => r[0]).length : 0);
    const num = nextRow - 5;
    const { api } = getSheets(DASHBOARD_ID);
    await api.spreadsheets.values.update({
      spreadsheetId: DASHBOARD_ID,
      range: "'Учёт по дням'!A" + nextRow + ":E" + nextRow,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[num, date, rostaTotal, seller1 || '', seller2 || '']] }
    });
    console.log('Записано в Учёт по дням строка', nextRow);
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
    // Читаем два листа параллельно
    const [dash, itogi] = await Promise.all([
      readSheet("'Дашборд'!A1:H25", DASHBOARD_ID),
      readSheet("'Итоги месяца'!A1:H18", DASHBOARD_ID)
    ]);

    // Вспомогательная функция — безопасно достать значение и распарсить число
    const num = (rows, rowIdx, colIdx) => {
      try {
        const v = rows[rowIdx] && rows[rowIdx][colIdx] != null ? rows[rowIdx][colIdx] : '';
        return parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
      } catch(e) { return 0; }
    };

    // ── Лист "Дашборд" ────────────────────────────────────────────
    // Строка 6  (индекс 5)  — план магазина, колонка C (индекс 2)
    // Строка 14 (индекс 13) — личный план: C=Асель, D=Зарина, E=Луиза, G=Итого
    // Строка 19 (индекс 18) — оборот факт: C=Асель, D=Зарина, E=Луиза, G=Итого
    // Строка 22 (индекс 21) — осталось до плана: C=Асель, D=Зарина, E=Луиза, G=Итого

    const plan       = num(dash, 5, 2) || 27000000;

    const aselFact   = num(dash, 18, 2);
    const zarinaFact = num(dash, 18, 3);
    const luizaFact  = num(dash, 18, 4);
    const totalFact  = num(dash, 18, 6) || (aselFact + zarinaFact + luizaFact);

    const aselPlan   = num(dash, 13, 2);
    const zarinaPlan = num(dash, 13, 3);
    const luizaPlan  = num(dash, 13, 4);

    const aselLeft   = num(dash, 21, 2);
    const zarinaLeft = num(dash, 21, 3);
    const luizaLeft  = num(dash, 21, 4);
    const totalLeft  = num(dash, 21, 6) || Math.max(0, plan - totalFact);

    const aselPct    = aselPlan  > 0 ? Math.round(aselFact  / aselPlan  * 100) : 0;
    const zarinaPct  = zarinaPlan > 0 ? Math.round(zarinaFact / zarinaPlan * 100) : 0;
    const luizaPct   = luizaPlan  > 0 ? Math.round(luizaFact  / luizaPlan  * 100) : 0;
    const totalPct   = plan > 0 ? Math.round(totalFact / plan * 100) : 0;

    // ── Лист "Итоги месяца" ───────────────────────────────────────
    // Строка 14 (индекс 13) — Асель:  B=Выход, C=%прод, D=БонусХорДень, E=Рекорд, F=БонусПлан, G=KPI, H=ИТОГО
    // Строка 15 (индекс 14) — Зарина
    // Строка 16 (индекс 15) — Луиза
    // Строка 18 (индекс 17) — ИТОГО ФОТ

    const aselFix     = num(itogi, 13, 1);
    const aselProcent = num(itogi, 13, 2);
    const aselBonus   = num(itogi, 13, 3);
    const aselRekord  = num(itogi, 13, 4);
    const aselPlanB   = num(itogi, 13, 5);
    const aselTotal   = num(itogi, 13, 7);

    const zarinaFix     = num(itogi, 14, 1);
    const zarinaProcent = num(itogi, 14, 2);
    const zarinaBonus   = num(itogi, 14, 3);
    const zarinaRekord  = num(itogi, 14, 4);
    const zarinaPlanB   = num(itogi, 14, 5);
    const zarinaTotal   = num(itogi, 14, 7);

    const luizaFix     = num(itogi, 15, 1);
    const luizaProcent = num(itogi, 15, 2);
    const luizaBonus   = num(itogi, 15, 3);
    const luizaRekord  = num(itogi, 15, 4);
    const luizaPlanB   = num(itogi, 15, 5);
    const luizaTotal   = num(itogi, 15, 7);

    const totalFot = num(itogi, 17, 7) || (aselTotal + zarinaTotal + luizaTotal);

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
    <div class="brand-sub">Дашборд продаж — Май 2026</div>
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
  const { sellerName, date, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs } = data;
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
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт смены — ${sellerName}</title>
<style>* { box-sizing:border-box; margin:0; padding:0; } body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f5f5f0; color:#1a1a1a; padding:24px 16px; } .container { max-width:680px; margin:0 auto; } .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; } .brand { font-size:22px; font-weight:600; letter-spacing:0.04em; } .brand-sub { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.1em; margin-top:2px; } .header-right { text-align:right; font-size:13px; color:#555; } .header-right strong { color:#1a1a1a; display:block; font-size:14px; } .grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; } .grid2 { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:16px; } .metric { background:#efefea; border-radius:8px; padding:14px; } .metric-label { font-size:11px; color:#888; margin-bottom:6px; } .metric-value { font-size:20px; font-weight:600; } .card { background:#fff; border:1px solid #e8e8e4; border-radius:12px; padding:14px; } .card-title { display:flex; align-items:center; gap:7px; margin-bottom:12px; font-size:13px; font-weight:600; } .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; } .row { display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid #f0f0ec; } .row-label { color:#888; } .row-value { font-weight:500; } .row-total { display:flex; justify-content:space-between; font-size:13px; font-weight:600; padding:8px 0 0; } .sverka-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }</style></head>
<body><div class="container">
  <div class="header"><div><div class="brand">NANÉ PARIS</div><div class="brand-sub">Отчёт смены</div></div><div class="header-right"><strong>${date}</strong>${sellerName} · закрыто в ${closeTime}</div></div>
  <div style="background:${statusBg}; border:1px solid ${statusBorder}; border-radius:8px; padding:10px 14px; display:flex; align-items:center; gap:8px; margin-bottom:20px;"><div style="width:8px; height:8px; border-radius:50%; background:${statusDot}; flex-shrink:0;"></div><span style="font-size:13px; font-weight:600; color:${statusColor};">${statusText}</span></div>
  <div class="grid3">
    <div class="metric"><div class="metric-label">Продажи (ROSTA)</div><div class="metric-value">${fmt(rostaTotal)}</div></div>
    <div class="metric"><div class="metric-label">Получено деньгами</div><div class="metric-value">${fmt(factTotal)}</div></div>
    <div class="metric"><div class="metric-label">Расхождение</div><div class="metric-value" style="color:${diffColor};">${diffSign}${fmt(diff)}</div></div>
  </div>
  ${diffDetails}
  <div class="grid3">
    <div class="card"><div class="card-title"><div class="dot" style="background:#378ADD"></div>Kaspi</div>
      <div class="row"><span class="row-label">Онлайн <small>(ROSTA)</small></span><span class="row-value">${fmt(s.rOnline)}</span></div>
      <div class="row"><span class="row-label">QR <small>(ROSTA)</small></span><span class="row-value">${fmt(s.rKaspi)}</span></div>
      <div class="row"><span class="row-label">Терминал <small>(ФАКТ)</small></span><span class="row-value">${fmt(s.tKaspi)}</span></div>
      ${(s.tKaspiRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tKaspiRet)+'</span></div>':''}
      <div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(kaspiNet)}</span></div>
    </div>
    <div class="card"><div class="card-title"><div class="dot" style="background:#7F77DD"></div>Halyk</div>
      <div class="row"><span class="row-label">Онлайн <small>(ROSTA)</small></span><span class="row-value">${fmt(s.rHalykOnline)}</span></div>
      <div class="row"><span class="row-label">QR <small>(ROSTA)</small></span><span class="row-value">${fmt(s.rHalyk)}</span></div>
      <div class="row"><span class="row-label">Терминал <small>(ФАКТ)</small></span><span class="row-value">${fmt(s.tHalyk)}</span></div>
      ${(s.tHalykRet||0)>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возврат (ФАКТ)</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.tHalykRet)+'</span></div>':''}
      <div class="row-total"><span>Итого (ФАКТ)</span><span>${fmt(halykNet)}</span></div>
    </div>
    <div class="card"><div class="card-title"><div class="dot" style="background:#1D9E75"></div>Прочие</div>
      <div class="row"><span class="row-label">Наличные</span><span class="row-value">${fmt(s.rCash)}</span></div>
      ${(s.rPersonal||0)>0?'<div class="row"><span class="row-label">Личная карта <small>(ROSTA)</small></span><span class="row-value">'+fmt(s.rPersonal)+'</span></div>':''}
      ${(s.rBonus||0)>0?'<div class="row"><span class="row-label">Бонусы</span><span class="row-value">'+fmt(s.rBonus)+'</span></div>':''}
      ${totalRet>0?'<div class="row"><span class="row-label" style="color:#E24B4A">Возвраты</span><span class="row-value" style="color:#E24B4A">-'+fmt(totalRet)+'</span></div>':''}
      <div class="row-total"><span>Итого</span><span>${fmt((s.rCash||0)+(s.rPersonal||0)+(s.rBonus||0))}</span></div>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><div class="card-title">💵 Касса</div>
      <div class="row"><span class="row-label">Открытие</span><span class="row-value">${fmt(s.cashOpen)}</span></div>
      <div class="row"><span class="row-label">Закрытие</span><span class="row-value">${fmt(s.cashActual)}</span></div>
      <div class="row"><span class="row-label">Продажи нал</span><span class="row-value">${fmt(cashSales)}</span></div>
      ${(s.inkasso||0)>0?'<div class="row"><span class="row-label">Инкассация</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.inkasso)+'</span></div>':''}
      ${(s.cashPayouts||0)>0?'<div class="row"><span class="row-label">Расходы</span><span class="row-value" style="color:#E24B4A">-'+fmt(s.cashPayouts)+'</span></div>':''}
    </div>
    <div class="card"><div class="card-title">🔍 Сверка</div>
      <div class="row"><span class="row-label">ROSTA</span><span class="row-value">${fmt(rostaTotal)}</span></div>
      <div class="row"><span class="row-label">ФАКТ</span><span class="row-value">${fmt(factTotal)}</span></div>
      <div class="row"><span class="row-label">Разница</span><span class="row-value" style="color:${diffColor}; font-weight:600;">${diffSign}${fmt(diff)}</span></div>
    </div>
  </div>
  <div class="sverka-grid">
    ${[{label:'Kaspi',diff:Math.abs(kaspiNet-((s.rKaspi||0)+(s.rOnline||0)))},{label:'Halyk',diff:Math.abs(halykNet-((s.rHalyk||0)+(s.rHalykOnline||0)))},{label:'Наличные',diff:0}].map(item => {
      const ok = item.diff <= 500;
      return '<div style="background:'+(ok?'#eaf3de':'#fcebeb')+'; border:1px solid '+(ok?'#c0dd97':'#F7C1C1')+'; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:11px; color:#888; margin-bottom:4px;">'+item.label+'</div><div style="font-size:13px; font-weight:600; color:'+(ok?'#3B6D11':'#A32D2D')+';">'+(ok?'Сходится':'Расхождение')+'</div></div>';
    }).join('')}
  </div>
</div></body></html>`;
}

async function loadOwnerData() {
  const [shifts, prepays] = await Promise.all([readSheet('Смены!A:Y'), readSheet('Предоплаты!A:K')]);
  const recentShifts = shifts.slice(-30).map(r => ({ date: r[0], seller: r[1], rostaTotal: r[19], factTotal: r[20], diff: r[21], status: r[22] }));
  const openPrepays = prepays.slice(1).filter(r => r[0] && String(r[8]||'').toLowerCase().includes('открыт')).map(r => ({ id: r[0], date: r[1], client: r[2], phone: r[3], item: r[4], channel: r[5], amount: r[6], balance: r[7] }));
  return { recentShifts, openPrepays };
}

async function loadPrepays(type) {
  const rows = await readSheet('Предоплаты!A:K');
  const prepMap = {};
  rows.slice(1).forEach(r => {
    if (!r[0]) return;
    const prepId = String(r[0]).trim();
    if (!prepId.toUpperCase().startsWith('PREP')) return;
    const client = String(r[2]||'').trim();
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
      'После "Геолокация принята (открытие)" => SECOND_ARRIVE:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'После подтверждения — поприветствуй и пожелай хорошей смены. Больше ничего не спрашивай.\n\n' +
      'УХОД (второй продавец уходит раньше закрытия):\n' +
      'Когда пишет "Ухожу" или "Заканчиваю" — попроси геолокацию.\n' +
      'После "Геолокация принята (закрытие)" => SECOND_LEAVE:{"seller":"' + sellerName + '","time":"' + now + '"}\n' +
      'Попрощайся и пожелай хорошего вечера.\n\n' +
      'ПРЕДОПЛАТЫ (доступны всегда, без открытия смены):\n' +
      'Новая => PREPAY_SAVE:{"client":"","phone":"","item":"","channel":"","amount":0,"balance":0,"date":"","notes":""}\n' +
      'Выкуп => PREPAY_LIST:открытые => PREPAY_CLOSE:{"id":"PREP-XXXX","closeDate":"","notes":"Товар выдан"}\n\n' +
      'ВАЖНО: на приветствия без "Начала смену" просто отвечай приветствием — НЕ начинай чек-лист.';
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
    'Просмотр => PREPAY_LIST:открытые или PREPAY_LIST:закрытые\n' +
    'ВАЖНО: если продавец спрашивает про предоплату — обрабатывай сразу, не требуй сначала открыть смену.\n\n' +

    'ЧЕК-ЛИСТ ОТКРЫТИЯ (строго по порядку, один шаг за раз, не повторять уже отвеченные шаги):\n' +
    'КРИТИЧНО: каждый шаг задаётся ОДИН РАЗ. Если продавец уже ответил на вопрос — не спрашивай снова.\n' +
    'Проверяй историю диалога перед каждым вопросом — если ответ уже есть, переходи к следующему шагу.\n\n' +
    'ШАГ 0 — ВНЕШНИЙ ВИД\n' +
    'Спроси: макияж готов? одежда в порядке?\n' +
    'Если позже 11:00 => LATE_ALERT:{"seller":"' + sellerName + '","time":"' + now + '"}\n\n' +
    'ШАГ 1 — ГЕОЛОКАЦИЯ\n' +
    'Спроси: "Пришли геолокацию через скрепку."\n' +
    'После "Геолокация принята (открытие)" — переходи к шагу 2.\n\n' +
    'ШАГ 2 — КАССА\n' +
    'Спроси: сколько наличных в кассе на начало смены?\n' +
    'Запомни сумму — она войдёт в SHIFT_OPEN как cashOpen.\n' +
    'ВАЖНО: система автоматически сравнит эту сумму с остатком предыдущей смены.\n' +
    'Если продавец сообщила расхождение кассы — потребуй объяснение до продолжения чек-листа.\n\n' +
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
    'После "да" — выдай SHIFT_OPEN с суммой кассы из шага 2:\n' +
    '=> SHIFT_OPEN:{"seller":"' + sellerName + '","shop":"' + shopName + '","cashOpen":0,"time":"' + now + '"}\n\n' +

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
    'После "Геолокация принята (закрытие)" — передай все данные включая объяснения расхождений в notes:\n' +
    '=> SHIFT_CLOSE:{...,"notes":"объяснение расхождений если были"}\n\n' +
    'КРИТИЧНО: система сама заблокирует закрытие если в notes нет объяснения при расхождении >500 тг.\n' +
    'Ты как AI должна САМА провести анализ — не просто принять цифры, а проверить логику.\n' +
    'Если продавец говорит "не знаю" — это не объяснение. Дожимай до конкретной причины.\n\n' +
    'rKaspi=QR Kaspi ROSTA, rOnline=Онлайн Kaspi ROSTA, rHalyk=QR Halyk ROSTA, rHalykOnline=Онлайн Halyk ROSTA\n' +
    'rCash=Наличные, rPersonal=Личная карта ROSTA, rBonus=Бонусы\n' +
    'tKaspi=Kaspi ФАКТ, tKaspiRet=возврат Kaspi, tHalyk=Halyk ФАКТ, tHalykRet=возврат Halyk\n' +
    'cashOpen=начало, cashActual=конец\n' +
    '=> SHIFT_CLOSE:{"rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tKaspiRet":0,"tHalyk":0,"tHalykRet":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"prepayIn":0,"prepayOut":0,"shiftStatus":"","notes":""}\n\n' +
    'Необъясненное расхождение >500 тг — НЕ ЗАКРЫВАЙ смену, уточни причину. Один вопрос за раз.';
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
    '"Команда" — сводка по продавцам\n' +
    '"Зарплата" — расчет ФОТ\n' +
    '"Дашборд" => DASHBOARD_HTML\n' +
    '"Дайджест" — утренняя сводка прямо сейчас => DIGEST_NOW\n' +
    '"Инкассация [сумма]" => OWNER_INKASSO:{"amount":0,"time":"' + now + '"}\n\n' +
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

async function handleSystemCommands(reply, userId, sellerName) {
  let cleanReply = reply;

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
        const rows = await readSheet('Предоплаты!A:A');
        let maxNum = 0;
        rows.forEach(r => { const m = String(r[0]||'').match(/PREP-(\d+)/i); if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; } });
        const id = 'PREP-' + String(maxNum + 1).padStart(4, '0');
        await appendSheet('Предоплаты!A:K', [id, p.date||today, p.client||'', phone.length>4?phone:'', p.item||'', p.channel||'', p.amount||0, p.balance||0, '🟡 Открыта', '', p.notes||sellerName]);
      }
    } catch(e) {}
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
            await updateSheetCell('Предоплаты!I' + (i+1), '🟢 Закрыта');
            await updateSheetCell('Предоплаты!J' + (i+1), p.closeDate||new Date().toISOString().split('T')[0]);
            await updateSheetCell('Предоплаты!K' + (i+1), p.notes||'Товар выдан');
            break;
          }
        }
      }
    } catch(e) {}
    cleanReply = reply.replace(/PREPAY_CLOSE:\{.*?\}/s, '').trim();
  }

  if (reply.includes('SHIFT_OPEN:')) {
    try {
      const jsonStr = reply.match(/SHIFT_OPEN:(\{.*?\})/s)?.[1];
      if (jsonStr) {
        const s = JSON.parse(jsonStr);

        // ── Проверка остатка кассы от предыдущей смены ──────────────
        const lastCash = await loadLastCash();
        const cashOpen = parseFloat(s.cashOpen) || 0;
        if (lastCash !== null) {
          const cashDiff = cashOpen - lastCash;
          if (Math.abs(cashDiff) > 500) {
            const direction = cashDiff > 0 ? 'ИЗЛИШЕК' : 'НЕДОСТАЧА';
            const sign = cashDiff > 0 ? '+' : '';

            // Алерт продавцу
            await sendTelegram(userId,
              '⚠️ РАСХОЖДЕНИЕ КАССЫ при открытии!\n\n' +
              '💰 Остаток прошлой смены: ' + Number(lastCash).toLocaleString() + ' тг\n' +
              '💰 Ты пересчитала: ' + Number(cashOpen).toLocaleString() + ' тг\n' +
              '❌ ' + direction + ': ' + sign + Number(cashDiff).toLocaleString() + ' тг\n\n' +
              'Пересчитай кассу ещё раз и объясни причину расхождения.'
            );

            // Алерт владельцу
            for (const ownerId of OWNER_IDS) {
              await sendTelegram(ownerId,
                '🚨 РАСХОЖДЕНИЕ КАССЫ при открытии!\n' +
                '👤 ' + s.seller + ' · ' + getTime() + '\n\n' +
                '💰 Закрыли вчера: ' + Number(lastCash).toLocaleString() + ' тг\n' +
                '💰 Открыли сегодня: ' + Number(cashOpen).toLocaleString() + ' тг\n' +
                '❌ ' + direction + ': ' + sign + Number(cashDiff).toLocaleString() + ' тг'
              );
            }
          }
        }

        const shiftData = { seller: s.seller, shop: s.shop, cashOpen: s.cashOpen, time: s.time, start_time: new Date().toISOString() };
        openShifts[String(userId)] = shiftData;
        await saveOpenShift(userId, shiftData);
        const timeStr = getTime();
        const hour = parseInt(timeStr.split(':')[0]);
        const min = parseInt(timeStr.split(':')[1]);
        if (hour > 11 || (hour === 11 && min > 15)) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + s.seller + '\n🕐 ' + timeStr);
        }
        if ((s.cashOpen||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ — касса\nНаличных: ' + Number(s.cashOpen).toLocaleString() + ' тг\n👤 ' + s.seller);
        }
      }
    } catch(e) {}
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

        // Если есть необъяснённые расхождения — БЛОКИРУЕМ закрытие
        const hasNotes = s.notes && s.notes.trim().length > 10;
        if (channelDiffs.length > 0 && !hasNotes) {
          // Формируем детальное сообщение с требованием объяснения
          let blockMsg = '🚫 СМЕНА НЕ ЗАКРЫТА — есть необъяснённые расхождения!\n\n';
          channelDiffs.forEach(cd => {
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

          // Алерт владельцу о расхождении
          let ownerAlert = '⚠️ РАСХОЖДЕНИЕ при закрытии смены!\n👤 ' + (shift.seller || sellerName) + ' · ' + today + '\n\n';
          channelDiffs.forEach(cd => {
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

        await appendSheet('Смены!A:Y', [
          today, sellerFinal, shift.shop||'',
          s.rKaspi||0, s.rOnline||0, s.rHalyk||0, s.rHalykOnline||0,
          s.rCash||0, s.rPersonal||0, s.rBonus||0,
          s.rRetKaspi||0, s.rRetHalyk||0,
          s.inkasso||0, s.cashPayouts||0, s.cashOpen||0, s.cashActual||0,
          s.tKaspi||0, s.tHalyk||0, s.rPersonal||0,
          rostaTotal, factTotal, diff,
          diff===0 ? 'Корректно' : Math.abs(diff)<500 ? 'Незначительное' : 'Расхождение (объяснено)',
          s.notes||'', getNow()
        ]);

        await writeToUchetPoDnyam(today, rostaTotal, sellerFinal, '');

        // Сохраняем остаток кассы для проверки при следующем открытии
        await saveLastCash(s.cashActual || 0);

        if ((s.cashActual||0) >= CASH_ALERT_LIMIT) {
          for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '💰 АЛЕРТ ИНКАССАЦИИ\nНаличных: ' + Number(s.cashActual).toLocaleString() + ' тг\n👤 ' + sellerFinal);
        }

        const htmlReport = generateShiftHTML({ sellerName: sellerFinal, date: today, closeTime, rostaTotal, factTotal, diff, s, kaspiNet, halykNet, cashSales, totalRet, channelDiffs });
        const filename = 'otchet_' + today.replace(/\./g,'_') + '_' + sellerFinal + '.html';
        for (const ownerId of OWNER_IDS) {
          await sendTelegramDocument(ownerId, filename, htmlReport, '📊 Отчет смены — ' + sellerFinal + ' · ' + today + ' · ' + closeTime);
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
        for (const ownerId of OWNER_IDS) await sendTelegram(ownerId, '⚠️ Опоздание!\n👤 ' + a.seller + '\n🕐 ' + (a.time || getTime()));
      }
    } catch(e) {}
    cleanReply = reply.replace(/LATE_ALERT:\{.*?\}/s, '').trim();
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

  return cleanReply;
}

async function handleMessage(userId, messageText, photoFileId) {
  const senderName = ALLOWED_MAP[String(userId)];
  if (!senderName) { await sendTelegram(userId, '🔒 Доступ закрыт.'); return; }
  const isOwner = OWNER_IDS.includes(String(userId));
  const userKey = String(userId);

  if (!conversations[userKey]) conversations[userKey] = await loadConversation(userId);
  if (!openShifts[userKey]) {
    const dbShift = await loadOpenShift(userId);
    if (dbShift) openShifts[userKey] = dbShift;
  }
  const hasOpenShift = !!openShifts[userKey];

  // Определяем: второй продавец — если у него нет своей смены,
  // но у ДРУГОГО продавца смена уже открыта сегодня
  let isSecondSeller = false;
  let firstSellerName = '';
  if (!isOwner && !hasOpenShift) {
    for (const [otherId, shiftData] of Object.entries(openShifts)) {
      if (otherId !== userKey && shiftData && shiftData.seller) {
        isSecondSeller = true;
        firstSellerName = shiftData.seller;
        break;
      }
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

    const cleanReply = await handleSystemCommands(reply, userId, senderName);
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
      const action = pendingGeoAction[userId] || 'close_shift';
      delete pendingGeoAction[userId];
      if (action === 'open_shift') {
        await handleMessage(userId, 'Геолокация принята (открытие). Продавец в магазине. Расстояние: ' + distance + ' м. Продолжай чек-лист.', null);
      } else {
        await handleMessage(userId, 'Геолокация принята (закрытие). Продавец в магазине. Расстояние: ' + distance + ' м.', null);
      }
      return;
    }

    if (messageText) {
      const lower = messageText.toLowerCase();
      if (lower.includes('начала смену') || lower.includes('открываю смену') || lower.includes('начинаю смену')) {
        pendingGeoAction[userId] = 'open_shift';
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
function startDailyScheduler() {
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
