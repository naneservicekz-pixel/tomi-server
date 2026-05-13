const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1QUEXZbRT5TwfjwolwnIYoMQhA5naaQzzOzkxP3kxl0';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

const conversations = {};

function getServiceAccountKey() {
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch (e) {
    console.error('Ошибка парсинга ключа:', e.message);
    return null;
  }
}

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getGoogleToken() {
  const key = getServiceAccountKey();
  if (!key) throw new Error('Нет ключа сервис-аккаунта');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const signature = sign.sign(key.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = header + '.' + payload + '.' + signature;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Нет токена: ' + JSON.stringify(data));
  return data.access_token;
}

async function sheetsAppend(sheetName, values) {
  const token = await getGoogleToken();
  const range = encodeURIComponent(sheetName + '!A1');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID + '/values/' + range + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] })
  });
  return res.json();
}

async function sheetsRead(range) {
  const token = await getGoogleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID + '/values/' + encodeURIComponent(range);
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  const data = await res.json();
  return data.values || [];
}

function n(v) {
  var p = parseFloat(String(v || 0).replace(/\s/g, '').replace(',', '.'));
  return isNaN(p) ? 0 : p;
}

async function getOpenPrepays() {
  try {
    const rows = await sheetsRead('Предоплаты!A2:L1000');
    const open = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;
      var hasClientID = String(row[1] || '').indexOf('CL-') === 0;
      var statusIdx = hasClientID ? 9 : 8;
      var status = String(row[statusIdx] || '').toLowerCase();
      if (status.indexOf('закрыта') !== -1) continue;
      if (hasClientID) {
        open.push({ id: row[0], date: row[2], client: row[3], phone: row[4], item: row[5], channel: row[6], amount: n(row[7]), balance: n(row[8]), notes: row[11] || '' });
      } else {
        open.push({ id: row[0], date: row[1], client: row[2], phone: row[3], item: row[4], channel: row[5], amount: n(row[6]), balance: n(row[7]), notes: row[10] || '' });
      }
    }
    return open;
  } catch (e) {
    console.error('getOpenPrepays error:', e.message);
    return [];
  }
}

async function getClosedPrepays() {
  try {
    const rows = await sheetsRead('Предоплаты!A2:L1000');
    const closed = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;
      var hasClientID = String(row[1] || '').indexOf('CL-') === 0;
      var statusIdx = hasClientID ? 9 : 8;
      var status = String(row[statusIdx] || '').toLowerCase();
      if (status.indexOf('закрыта') === -1) continue;
      var closeDateIdx = hasClientID ? 10 : 9;
      if (hasClientID) {
        closed.push({ id: row[0], date: row[2], client: row[3], phone: row[4], item: row[5], channel: row[6], amount: n(row[7]), balance: n(row[8]), closeDate: row[closeDateIdx] || '', notes: row[11] || '' });
      } else {
        closed.push({ id: row[0], date: row[1], client: row[2], phone: row[3], item: row[4], channel: row[5], amount: n(row[6]), balance: n(row[7]), closeDate: row[closeDateIdx] || '', notes: row[10] || '' });
      }
    }
    return closed;
  } catch (e) {
    console.error('getClosedPrepays error:', e.message);
    return [];
  }
}

async function saveShift(shiftData) {
  try {
    const d = shiftData;
    const rostaTotal = n(d.rKaspi)+n(d.rOnline)+n(d.rHalyk)+n(d.rHalykOnline)+n(d.rCash)+n(d.rPersonal)+n(d.rBonus)-n(d.rRetKaspi)-n(d.rRetHalyk)-n(d.rRetCash);
    const cashFact = n(d.cashActual)-n(d.cashOpen)+n(d.cashPayouts)+n(d.inkasso)+n(d.rRetCash);
    const factTotal = (n(d.tKaspi)-n(d.rRetKaspi))+(n(d.tHalyk)-n(d.rRetHalyk))+cashFact+n(d.tPersonal)+n(d.rBonus);
    const diff = factTotal - rostaTotal;
    const now = new Date();
    const astana = new Date(now.getTime() + 5*60*60*1000);
    const row = [
      d.date || astana.toISOString().split('T')[0], d.seller || '',
      n(d.rKaspi), n(d.rOnline), n(d.rHalyk), n(d.rHalykOnline), n(d.rCash), n(d.rPersonal), n(d.rBonus),
      n(d.rRetKaspi), n(d.rRetHalyk), n(d.rRetCash),
      n(d.inkasso), n(d.cashPayouts), n(d.cashOpen), n(d.cashActual),
      n(d.tKaspi), n(d.tHalyk), n(d.tPersonal),
      rostaTotal, factTotal, diff,
      d.shiftStatus || '', d.notes || '',
      astana.toLocaleString('ru-RU')
    ];
    await sheetsAppend('Смены', row);
    console.log('Смена сохранена:', d.date, d.seller);
    return true;
  } catch (e) {
    console.error('saveShift error:', e.message);
    return false;
  }
}

async function extractAndSaveShift(chatId, convs) {
  try {
    const history = convs[chatId] || [];
    const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 500,
        system: 'Извлеки данные закрытия смены из разговора. Верни ТОЛЬКО валидный JSON без комментариев.',
        messages: [{
          role: 'user',
          content: 'Разговор:\n' + history.slice(-20).map(function(m) { return m.role + ': ' + m.content; }).join('\n') +
            '\n\nВерни JSON (0 если не упоминалось):\n{"date":"YYYY-MM-DD","seller":"","rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tHalyk":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"shiftStatus":"ok","notes":""}'
        }]
      })
    });
    const extractData = await extractResponse.json();
    const jsonText = extractData.content[0].text.trim();
    const shiftData = JSON.parse(jsonText);
    await saveShift(shiftData);
  } catch (e) {
    console.error('extractAndSaveShift error:', e.message);
  }
}

const TOMI_SYSTEM = 'Ты — Томи, ИИ-управляющий сети магазинов NANE PARIS.\n\nЛИЧНОСТЬ:\n- Строгий при ошибках, тёплый при успехе\n- Только русский язык\n- Короткие сообщения — продавец читает с телефона\n- Эмодзи умеренно: ✅ ⚠️ 🚨 💰 📋 📦\n\nМАГАЗИН:\n- Продавцы: Зарина, Айнур, Луиза, Асель\n- Руководитель: Ермек\n- Открытие: 11:00 (прийти в 10:45)\n- Лимит кассы: 100 000 тенге\n\nКАНАЛЫ ОПЛАТЫ:\n- Kaspi QR + Онлайн Kaspi = терминал Kaspi\n- Halyk QR + Онлайн Halyk = терминал Halyk\n- Наличные = касса\n- Личная карта = отдельный канал\n\nМОДУЛЬ 1: ОТКРЫТИЕ СМЕНЫ\nТриггер: "открытие", "открываю смену"\n1. Спроси имя и магазин\n2. Зафикси время (после 11:00 — предупреди)\n3. Чек-лист: касса → терминалы → витрина\n\nМОДУЛЬ 2: ПРЕДОПЛАТА\nТриггер: "предоплата", "задаток"\nСпрашивай по одному: ФИО, телефон, товар, канал, сумма, задаток. Рассчитай остаток.\n\nМОДУЛЬ 3: РАСХОД\nТриггер: "расход", "трата"\nСпроси сумму и цель.\n\nМОДУЛЬ 4: ИНКАССАЦИЯ\nТриггер: "инкассация"\nСпроси сумму и кто забрал.\n\nМОДУЛЬ 5: ЗАКРЫТИЕ СМЕНЫ\nТриггер: "закрытие", "закрываю смену"\n\nШАГ 1 — Чек-лист: витрина, касса, терминалы, сигнализация\nШАГ 2 — Z-отчёт ROSTA по одному: Kaspi QR, Онлайн Kaspi, Halyk QR, Онлайн Halyk, Наличные, Личная карта, Бонусы, Возвраты\nШАГ 3 — Терминалы: Kaspi итог, Halyk итог\nШАГ 4 — Касса: начало, конец, выплаты, инкассация\nШАГ 5 — СВЕРКА:\nROSTA итого = все каналы минус возвраты\nФакт итого = терминалы + касса факт + личная + бонусы\nРасхождение = Факт - ROSTA\nШАГ 6 — АНАЛИЗ расхождений\nШАГ 7 — ИТОГ с таблицей по каналам ✅/⚠️/🚨\nШАГ 8 — Скажи "Смена сохранена ✅". Пожелай хорошей ночи.\n\nМОДУЛЬ 6: ВЫДАЧА ТОВАРА\nТриггер: "выдала товар", "клиент забрал"\nСпроси ID или имя. Закрой предоплату.\n\nМОДУЛЬ 7: ЗАПРОСЫ ЕРМЕКА:\n- "открытые предоплаты" → кто не забрал\n- "закрытые предоплаты" → кому выдали\n\nВАЖНО: При расхождении > 5000 тенге уточни причину. Фраза "Смена сохранена" обязательна в конце закрытия.';

async function sendTelegramMessage(chatId, text) {
  const url = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
  });
  return res.json();
}

async function askTomi(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: 'user', content: userMessage });
  if (conversations[chatId].length > 30) conversations[chatId] = conversations[chatId].slice(-30);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, system: TOMI_SYSTEM, messages: conversations[chatId] })
  });
  const data = await res.json();
  if (!data.content || !data.content[0]) throw new Error('Empty response');
  const reply = data.content[0].text;
  conversations[chatId].push({ role: 'assistant', content: reply });
  return reply;
}

async function processUpdate(update) {
  try {
    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = message.text || '';

    if (!text) return;

    console.log('От ' + chatId + ': ' + text);

    const textLower = text.toLowerCase();

    const isJustPrepay = (textLower === 'предоплаты' || textLower === 'предоплата') &&
      !textLower.includes('открыт') && !textLower.includes('закрыт') && !textLower.includes('prep-');

    if (isJustPrepay) {
      await sendTelegramMessage(chatId, 'Какие предоплаты показать?\n\n📦 *Открытые* — кто не забрал товар\n✅ *Закрытые* — кому уже выдали\n\nНапиши: «открытые» или «закрытые»');
      return;
    }

    const needsPrepays = textLower.includes('предоплат') || textLower.includes('открытые') ||
      textLower.includes('закрытые') || textLower.includes('кто не забрал') ||
      textLower.includes('кому выдали') || textLower.includes('prep-');

    let contextMessage = text;

    if (needsPrepays) {
      const [openP, closedP] = await Promise.all([getOpenPrepays(), getClosedPrepays()]);
      const openList = openP.length > 0 ? openP.map(function(p) {
        return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone||'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|долг:' + p.balance + 'тг|' + p.channel + '|' + (p.notes||'-');
      }).join('\n') : 'нет';
      const closedList = closedP.length > 0 ? closedP.map(function(p) {
        return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone||'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|' + p.channel + '|выдано:' + (p.closeDate||'-') + '|' + (p.notes||'-');
      }).join('\n') : 'нет';
      contextMessage = text + '\n\n[ДАННЫЕ СИСТЕМЫ:\nОТКРЫТЫЕ (' + openP.length + ' шт): ' + openList + '\nЗАКРЫТЫЕ (' + closedP.length + ' шт): ' + closedList + ']';
    }

    const reply = await askTomi(chatId, contextMessage);
    await sendTelegramMessage(chatId, reply);

    const replyLower = reply.toLowerCase();
    if (replyLower.includes('смена сохранена')) {
      extractAndSaveShift(chatId, conversations).catch(function(e) { console.error('Save shift error:', e); });
    }

    if (OWNER_CHAT_ID && String(chatId) !== String(OWNER_CHAT_ID)) {
      if (replyLower.includes('смена сохранена')) {
        await sendTelegramMessage(OWNER_CHAT_ID, '📋 NANE PARIS · Закрытие\nОт: ' + (message.from.first_name || chatId) + '\n\n' + reply.substring(0, 600));
      } else if (replyLower.includes('смена открыта')) {
        await sendTelegramMessage(OWNER_CHAT_ID, '🌅 NANE PARIS · Открытие\nОт: ' + (message.from.first_name || chatId) + '\n\n' + reply.substring(0, 300));
      } else if (replyLower.includes('опоздание')) {
        await sendTelegramMessage(OWNER_CHAT_ID, '🚨 NANE PARIS · Опоздание!\nОт: ' + (message.from.first_name || chatId));
      }
    }

  } catch (error) {
    console.error('processUpdate error:', error);
  }
}

const express = require('express');
const app = express();
app.use(express.json());

app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  await processUpdate(req.body);
});

app.get('/', function(req, res) {
  res.send('Томи Telegram Bot ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Томи Telegram запущен на порту ' + PORT);
});
