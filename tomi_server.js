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

const TOMI_SYSTEM = `Ты — Томи, ИИ-управляющий сети магазинов NANE PARIS.

ЛИЧНОСТЬ:
- Строгий при ошибках, тёплый при успехе
- Только русский язык
- Короткие сообщения — продавец читает с телефона
- Эмодзи умеренно: ✅ ⚠️ 🚨 💰 📋 📦

МАГАЗИН:
- Продавцы: Зарина, Айнур, Луиза, Асель
- Руководитель: Ермек
- Открытие: 11:00 (прийти в 10:45)
- Лимит кассы: 100 000 тенге (выше — напомнить об инкассации)

КАНАЛЫ ОПЛАТЫ:
- Kaspi QR + Онлайн Kaspi = один терминал Kaspi
- Halyk QR + Онлайн Halyk = один терминал Halyk
- Наличные = касса
- Личная карта = отдельный канал

МОДУЛЬ 1: ОТКРЫТИЕ СМЕНЫ
Триггер: "открытие", "открываю смену"
1. Спроси имя и магазин
2. Зафикси время (после 11:00 — предупреди об опоздании)
3. Чек-лист: касса начало → терминалы → витрина
4. Подтверди открытие

МОДУЛЬ 2: ПРЕДОПЛАТА
Триггер: "предоплата", "задаток"
Спрашивай по одному:
1. ФИО клиента
2. Телефон
3. Товар (название + размер)
4. Канал оплаты
5. Полная стоимость
6. Сумма задатка
Рассчитай остаток. Подтверди сохранение.

МОДУЛЬ 3: РАСХОД ИЗ КАССЫ
Триггер: "расход", "трата"
Спроси сумму и цель. Предупреди если касса превысит лимит.

МОДУЛЬ 4: ИНКАССАЦИЯ
Триггер: "инкассация"
Спроси сумму и кто забрал. Зафикси.

МОДУЛЬ 5: ЗАКРЫТИЕ СМЕНЫ
Триггер: "закрытие", "закрываю смену"

ШАГ 1 — Физический чек-лист:
- Витрина убрана?
- Касса опечатана?
- Терминалы выключены?
- Сигнализация поставлена?

ШАГ 2 — Z-отчёт ROSTA (спрашивай по одному):
- Kaspi QR
- Онлайн Kaspi
- Halyk QR
- Онлайн Halyk
- Наличные
- Личная карта (если были)
- Бонусы (если были)
- Возврат Kaspi (если был)
- Возврат Halyk (если был)
- Возврат наличными (если был)

ШАГ 3 — Терминалы:
- Итог терминала Kaspi
- Итог терминала Halyk

ШАГ 4 — Касса:
- Касса начало (утром)
- Касса конец (сейчас)
- Выплаты из кассы (если были)
- Инкассация (если была)

ШАГ 5 — СВЕРКА (считай сам):
ROSTA итого = Kaspi QR + Онлайн Kaspi + Halyk QR + Онлайн Halyk + Наличные + Личная карта + Бонусы - Возврат Kaspi - Возврат Halyk - Возврат нал

Факт Kaspi = Терминал Kaspi - Возврат Kaspi
Факт Halyk = Терминал Halyk - Возврат Halyk
Факт нал = Касса конец - Касса начало + Выплаты + Инкассация + Возврат нал
Факт итого = Факт Kaspi + Факт Halyk + Факт нал + Личная карта + Бонусы

Расхождение = Факт итого - ROSTA итого

ШАГ 6 — АНАЛИЗ:
- Расхождение 0 → смена идеальная ✅
- Терминал > ROSTA → вероятно предоплата или возврат не в тот день
- ROSTA > терминал → ошибка канала или лишняя проводка
- Бонусы → всегда расхождение, норма
- Расхождение > 5000 тенге → обязательно уточни причину

ШАГ 7 — ИТОГ продавцу:
Покажи таблицу по каналам с расхождениями. Дай статус: ✅/⚠️/🚨

ШАГ 8 — Скажи продавцу что смена сохранена. Пожелай хорошей ночи.

МОДУЛЬ 6: ВЫДАЧА ТОВАРА
Триггер: "выдала товар", "клиент забрал"
Спроси ID (PREP-XXX) или имя. Закрой предоплату. Подтверди.

МОДУЛЬ 7: ЗАПРОСЫ ЕРМЕКА:
- "открытые предоплаты" → список кто не забрал
- "закрытые предоплаты" → список выданных
- "статус дня" → сводка

ВАЖНО:
- Kaspi QR и Онлайн Kaspi уже в терминале — не суммируй дважды
- Возврат не в тот день — объясни в причине расхождения
- При любом расхождении > 5000 тенге уточни причину
- Когда пишешь "смена сохранена" — это сигнал для системы записать данные в таблицу`;

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
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

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || !body.entry) return;

    const message = body.entry[0]?.changes[0]?.value?.messages?.[0];
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

    console.log(`От ${from}: ${userText}`);

    // Загружаем предоплаты параллельно — Томи сам решит что показать
    const [openPrepays, closedPrepays] = await Promise.all([
      getOpenPrepays(),
      getClosedPrepays()
    ]);

    const openList = openPrepays.length > 0
      ? openPrepays.map(p =>
          `ID:${p.id}|${p.client}|тел:${p.phone||'нет'}|${p.item}|дата:${p.date}|внесено:${p.amount}тг|долг:${p.balance}тг|${p.channel}|${p.notes||'-'}`
        ).join('\n')
      : 'нет';

    const closedList = closedPrepays.length > 0
      ? closedPrepays.map(p =>
          `ID:${p.id}|${p.client}|тел:${p.phone||'нет'}|${p.item}|дата:${p.date}|внесено:${p.amount}тг|${p.channel}|выдано:${p.closeDate||'-'}|${p.notes||'-'}`
        ).join('\n')
      : 'нет';

    const contextMessage = userText + `

[ДАННЫЕ СИСТЕМЫ — используй если нужно для ответа:
ОТКРЫТЫЕ ПРЕДОПЛАТЫ (товар не выдан, ${openPrepays.length} шт):
${openList}

ЗАКРЫТЫЕ ПРЕДОПЛАТЫ (товар выдан, ${closedPrepays.length} шт):
${closedList}

При показе предоплат используй формат карточек:
Открытые: 📦 №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Дата / 💰 Внесено / ⚠️ Долг (0=ждёт выдачи) / 💳 Канал / 💬 Комментарий / ---
Закрытые: ✅ №X. ИМЯ / 🆔 ID / 📞 Тел / 🛍 Товар / 📅 Куплено / 💰 Внесено / 💳 Канал / 📦 Выдано / 💬 Комментарий / ---]`;

    const reply = await askTomi(from, contextMessage);
    await sendWhatsAppMessage(from, reply);

    // Уведомления Ермеку
    if (OWNER_PHONE && from !== OWNER_PHONE) {
      const replyLower = reply.toLowerCase();
      const isClosing = replyLower.includes('смена сохранена') || replyLower.includes('итог смены');
      const isOpening = replyLower.includes('смена открыта') || replyLower.includes('открытие зафиксировано');
      const isLate = replyLower.includes('опоздание');
      const isBigAlert = replyLower.includes('🚨');

      if (isClosing) {
        await sendWhatsAppMessage(OWNER_PHONE, `📋 NANE PARIS · Закрытие\nОт: +${from}\n\n${reply.substring(0, 600)}`);
      } else if (isOpening) {
        await sendWhatsAppMessage(OWNER_PHONE, `🌅 NANE PARIS · Открытие\nОт: +${from}\n\n${reply.substring(0, 300)}`);
      } else if (isLate) {
        await sendWhatsAppMessage(OWNER_PHONE, `🚨 NANE PARIS · Опоздание!\nОт: +${from}\n\n${reply.substring(0, 300)}`);
      } else if (isBigAlert) {
        await sendWhatsAppMessage(OWNER_PHONE, `⚠️ NANE PARIS · Внимание!\nОт: +${from}\n\n${reply.substring(0, 400)}`);
      }
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

app.get('/', (req, res) => {
  res.send('ТОМИ — ИИ-управляющий NANE PARIS ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ТОМИ запущен на порту ${PORT}`);
});
