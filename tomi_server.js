const express = require('express');
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'Tomi2022';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbyVAR8R8b-LOi7gFpa4bk8VXZFWfrbOv-TdIbZnNmrLSCzrl0HTH4X8LpJjU8sCYrVK/exec';

const conversations = {};

async function sheetsRequest(body) {
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error('Sheets error:', e);
    return { status: 'error', message: e.message };
  }
}

async function getOpenPrepays() {
  const data = await sheetsRequest({ action: 'getPrepays' });
  return data.prepays || [];
}

async function getClosedPrepays() {
  const data = await sheetsRequest({ action: 'getClosedPrepays' });
  return data.prepays || [];
}

async function saveShiftToSheets(shiftData) {
  return await sheetsRequest({ action: 'saveShift', ...shiftData });
}

async function extractAndSaveShift(userPhone, reply, convs) {
  try {
    const history = convs[userPhone] || [];
    const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 500,
        system: 'Ты извлекаешь данные из разговора о закрытии смены. Верни ТОЛЬКО валидный JSON без комментариев.',
        messages: [{
          role: 'user',
          content: 'Из этого разговора о закрытии смены извлеки данные и верни JSON:\n' +
            history.slice(-20).map(function(m) { return m.role + ': ' + m.content; }).join('\n') +
            '\n\nВерни JSON с полями (0 если не упоминалось):\n{"date":"YYYY-MM-DD","seller":"имя","rKaspi":0,"rOnline":0,"rHalyk":0,"rHalykOnline":0,"rCash":0,"rPersonal":0,"rBonus":0,"rRetKaspi":0,"rRetHalyk":0,"rRetCash":0,"tKaspi":0,"tHalyk":0,"tPersonal":0,"cashOpen":0,"cashActual":0,"cashPayouts":0,"inkasso":0,"shiftStatus":"ok","notes":""}'
        }]
      })
    });

    const extractData = await extractResponse.json();
    const jsonText = extractData.content[0].text.trim();
    const shiftData = JSON.parse(jsonText);

    if (!shiftData.date || shiftData.date === 'YYYY-MM-DD') {
      const now = new Date();
      const astana = new Date(now.getTime() + 5 * 60 * 60 * 1000);
      shiftData.date = astana.toISOString().split('T')[0];
    }

    const result = await saveShiftToSheets(shiftData);
    console.log('Смена сохранена:', result);
    return result;
  } catch (e) {
    console.error('Ошибка сохранения смены:', e);
    return { status: 'error' };
  }
}

const TOMI_SYSTEM = 'Ты — Томи, ИИ-управляющий сети магазинов NANE PARIS.\n\nЛИЧНОСТЬ:\n- Строгий при ошибках, тёплый при успехе\n- Только русский язык\n- Короткие сообщения — продавец читает с телефона\n- Эмодзи умеренно: ✅ ⚠️ 🚨 💰 📋 📦\n\nМАГАЗИН:\n- Продавцы: Зарина, Айнур, Луиза, Асель\n- Руководитель: Ермек\n- Открытие: 11:00 (прийти в 10:45)\n- Лимит кассы: 100 000 тенге (выше — напомнить об инкассации)\n\nКАНАЛЫ ОПЛАТЫ:\n- Kaspi QR + Онлайн Kaspi = один терминал Kaspi\n- Halyk QR + Онлайн Halyk = один терминал Halyk\n- Наличные = касса\n- Личная карта = отдельный канал\n\nМОДУЛЬ 1: ОТКРЫТИЕ СМЕНЫ\nТриггер: "открытие", "открываю смену"\n1. Спроси имя и магазин\n2. Зафикси время (после 11:00 — предупреди об опоздании)\n3. Чек-лист: касса начало → терминалы → витрина\n4. Подтверди открытие\n\nМОДУЛЬ 2: ПРЕДОПЛАТА\nТриггер: "предоплата", "задаток"\nСпрашивай по одному:\n1. ФИО клиента\n2. Телефон\n3. Товар (название + размер)\n4. Канал оплаты\n5. Полная стоимость\n6. Сумма задатка\nРассчитай остаток. Подтверди сохранение.\n\nМОДУЛЬ 3: РАСХОД ИЗ КАССЫ\nТриггер: "расход", "трата"\nСпроси сумму и цель. Предупреди если касса превысит лимит.\n\nМОДУЛЬ 4: ИНКАССАЦИЯ\nТриггер: "инкассация"\nСпроси сумму и кто забрал. Зафикси.\n\nМОДУЛЬ 5: ЗАКРЫТИЕ СМЕНЫ\nТриггер: "закрытие", "закрываю смену"\n\nШАГ 1 — Физический чек-лист:\n- Витрина убрана?\n- Касса опечатана?\n- Терминалы выключены?\n- Сигнализация поставлена?\n\nШАГ 2 — Z-отчёт ROSTA (спрашивай по одному):\n- Kaspi QR\n- Онлайн Kaspi\n- Halyk QR\n- Онлайн Halyk\n- Наличные\n- Личная карта (если были)\n- Бонусы (если были)\n- Возврат Kaspi (если был)\n- Возврат Halyk (если был)\n- Возврат наличными (если был)\n\nШАГ 3 — Терминалы:\n- Итог терминала Kaspi\n- Итог терминала Halyk\n\nШАГ 4 — Касса:\n- Касса начало (утром)\n- Касса конец (сейчас)\n- Выплаты из кассы (если были)\n- Инкассация (если была)\n\nШАГ 5 — СВЕРКА (считай сам):\nROSTA итого = Kaspi QR + Онлайн Kaspi + Halyk QR + Онлайн Halyk + Наличные + Личная карта + Бонусы - Возврат Kaspi - Возврат Halyk - Возврат нал\n\nФакт Kaspi = Терминал Kaspi - Возврат Kaspi\nФакт Halyk = Терминал Halyk - Возврат Halyk\nФакт нал = Касса конец - Касса начало + Выплаты + Инкассация + Возврат нал\nФакт итого = Факт Kaspi + Факт Halyk + Факт нал + Личная карта + Бонусы\n\nРасхождение = Факт итого - ROSTA итого\n\nШАГ 6 — АНАЛИЗ:\n- Расхождение 0 → смена идеальная ✅\n- Терминал > ROSTA → вероятно предоплата или возврат не в тот день\n- ROSTA > терминал → ошибка канала или лишняя проводка\n- Бонусы → всегда расхождение, норма\n- Расхождение > 5000 тенге → обязательно уточни причину\n\nШАГ 7 — ИТОГ продавцу:\nПокажи таблицу по каналам с расхождениями. Дай статус: ✅/⚠️/🚨\n\nШАГ 8 — Скажи продавцу что смена сохранена. Пожелай хорошей ночи.\n\nМОДУЛЬ 6: ВЫДАЧА ТОВАРА\nТриггер: "выдала товар", "клиент забрал"\nСпроси ID (PREP-XXX) или имя. Закрой предоплату. Подтверди.\n\nМОДУЛЬ 7: ЗАПРОСЫ ЕРМЕКА:\n- "открытые предоплаты" → список кто не забрал\n- "закрытые предоплаты" → список выданных\n- "статус дня" → сводка\n\nВАЖНО:\n- Kaspi QR и Онлайн Kaspi уже в терминале — не суммируй дважды\n- Возврат не в тот день — объясни в причине расхождения\n- При любом расхождении > 5000 тенге уточни причину\n- Когда пишешь "смена сохранена" — это сигнал для системы записать данные в таблицу';

async function sendWhatsAppMessage(to, message) {
  const url = 'https://graph.facebook.com/v18.0/' + PHONE_NUMBER_ID + '/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    })
  });
  return response.json();
}

async function askTomi(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = [];

  conversations[userPhone].push({ role: 'user', content: userMessage });

  if (conversations[userPhone].length > 30) {
    conversations[userPhone] = conversations[userPhone].slice(-30);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: TOMI_SYSTEM,
      messages: conversations[userPhone]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) {
    console.error('Anthropic error:', JSON.stringify(data));
    throw new Error('Empty response');
  }
  const reply = data.content[0].text;
  conversations[userPhone].push({ role: 'assistant', content: reply });
  return reply;
}

app.get('/webhook', function(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
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
    const msgType = message.type;

    let userText = '';
    if (msgType === 'text') {
      userText = message.text.body;
    } else if (msgType === 'image') {
      userText = '[Продавец отправил фото — попроси написать цифры вручную пока OCR не подключён]';
    } else {
      return;
    }

    console.log('От ' + from + ': ' + userText);

    const textLower = userText.toLowerCase();

    const isJustPrepay = (textLower === 'предоплаты' || textLower === 'предоплата') &&
      !textLower.includes('открыт') && !textLower.includes('закрыт') &&
      !textLower.includes('кто не') && !textLower.includes('кому') && !textLower.includes('prep-');

    if (isJustPrepay) {
      const clarifyMsg = 'Какие предоплаты показать?\n\n📦 Открытые — кто не забрал товар\n✅ Закрытые — кому уже выдали\n\nНапиши: «открытые» или «закрытые»';
      await sendWhatsAppMessage(from, clarifyMsg);
      return;
    }

    const needsPrepays = textLower.includes('предоплат') ||
      textLower.includes('открытые') || textLower.includes('закрытые') ||
      textLower.includes('кто не забрал') || textLower.includes('кому выдали') ||
      textLower.includes('prep-');

    let contextMessage = userText;

    if (needsPrepays) {
      const openPrepays = await getOpenPrepays();
      const closedPrepays = await getClosedPrepays();

      const openList = openPrepays.length > 0
        ? openPrepays.map(function(p) {
            return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone || 'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|долг:' + p.balance + 'тг|' + p.channel + '|' + (p.notes || '-');
          }).join('\n')
        : 'нет';

      const closedList = closedPrepays.length > 0
        ? closedPrepays.map(function(p) {
            return 'ID:' + p.id + '|' + p.client + '|тел:' + (p.phone || 'нет') + '|' + p.item + '|дата:' + p.date + '|внесено:' + p.amount + 'тг|' + p.channel + '|выдано:' + (p.closeDate || '-') + '|' + (p.notes || '-');
          }).join('\n')
        : 'нет';

      contextMessage = userText + '\n\n[ДАННЫЕ СИСТЕМЫ:\nОТКРЫТЫЕ ПРЕДОПЛАТЫ (не выдан, ' + openPrepays.length + ' шт): ' + openList + '\nЗАКРЫТЫЕ ПРЕДОПЛАТЫ (выдан, ' + closedPrepays.length + ' шт): ' + closedList + '\nФормат карточек открытых: 📦 №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Дата / 💰 Внесено / ⚠️ Долг / 💳 Канал / 💬 Комментарий / ---\nФормат карточек закрытых: ✅ №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Куплено / 💰 Внесено / 💳 Канал / 📦 Выдано / 💬 Комментарий / ---]';
    }

    const reply = await askTomi(from, contextMessage);
    await sendWhatsAppMessage(from, reply);

    const replyLower2 = reply.toLowerCase();
    if (replyLower2.includes('смена сохранена') || replyLower2.includes('смену сохранил')) {
      extractAndSaveShift(from, reply, conversations).catch(function(e) { console.error('Save shift error:', e); });
    }

    if (OWNER_PHONE && from !== OWNER_PHONE) {
      const replyLower = reply.toLowerCase();
      const isClosing = replyLower.includes('смена сохранена') || replyLower.includes('итог смены');
      const isOpening = replyLower.includes('смена открыта') || replyLower.includes('открытие зафиксировано');
      const isLate = replyLower.includes('опоздание');
      const isBigAlert = replyLower.includes('🚨');

      if (isClosing) {
        await sendWhatsAppMessage(OWNER_PHONE, '📋 NANE PARIS · Закрытие\nОт: +' + from + '\n\n' + reply.substring(0, 600));
      } else if (isOpening) {
        await sendWhatsAppMessage(OWNER_PHONE, '🌅 NANE PARIS · Открытие\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      } else if (isLate) {
        await sendWhatsAppMessage(OWNER_PHONE, '🚨 NANE PARIS · Опоздание!\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      } else if (isBigAlert) {
        await sendWhatsAppMessage(OWNER_PHONE, '⚠️ NANE PARIS · Внимание!\nОт: +' + from + '\n\n' + reply.substring(0, 400));
      }
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

app.get('/', function(req, res) {
  res.send('ТОМИ — ИИ-управляющий NANE PARIS ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('ТОМИ запущен на порту ' + PORT);
});
