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

    let contextMessage = userText;
    const textLower = userText.toLowerCase();

    if (textLower.includes('открытые предоплат') || textLower.includes('кто не забрал') || textLower.includes('список клиент')) {
      const prepays = await getOpenPrepays();
      if (prepays.length > 0) {
        const list = prepays.map(p =>
          `ID: ${p.id} | Клиент: ${p.client} | Тел: ${p.phone || 'нет'} | Товар: ${p.item} | Дата: ${p.date} | Внесено: ${p.amount}тг | Остаток: ${p.balance}тг | Канал: ${p.channel} | Комментарий: ${p.notes || '-'}`
        ).join('\n');
        contextMessage = userText + `\n\n[СИСТЕМА: Открытые предоплаты — товар НЕ выдан (${prepays.length} шт):\n${list}\n\nФормат для каждого:\n📦 №X. ИМЯ\n🆔 ID: ...\n📞 Телефон: ...\n🛍 Товар: ...\n📅 Дата: ...\n💰 Внесено: ...тг\n💳 Канал: ...\n⚠️ Долг: ...тг (0 = "Оплачено, ждёт выдачи")\n💬 Комментарий: ...\n---\nПокажи ВСЕ записи.]`;
      } else {
        contextMessage = userText + '\n\n[СИСТЕМА: Открытых предоплат нет]';
      }
    } else if (textLower.includes('закрытые предоплат') || textLower.includes('кому выдали') || textLower.includes('выданные')) {
      const prepays = await getClosedPrepays();
      if (prepays.length > 0) {
        const list = prepays.map(p =>
          `ID: ${p.id} | Клиент: ${p.client} | Тел: ${p.phone || 'нет'} | Товар: ${p.item} | Дата покупки: ${p.date} | Внесено: ${p.amount}тг | Канал: ${p.channel} | Выдано: ${p.closeDate || '-'} | Комментарий: ${p.notes || '-'}`
        ).join('\n');
        contextMessage = userText + `\n\n[СИСТЕМА: Закрытые предоплаты — товар выдан (${prepays.length} шт):\n${list}\n\nФормат для каждого:\n✅ №X. ИМЯ\n🆔 ID: ...\n📞 Телефон: ...\n🛍 Товар: ...\n📅 Куплено: ...\n💰 Внесено: ...тг\n💳 Канал: ...\n📦 Выдано: ...\n💬 Комментарий: ...\n---\nПокажи ВСЕ записи.]`;
      } else {
        contextMessage = userText + '\n\n[СИСТЕМА: Закрытых предоплат нет]';
      }
    }

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
