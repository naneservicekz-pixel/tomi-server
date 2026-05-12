const express = require('express');
const app = express();
app.use(express.json());

// Все ключи берутся из переменных окружения Railway - НЕ хранить в коде!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'Tomi2022';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OWNER_PHONE = process.env.OWNER_PHONE; // номер Ермека без +

const conversations = {};

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

    const reply = await askTomi(from, userText);
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
