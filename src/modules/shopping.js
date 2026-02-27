const { Markup } = require('telegraf');
const { db, now, setState, clearState, getState, getActiveLinkForUser } = require('../db');
const { pairPartner } = require('./connections');

function parseItems(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const m = line.match(/^(.*?)(\s+\d+[\w%]*)$/);
      if (m) return { item_order: idx + 1, text: m[1].trim(), qty: m[2].trim() };
      return { item_order: idx + 1, text: line, qty: '' };
    });
}

function buildChecklist(listId) {
  const items = db.prepare('SELECT * FROM shopping_items WHERE list_id=? ORDER BY item_order').all(listId);
  const lines = items.map((i) => `${i.status === 'done' ? '✅' : '⬜️'} ${i.text}${i.qty ? ` (${i.qty})` : ''}`);
  return lines.join('\n');
}

function registerShopping(bot) {
  bot.hears('🛒 Покупки', async (ctx) => {
    await ctx.reply('Раздел «Покупки».', Markup.inlineKeyboard([
      [Markup.button.callback('📝 Создать список', 'shop:create')],
      [Markup.button.callback('📋 Показать активный список', 'shop:show')],
    ]));
  });

  bot.action('shop:create', async (ctx) => {
    const link = getActiveLinkForUser(ctx.from.id);
    if (!link) {
      await ctx.answerCbQuery();
      return ctx.reply('Сначала создайте связь с исполнителем в разделе 👥 Связи.');
    }

    const existing = db.prepare(`SELECT * FROM shopping_lists WHERE creator_id=? AND status IN ('pending_accept','active','sent') ORDER BY id DESC LIMIT 1`).get(ctx.from.id);
    if (existing) {
      await ctx.answerCbQuery();
      return ctx.reply('У вас уже есть активный/отправленный список. Закройте его перед созданием нового.');
    }

    setState(ctx.from.id, 'awaiting_shopping_items');
    await ctx.answerCbQuery();
    await ctx.reply('Отправьте список покупок одним сообщением (каждый товар с новой строки).');
  });

  bot.action('shop:show', async (ctx) => {
    await ctx.answerCbQuery();
    const list = db.prepare(`SELECT * FROM shopping_lists WHERE (creator_id=? OR executor_id=?) AND status IN ('pending_accept','active') ORDER BY id DESC LIMIT 1`).get(ctx.from.id, ctx.from.id);
    if (!list) return ctx.reply('Активных списков нет.');
    const text = `Список #${list.id} (${list.status})\n${buildChecklist(list.id)}`;
    return ctx.reply(text);
  });

  bot.action(/^shop:draft:(\d+):(send|edit|cancel)$/, async (ctx) => {
    const listId = Number(ctx.match[1]);
    const action = ctx.match[2];
    const list = db.prepare('SELECT * FROM shopping_lists WHERE id=?').get(listId);
    if (!list || list.creator_id !== ctx.from.id || list.status !== 'draft') {
      await ctx.answerCbQuery('Черновик не найден');
      return;
    }

    if (action === 'cancel') {
      db.prepare("UPDATE shopping_lists SET status='canceled', updated_at=? WHERE id=?").run(now(), listId);
      await ctx.answerCbQuery('Отменено');
      await ctx.editMessageText('Создание списка отменено.');
      return;
    }

    if (action === 'edit') {
      setState(ctx.from.id, 'awaiting_shopping_items', { editListId: listId });
      await ctx.answerCbQuery();
      await ctx.reply('Отправьте обновлённый список новым сообщением.');
      return;
    }

    db.prepare("UPDATE shopping_lists SET status='pending_accept', updated_at=? WHERE id=?").run(now(), listId);
    console.log(`[shopping] list sent id=${listId} creator=${list.creator_id} executor=${list.executor_id}`);
    const checklist = buildChecklist(listId);
    const msg = await ctx.telegram.sendMessage(
      list.executor_id,
      `Новый список покупок от ${ctx.from.first_name || ctx.from.id}:\n${checklist}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Принять', `shop:accept:${listId}`),
          Markup.button.callback('❌ Отклонить', `shop:reject:${listId}`),
        ],
      ]),
    );
    db.prepare('UPDATE shopping_lists SET executor_chat_id=?, executor_message_id=?, updated_at=? WHERE id=?')
      .run(msg.chat.id, msg.message_id, now(), listId);

    await ctx.answerCbQuery('Отправлено');
    await ctx.editMessageText('Список отправлен исполнителю. Ожидаем ответ.');
  });

  bot.action(/^shop:(accept|reject):(\d+)$/, async (ctx) => {
    const decision = ctx.match[1];
    const listId = Number(ctx.match[2]);
    const list = db.prepare('SELECT * FROM shopping_lists WHERE id=?').get(listId);
    if (!list || list.executor_id !== ctx.from.id) {
      await ctx.answerCbQuery('Недоступно');
      return;
    }
    if (list.status !== 'pending_accept') {
      await ctx.answerCbQuery('Уже обработано');
      return;
    }

    if (decision === 'reject') {
      db.prepare("UPDATE shopping_lists SET status='canceled', updated_at=? WHERE id=?").run(now(), listId);
      await ctx.answerCbQuery('Отклонено');
      await ctx.editMessageText('Вы отклонили список.');
      await ctx.telegram.sendMessage(list.creator_id, `Ваш список #${listId} отклонён.`);
      return;
    }

    db.prepare("UPDATE shopping_lists SET status='active', updated_at=? WHERE id=?").run(now(), listId);
    console.log(`[shopping] list active id=${listId}`);
    await ctx.answerCbQuery('Принято');
    await ctx.editMessageText(`Список #${listId} активен. Отмечайте покупки кнопками ниже.`, Markup.inlineKeyboard(buildItemButtons(listId)));
    await ctx.telegram.sendMessage(list.creator_id, `Список #${listId} принят исполнителем ✅`);
  });

  bot.action(/^shop:item:(\d+):(\d+):(done|undo)$/, async (ctx) => {
    const listId = Number(ctx.match[1]);
    const itemId = Number(ctx.match[2]);
    const op = ctx.match[3];
    const list = db.prepare('SELECT * FROM shopping_lists WHERE id=?').get(listId);
    if (!list || list.executor_id !== ctx.from.id || list.status !== 'active') {
      await ctx.answerCbQuery('Список не активен');
      return;
    }

    const item = db.prepare('SELECT * FROM shopping_items WHERE id=? AND list_id=?').get(itemId, listId);
    if (!item) {
      await ctx.answerCbQuery('Товар не найден');
      return;
    }

    const nextStatus = op === 'done' ? 'done' : 'todo';
    if (item.status === nextStatus) {
      await ctx.answerCbQuery('Уже так отмечено');
      return;
    }

    db.prepare('UPDATE shopping_items SET status=? WHERE id=?').run(nextStatus, itemId);
    db.prepare('UPDATE shopping_lists SET updated_at=? WHERE id=?').run(now(), listId);
    console.log(`[shopping] item ${itemId} -> ${nextStatus} by ${ctx.from.id}`);
    await ctx.answerCbQuery('Обновлено');
    await ctx.telegram.sendMessage(list.creator_id, `Отмечено ${nextStatus === 'done' ? 'куплено' : 'возвращено'}: ${item.text}`);

    const allDone = db.prepare("SELECT COUNT(*) as c FROM shopping_items WHERE list_id=? AND status!='done'").get(listId).c === 0;
    if (allDone) {
      db.prepare("UPDATE shopping_lists SET status='completed', updated_at=? WHERE id=?").run(now(), listId);
      await ctx.editMessageText(`Список #${listId} выполнен ✅\n${buildChecklist(listId)}`);
      await ctx.telegram.sendMessage(list.creator_id, `Список #${listId} выполнен ✅`);
      return;
    }

    await ctx.editMessageText(`Список #${listId}:\n${buildChecklist(listId)}`, Markup.inlineKeyboard(buildItemButtons(listId)));
  });

  bot.on('text', async (ctx, next) => {
    const state = getState(ctx.from.id);
    if (!state || state.state !== 'awaiting_shopping_items') return next();

    const payload = state.payload ? JSON.parse(state.payload) : {};
    const items = parseItems(ctx.message.text);
    if (!items.length) return ctx.reply('Не удалось распознать список. Отправьте хотя бы один товар.');

    const link = getActiveLinkForUser(ctx.from.id);
    if (!link) {
      clearState(ctx.from.id);
      return ctx.reply('Связь не найдена, создание списка отменено.');
    }

    const executorId = pairPartner(link, ctx.from.id);
    let listId = payload.editListId;
    if (!listId) {
      const res = db.prepare('INSERT INTO shopping_lists (creator_id, executor_id, status, created_at, updated_at, creator_chat_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.from.id, executorId, 'draft', now(), now(), ctx.chat.id);
      listId = res.lastInsertRowid;
    } else {
      db.prepare('DELETE FROM shopping_items WHERE list_id=?').run(listId);
      db.prepare('UPDATE shopping_lists SET updated_at=? WHERE id=?').run(now(), listId);
    }

    const ins = db.prepare('INSERT INTO shopping_items (list_id, item_order, text, qty, status) VALUES (?, ?, ?, ?, ?)');
    for (const i of items) ins.run(listId, i.item_order, i.text, i.qty, 'todo');
    clearState(ctx.from.id);

    const preview = buildChecklist(listId);
    await ctx.reply(`Превью списка:\n${preview}\n\nОтправить исполнителю?`, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Отправить', `shop:draft:${listId}:send`)],
      [Markup.button.callback('✏️ Редактировать', `shop:draft:${listId}:edit`)],
      [Markup.button.callback('❌ Отмена', `shop:draft:${listId}:cancel`)],
    ]));
  });
}

function buildItemButtons(listId) {
  const items = db.prepare('SELECT * FROM shopping_items WHERE list_id=? ORDER BY item_order').all(listId);
  return items.map((item) => {
    if (item.status === 'done') {
      return [Markup.button.callback(`↩ ${item.text}`, `shop:item:${listId}:${item.id}:undo`)];
    }
    return [Markup.button.callback(`✅ ${item.text}`, `shop:item:${listId}:${item.id}:done`)];
  });
}

module.exports = { registerShopping };
