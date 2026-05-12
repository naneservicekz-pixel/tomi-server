const express = require('express');
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'Tomi2022';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1QUEXZbRT5TwfjwolwnIYoMQhA5naaQzzOzkxP3kxl0';

const conversations = {};

// ─── Google Sheets API через сервис-аккаунт ───────────────────────────────

function getServiceAccountKey() {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY не задан');
    return JSON.parse(raw);
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
  const data = await res.json();
  if (data.error) throw new Error('Sheets error: ' + JSON.stringify(data.error));
  return data;
}

async function sheetsRead(range) {
  const token = await getGoogleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID + '/values/' + encodeURIComponent(range);
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.json();
  if (data.error) throw new Error('Sheets read error: ' + JSON.stringify(data.error));
  return data.values || [];
}

async function sheetsUpdate(range, values) {
  const token = await getGoogleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED';
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] })
  });
  const data = await res.json();
  if (data.error) throw new Error('Sheets update error: ' + JSON.stringify(data.error));
  return data;
}

// ─── Работа с предоплатами ────────────────────────────────────────────────

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
      d.date || astana.toISOString().split('T')[0],
      d.seller || '',
      n(d.rKaspi), n(d.rOnline), n(d.rHalyk), n(d.rHalykOnline), n(d.rCash), n(d.rPersonal), n(d.rBonus),
      n(d.rRetKaspi), n(d.rRetHalyk), n(d.rRetCash),
      n(d.inkasso), n(d.cashPayouts), n(d.cashOpen), n(d.cashActual),
      n(d.tKaspi), n(d.tHalyk), n(d.tPersonal),
      rostaTotal, factTotal, diff,
      d.shiftStatus || '', d.notes || '',
      astana.toLocaleString('ru-RU')
    ];
    await sheetsAppend('Смены', row);
    console.log('Смена сохранена в Sheets:', d.date, d.seller);
    return true;
  } catch (e) {
    console.error('saveShift error:', e.message);
    return false;
  }
}

async function extractAndSaveShift(userPhone, convs) {
  try {
    const history = convs[userPhone] || [];
    const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 500,
        system: 'Извлеки данные закрытия смены из разговора. Верни ТОЛЬКО валидный JSON без комментариев и markdown.',
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

// ─── Системный промпт ─────────────────────────────────────────────────────

const TOMI_SYSTEM = 'Ты — Томи, ИИ-управляющий сети магазинов NANE PARIS.\n\nЛИЧНОСТЬ:\n- Строгий при ошибках, тёплый при успехе\n- Только русский язык\n- Короткие сообщения — продавец читает с телефона\n- Эмодзи умеренно: ✅ ⚠️ 🚨 💰 📋 📦\n\nМАГАЗИН:\n- Продавцы: Зарина, Айнур, Луиза, Асель\n- Руководитель: Ермек\n- Открытие: 11:00 (прийти в 10:45)\n- Лимит кассы: 100 000 тенге (выше — напомнить об инкассации)\n\nКАНАЛЫ ОПЛАТЫ:\n- Kaspi QR + Онлайн Kaspi = один терминал Kaspi\n- Halyk QR + Онлайн Halyk = один терминал Halyk\n- Наличные = касса\n- Личная карта = отдельный канал\n\nМОДУЛЬ 1: ОТКРЫТИЕ СМЕНЫ\nТриггер: "открытие", "открываю смену"\n1. Спроси имя и магазин\n2. Зафикси время (после 11:00 — предупреди об опоздании)\n3. Чек-лист: касса начало → терминалы → витрина\n4. Подтверди открытие\n\nМОДУЛЬ 2: ПРЕДОПЛАТА\nТриггер: "предоплата", "задаток"\nСпрашивай по одному:\n1. ФИО клиента\n2. Телефон\n3. Товар (название + размер)\n4. Канал оплаты\n5. Полная стоимость\n6. Сумма задатка\nРассчитай остаток. Подтверди сохранение.\n\nМОДУЛЬ 3: РАСХОД ИЗ КАССЫ\nТриггер: "расход", "трата"\nСпроси сумму и цель. Предупреди если касса превысит лимит.\n\nМОДУЛЬ 4: ИНКАССАЦИЯ\nТриггер: "инкассация"\nСпроси сумму и кто забрал. Зафикси.\n\nМОДУЛЬ 5: ЗАКРЫТИЕ СМЕНЫ\nТриггер: "закрытие", "закрываю смену"\n\nШАГ 1 — Физический чек-лист:\n- Витрина убрана?\n- Касса опечатана?\n- Терминалы выключены?\n- Сигнализация поставлена?\n\nШАГ 2 — Z-отчёт ROSTA (спрашивай по одному):\n- Kaspi QR\n- Онлайн Kaspi\n- Halyk QR\n- Онлайн Halyk\n- Наличные\n- Личная карта (если были)\n- Бонусы (если были)\n- Возврат Kaspi (если был)\n- Возврат Halyk (если был)\n- Возврат наличными (если был)\n\nШАГ 3 — Терминалы:\n- Итог терминала Kaspi\n- Итог терминала Halyk\n\nШАГ 4 — Касса:\n- Касса начало (утром)\n- Касса конец (сейчас)\n- Выплаты из кассы (если были)\n- Инкассация (если была)\n\nШАГ 5 — СВЕРКА (считай сам):\nROSTA итого = Kaspi QR + Онлайн Kaspi + Halyk QR + Онлайн Halyk + Наличные + Личная карта + Бонусы - Возврат Kaspi - Возврат Halyk - Возврат нал\nФакт Kaspi = Терминал Kaspi - Возврат Kaspi\nФакт Halyk = Терминал Halyk - Возврат Halyk\nФакт нал = Касса конец - Касса начало + Выплаты + Инкассация + Возврат нал\nФакт итого = Факт Kaspi + Факт Halyk + Факт нал + Личная карта + Бонусы\nРасхождение = Факт итого - ROSTA итого\n\nШАГ 6 — АНАЛИЗ:\n- Расхождение 0 → смена идеальная ✅\n- Терминал > ROSTA → вероятно предоплата или возврат не в тот день\n- ROSTA > терминал → ошибка канала или лишняя проводка\n- Бонусы → всегда расхождение, норма\n- Расхождение > 5000 тенге → обязательно уточни причину\n\nШАГ 7 — ИТОГ продавцу:\nПокажи таблицу по каналам с расхождениями. Дай статус: ✅/⚠️/🚨\n\nШАГ 8 — Скажи продавцу "Смена сохранена ✅". Пожелай хорошей ночи.\n\nМОДУЛЬ 6: ВЫДАЧА ТОВАРА\nТриггер: "выдала товар", "клиент забрал"\nСпроси ID (PREP-XXX) или имя. Закрой предоплату. Подтверди.\n\nМОДУЛЬ 7: ЗАПРОСЫ ЕРМЕКА:\n- "открытые предоплаты" → список кто не забрал\n- "закрытые предоплаты" → список выданных\n- "статус дня" → сводка\n\nВАЖНО:\n- Kaspi QR и Онлайн Kaspi уже в терминале — не суммируй дважды\n- При любом расхождении > 5000 тенге уточни причину\n- Фраза "Смена сохранена" — обязательно включай в конце закрытия';

// ─── WhatsApp ─────────────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, message) {
  const url = 'https://graph.facebook.com/v18.0/' + PHONE_NUMBER_ID + '/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } })
  });
  return res.json();
}

async function askTomi(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = [];
  conversations[userPhone].push({ role: 'user', content: userMessage });
  if (conversations[userPhone].length > 30) conversations[userPhone] = conversations[userPhone].slice(-30);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, system: TOMI_SYSTEM, messages: conversations[userPhone] })
  });
  const data = await res.json();
  if (!data.content || !data.content[0]) throw new Error('Empty response: ' + JSON.stringify(data));
  const reply = data.content[0].text;
  conversations[userPhone].push({ role: 'assistant', content: reply });
  return reply;
}

// ─── Webhook ──────────────────────────────────────────────────────────────

app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body.object || !body.entry) return;
    const message = body.entry[0] && body.entry[0].changes[0] && body.entry[0].changes[0].value && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0];
    if (!message) return;

    const from = message.from;
    let userText = '';
    if (message.type === 'text') {
      userText = message.text.body;
    } else if (message.type === 'image') {
      userText = '[Продавец отправил фото — попроси написать цифры вручную]';
    } else {
      return;
    }

    console.log('От ' + from + ': ' + userText);
    const textLower = userText.toLowerCase();

    // Меню предоплат
    const isJustPrepay = (textLower === 'предоплаты' || textLower === 'предоплата') &&
      !textLower.includes('открыт') && !textLower.includes('закрыт') && !textLower.includes('prep-');
    if (isJustPrepay) {
      await sendWhatsAppMessage(from, 'Какие предоплаты показать?\n\n📦 Открытые — кто не забрал товар\n✅ Закрытые — кому уже выдали\n\nНапиши: «открытые» или «закрытые»');
      return;
    }

    // Загрузка предоплат когда нужно
    const needsPrepays = textLower.includes('предоплат') || textLower.includes('открытые') ||
      textLower.includes('закрытые') || textLower.includes('кто не забрал') ||
      textLower.includes('кому выдали') || textLower.includes('prep-');

    let contextMessage = userText;
    if (needsPrepays) {
      const [openP, closedP] = await Promise.all([getOpenPrepays(), getClosedPrepays()]);
      const openList = openP.length > 0 ? openP.map(function(p) {
        return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone||'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|долг:' + p.balance + 'тг|' + p.channel + '|' + (p.notes||'-');
      }).join('\n') : 'нет';
      const closedList = closedP.length > 0 ? closedP.map(function(p) {
        return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone||'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|' + p.channel + '|выдано:' + (p.closeDate||'-') + '|' + (p.notes||'-');
      }).join('\n') : 'нет';
      contextMessage = userText + '\n\n[ДАННЫЕ СИСТЕМЫ:\nОТКРЫТЫЕ (' + openP.length + ' шт): ' + openList + '\nЗАКРЫТЫЕ (' + closedP.length + ' шт): ' + closedList + '\nФормат открытых: 📦 №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Дата / 💰 Внесено / ⚠️ Долг / 💳 Канал / 💬 Комментарий\nФормат закрытых: ✅ №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Куплено / 💰 Внесено / 💳 Канал / 📦 Выдано]';
    }

    const reply = await askTomi(from, contextMessage);
    await sendWhatsAppMessage(from, reply);

    // Автосохранение смены
    const replyLower = reply.toLowerCase();
    if (replyLower.includes('смена сохранена')) {
      extractAndSaveShift(from, conversations).catch(function(e) { console.error('Save shift error:', e); });
    }

    // Уведомления Ермеку
    if (OWNER_PHONE && from !== OWNER_PHONE) {
      if (replyLower.includes('смена сохранена') || replyLower.includes('итог смены')) {
        await sendWhatsAppMessage(OWNER_PHONE, '📋 NANE PARIS · Закрытие\nОт: +' + from + '\n\n' + reply.substring(0, 600));
      } else if (replyLower.includes('смена открыта') || replyLower.includes('открытие зафиксировано')) {
        await sendWhatsAppMessage(OWNER_PHONE, '🌅 NANE PARIS · Открытие\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      } else if (replyLower.includes('опоздание')) {
        await sendWhatsAppMessage(OWNER_PHONE, '🚨 NANE PARIS · Опоздание!\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      } else if (replyLower.includes('🚨')) {
        await sendWhatsAppMessage(OWNER_PHONE, '⚠️ NANE PARIS · Внимание!\nОт: +' + from + '\n\n' + reply.substring(0, 400));
      }
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

app.get('/', function(req, res) { res.send('ТОМИ — ИИ-управляющий NANE PARIS ✅'); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('ТОМИ запущен на порту ' + PORT); });
