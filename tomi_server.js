const express = require('express');
const app = express();
app.use(express.json());

// Все ключи берутся из переменных окружения Railway - НЕ хранить в коде!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'Tomi2022';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE; // номер Ермека без +

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbyVAR8R8b-LOi7gFpa4bk8VXZFWfrbOv-TdIbZnNmrLSCzrl0HTH4X8LpJjU8sCYrVK/exec';

const conversations = {};

// Функции работы с Google Sheets через Apps Script
async function getOpenPrepays() {
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getPrepays' })
    });
    const data = await res.json();
    return data.prepays || [];
  } catch (e) {
    console.error('Ошибка загрузки предоплат:', e);
    return [];
  }
}

async function getClosedPrepays() {
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getClosedPrepays' })
    });
    const data = await res.json();
    return data.prepays || [];
  } catch (e) {
    console.error('Ошибка загрузки закрытых предоплат:', e);
    return [];
  }
}

async function savePrepayToSheets(prepayData) {
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'savePrepay', ...prepayData })
    });
    return await res.json();
  } catch (e) {
    console.error('Ошибка сохранения предоплаты:', e);
    return { status: 'error' };
  }
}

async function closePrepayInSheets(prepayId) {
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'closePrepay', prepayId })
    });
    return await res.json();
  } catch (e) {
    console.error('Ошибка закрытия предоплаты:', e);
    return { status: 'error' };
  }
}

const TOMI_SYSTEM = `Ты — Томи, ИИ-управляющий сети магазинов NANÉ PARIS.

ТВОЯ ЛИЧНОСТЬ:
- Имя: Томи
- Ты профессиональный финансовый контролёр и управляющий
- Строгий при ошибках, тёплый при успехе
- Общаешься только на русском языке
- Краткие чёткие сообщения, без лишних слов

МАГАЗИНЫ И ПРОДАВЦЫ:
- Продавцы: Зарина, Айнур, Луиза, Асель
- Руководитель: Ермек (получает все уведомления)
- Лимит наличных в кассе: 100 000 ₸ (выше — напоминать об инкассации)
- Открытие магазина: 11:00 (продавцы должны прийти в 10:45)

КАНАЛЫ ОПЛАТЫ:
- Kaspi QR и Онлайн Kaspi → один терминал Kaspi
- Halyk QR и Онлайн Halyk → один терминал Halyk
- Наличные → физическая касса
- Личная карта → ROSTA отдельно

МОДУЛИ РАБОТЫ:

1. ОТКРЫТИЕ СМЕНЫ (продавец пишет "открываю смену" или "открытие"):
- Приветствие с именем и датой
- Чек-лист: касса начало → терминалы → витрина
- Фиксация времени (если после 11:00 — предупреждение об опоздании)
- Уведомление Ермеку об открытии

2. ПРЕДОПЛАТА (продавец пишет "предоплата"):
- Запросить: ФИО клиента, телефон, товар, канал оплаты, полная сумма, задаток
- Подтвердить и сохранить
- Рассчитать остаток

3. РАСХОД ИЗ КАССЫ (продавец пишет "расход"):
- Запросить: сумму, цель расхода
- Зафиксировать и предупредить если касса превысит 100 000 ₸

4. ЗАКРЫТИЕ СМЕНЫ (продавец пишет "закрываю смену" или "закрытие"):
- Физический чек-лист: витрина убрана → касса опечатана → терминалы выключены → сигнализация
- Запросить фото Z-отчёта ROSTA, терминала Kaspi, терминала Halyk
- Запросить кассу конец
- Провести сверку и анализ расхождений
- Дать заключение с причинами расхождений
- Уведомить Ермека с итогом

ПРАВИЛА АНАЛИЗА РАСХОЖДЕНИЙ:
- Терминал больше ROSTA → скорее всего предоплата или возврат не в тот день
- ROSTA больше терминала → скорее всего ошибка канала или лишняя проводка
- Halyk больше/меньше → возможно перепутали канал Kaspi/Halyk
- Бонусы → всегда создают расхождение, норма
- Задавай точечные вопросы для выяснения причин

СТИЛЬ ОБЩЕНИЯ:
- При ошибках: чётко, строго, с объяснением как правильно
- При успехе: тепло, с похвалой
- Эмодзи умеренно: ✅ ⚠️ 🚨 💰 📋
- Сообщения короткие — продавец читает с телефона`;

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
  if (!conversations[userPhone]) {
    conversations[userPhone] = [];
  }
  
  conversations[userPhone].push({
    role: 'user',
    content: userMessage
  });

  // Ограничиваем историю последними 20 сообщениями
  if (conversations[userPhone].length > 20) {
    conversations[userPhone] = conversations[userPhone].slice(-20);
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
      max_tokens: 1000,
      system: TOMI_SYSTEM,
      messages: conversations[userPhone]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) {
    console.error('Ошибка Anthropic API:', JSON.stringify(data));
    throw new Error('Пустой ответ от Anthropic');
  }
  const reply = data.content[0].text;

  conversations[userPhone].push({
    role: 'assistant',
    content: reply
  });

  return reply;
}

// Webhook верификация
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Приём сообщений
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  
  try {
    const body = req.body;
    if (!body.object || !body.entry) return;

    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    if (!value.messages) return;

    const message = value.messages[0];
    const from = message.from;
    const msgType = message.type;

    let userText = '';
    if (msgType === 'text') {
      userText = message.text.body;
    } else if (msgType === 'image') {
      userText = '[Продавец отправил фото]';
    } else {
      return;
    }

    console.log(`От ${from}: ${userText}`);

    // Если запрос связан с предоплатами или закрытием смены — загружаем из таблицы
    let contextMessage = userText;
    const textLower = userText.toLowerCase();
    if (textLower.includes('предоплат') || textLower.includes('открытые')) {
      const prepays = await getOpenPrepays();
      if (prepays.length > 0) {
        const prepayList = prepays.map(p => 
          `- Клиент: ${p.client} | Товар: ${p.item} | Дата покупки: ${p.date} | Предоплата внесена: ${p.amount}₸ | Остаток долга: ${p.balance}₸ | Канал оплаты: ${p.channel}`
        ).join('\n');
        contextMessage = userText + `\n\n[СИСТЕМА: Открытые предоплаты — товар НЕ выдан (${prepays.length} шт):\n${prepayList}\n\nПокажи ПОЛНЫЙ список всех клиентов. Для каждого клиента используй такой формат:\n\n📦 №X. ИМЯ КЛИЕНТА\n🛍 Товар: ...\n📅 Дата: ...\n💰 Внесено: ...₸\n💳 Канал: ...\n⚠️ Долг: ...₸ (если 0 — напиши "Оплачено полностью, ждёт выдачи")\n---\n\nПокажи ВСЕ записи без исключения.]`;
      } else {
        contextMessage = userText + '\n\n[СИСТЕМА: Открытых предоплат нет]';
      }
    } else if (textLower.includes('закрытые предоплат') || textLower.includes('закрытых предоплат') || textLower.includes('кому выдали') || textLower.includes('выданные')) {
      const prepays = await getClosedPrepays();
      if (prepays.length > 0) {
        const prepayList = prepays.map(p => 
          `- Клиент: ${p.client} | Товар: ${p.item} | Дата покупки: ${p.date} | Предоплата: ${p.amount}₸ | Остаток: ${p.balance}₸ | Канал: ${p.channel} | Дата выдачи: ${p.closeDate || '-'}`
        ).join('\n');
        contextMessage = userText + `\n\n[СИСТЕМА: Закрытые предоплаты — товар выдан (${prepays.length} шт):\n${prepayList}\n\nПокажи ПОЛНЫЙ список. Для каждого клиента используй формат:\n\n✅ №X. ИМЯ КЛИЕНТА\n🛍 Товар: ...\n📅 Куплено: ...\n💰 Внесено: ...₸\n💳 Канал: ...\n📦 Выдано: ...\n---\n\nПокажи ВСЕ записи.]`;
      } else {
        contextMessage = userText + '\n\n[СИСТЕМА: Закрытых предоплат нет]';
      }
    }

    const reply = await askTomi(from, contextMessage);
    await sendWhatsAppMessage(from, reply);

    // Уведомление Ермеку
    if (OWNER_PHONE && from !== OWNER_PHONE) {
      const replyLower = reply.toLowerCase();
      const isClosing = replyLower.includes('смена закрыта') || replyLower.includes('итог смены') || replyLower.includes('сверка сошл');
      const isOpening = replyLower.includes('смена открыта') || replyLower.includes('открытие зафиксировано');
      const isAlert = replyLower.includes('опоздание') || replyLower.includes('расхождение');
      
      if (isClosing) {
        await sendWhatsAppMessage(OWNER_PHONE, '📋 NANÉ PARIS · Закрытие\nОт: +' + from + '\n\n' + reply.substring(0, 500));
      } else if (isOpening) {
        await sendWhatsAppMessage(OWNER_PHONE, '🌅 NANÉ PARIS · Открытие\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      } else if (isAlert) {
        await sendWhatsAppMessage(OWNER_PHONE, '🚨 NANÉ PARIS · Внимание!\nОт: +' + from + '\n\n' + reply.substring(0, 300));
      }
    }

  } catch (error) {
    console.error('Ошибка:', error);
  }
});

app.get('/', (req, res) => {
  res.send('ТОМИ — ИИ-управляющий NANÉ PARIS работает ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ТОМИ запущен на порту ${PORT}`);
});
