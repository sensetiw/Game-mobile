const cron = require('node-cron');
const { Markup } = require('telegraf');
const { db, now, setState, clearState, getState, getActiveLinkForUser } = require('../db');
const { pairPartner } = require('./connections');

function parseHHMM(value) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function startOfDay(date, dayOffset = 0) {
  const d = new Date(date);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildDueAt(dayType, hhmm) {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;

  const base = dayType === 'tomorrow' ? startOfDay(new Date(), 1) : startOfDay(new Date(), 0);
  base.setHours(parsed.h, parsed.m, 0, 0);
  return base.getTime();
}

function calculateNextReminder(dueAt, stage) {
  if (!dueAt && dueAt !== 0) return null;
  if (stage === 0) return dueAt - 60 * 60 * 1000;
  if (stage === 1) return dueAt;
  if (stage >= 2 && stage <= 4) return dueAt + (stage - 1) * 6 * 60 * 60 * 1000;
  return null;
}

function resetReminderFields(taskId, dueAt) {
  if (!dueAt) {
    db.prepare('UPDATE tasks SET remind_stage=0, reminders_sent_count=0, next_remind_at=NULL, updated_at=? WHERE id=?').run(now(), taskId);
    return;
  }

  let stage = 0;
  let nextRemindAt = calculateNextReminder(dueAt, stage);
  while (nextRemindAt !== null && nextRemindAt <= now() && stage < 4) {
    stage += 1;
    nextRemindAt = calculateNextReminder(dueAt, stage);
  }

  db.prepare('UPDATE tasks SET remind_stage=?, reminders_sent_count=0, next_remind_at=?, updated_at=? WHERE id=?')
    .run(stage, nextRemindAt, now(), taskId);
}

function formatTask(task) {
  const dueText = task.due_at ? new Date(task.due_at).toLocaleString('ru-RU') : 'без дедлайна';
  return `#${task.id} • ${task.text}\nСтатус: ${task.status}\nДедлайн: ${dueText}`;
}

function taskManageKeyboard(taskId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Выполнено', `task:done:${taskId}`)],
    [Markup.button.callback('⏰ Перенести', `task:reschedule:${taskId}`)],
    [Markup.button.callback('❌ Отказаться', `task:cancel:${taskId}`)],
  ]);
}

function registerTaskScheduler(bot) {
  cron.schedule('* * * * *', async () => {
    const dueTasks = db.prepare(`
      SELECT * FROM tasks
      WHERE status='active'
        AND due_at IS NOT NULL
        AND next_remind_at IS NOT NULL
        AND next_remind_at <= ?
        AND remind_stage <= 4
    `).all(now());

    for (const task of dueTasks) {
      try {
        let text;
        if (task.remind_stage === 0) {
          text = `⏰ Напоминание: до дедлайна задачи #${task.id} остался 1 час.\n${task.text}`;
        } else if (task.remind_stage === 1) {
          text = `🚨 Дедлайн наступил по задаче #${task.id}.\n${task.text}`;
        } else {
          text = `🔁 Просроченная задача #${task.id} всё ещё не выполнена (напоминание ${task.remind_stage - 1}/3).\n${task.text}`;
        }

        await bot.telegram.sendMessage(task.executor_id, text, taskManageKeyboard(task.id));
        await bot.telegram.sendMessage(task.creator_id, `📋 Обновление по задаче #${task.id}: отправлено напоминание исполнителю.`);

        const nextStage = task.remind_stage + 1;
        const nextRemindAt = nextStage <= 4 ? calculateNextReminder(task.due_at, nextStage) : null;
        db.prepare(`
          UPDATE tasks
          SET remind_stage=?, reminders_sent_count=reminders_sent_count+1, next_remind_at=?, updated_at=?
          WHERE id=?
        `).run(nextStage, nextRemindAt, now(), task.id);
      } catch (err) {
        console.error('[tasks] reminder error:', err.message);
      }
    }
  });
}

function registerTasks(bot) {
  registerTaskScheduler(bot);

  bot.hears('📋 Задания', async (ctx) => {
    await ctx.reply('Раздел «Задания».', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Создать', 'task:create')],
      [Markup.button.callback('📌 Активные', 'task:list:active')],
      [Markup.button.callback('🕘 История', 'task:list:history')],
    ]));
  });

  bot.action('task:create', async (ctx) => {
    const link = getActiveLinkForUser(ctx.from.id);
    await ctx.answerCbQuery();
    if (!link) return ctx.reply('Сначала создайте связь в разделе 👥 Связи, чтобы назначать задания.');

    setState(ctx.from.id, 'awaiting_task_text');
    await ctx.reply('Введите текст задания одним сообщением.');
  });

  bot.action(/^task:list:(active|history)$/, async (ctx) => {
    const mode = ctx.match[1];
    await ctx.answerCbQuery();

    const rows = mode === 'active'
      ? db.prepare("SELECT * FROM tasks WHERE creator_id=? AND status IN ('pending_accept','active') ORDER BY updated_at DESC LIMIT 10").all(ctx.from.id)
      : db.prepare("SELECT * FROM tasks WHERE creator_id=? AND status IN ('completed','rejected','canceled') ORDER BY updated_at DESC LIMIT 10").all(ctx.from.id);

    if (!rows.length) return ctx.reply(mode === 'active' ? 'Активных задач пока нет.' : 'История задач пуста.');
    return ctx.reply(rows.map(formatTask).join('\n\n'));
  });

  bot.action(/^task:deadline:(today|tomorrow|none)$/, async (ctx) => {
    const choice = ctx.match[1];
    const state = getState(ctx.from.id);
    await ctx.answerCbQuery();

    if (!state || state.state !== 'awaiting_task_deadline') return;
    const payload = state.payload ? JSON.parse(state.payload) : {};

    if (choice === 'none') {
      clearState(ctx.from.id);
      return createTaskRequest(ctx, payload.text, null);
    }

    setState(ctx.from.id, 'awaiting_task_time', { text: payload.text, dayType: choice });
    await ctx.reply('Укажите время в формате HH:MM.');
  });

  bot.action(/^task:(accept|reject):(\d+)$/, async (ctx) => {
    const decision = ctx.match[1];
    const taskId = Number(ctx.match[2]);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task || task.executor_id !== ctx.from.id) {
      await ctx.answerCbQuery('Недоступно');
      return;
    }

    if (task.status !== 'pending_accept') {
      await ctx.answerCbQuery('Уже обработано');
      return;
    }

    if (decision === 'reject') {
      db.prepare("UPDATE tasks SET status='rejected', updated_at=? WHERE id=?").run(now(), taskId);
      await ctx.answerCbQuery('Отклонено');
      await ctx.editMessageText(`Вы отклонили задачу #${taskId}.`);
      await ctx.telegram.sendMessage(task.creator_id, `❌ Ваша задача #${taskId} была отклонена.`);
      return;
    }

    db.prepare("UPDATE tasks SET status='active', updated_at=? WHERE id=?").run(now(), taskId);
    resetReminderFields(taskId, task.due_at);
    await ctx.answerCbQuery('Принято');
    await ctx.editMessageText(`Задача #${taskId} принята.`, taskManageKeyboard(taskId));
    await ctx.telegram.sendMessage(task.creator_id, `✅ Задача #${taskId} принята исполнителем.`);
  });

  bot.action(/^task:done:(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task || task.executor_id !== ctx.from.id) {
      await ctx.answerCbQuery('Недоступно');
      return;
    }
    if (task.status !== 'active') {
      await ctx.answerCbQuery('Задача не активна');
      return;
    }

    db.prepare("UPDATE tasks SET status='completed', next_remind_at=NULL, updated_at=? WHERE id=?").run(now(), taskId);
    await ctx.answerCbQuery('Отлично');
    await ctx.editMessageText(`✅ Задача #${taskId} отмечена как выполненная.`);
    await ctx.telegram.sendMessage(task.creator_id, `✅ Задача #${taskId} выполнена.`);
  });

  bot.action(/^task:cancel:(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task || task.executor_id !== ctx.from.id) {
      await ctx.answerCbQuery('Недоступно');
      return;
    }
    if (task.status !== 'active') {
      await ctx.answerCbQuery('Задача не активна');
      return;
    }

    db.prepare("UPDATE tasks SET status='canceled', next_remind_at=NULL, updated_at=? WHERE id=?").run(now(), taskId);
    await ctx.answerCbQuery('Отказ отправлен');
    await ctx.editMessageText(`❌ Вы отказались от задачи #${taskId}.`);
    await ctx.telegram.sendMessage(task.creator_id, `❌ Исполнитель отказался от задачи #${taskId}.`);
  });

  bot.action(/^task:reschedule:(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task || task.executor_id !== ctx.from.id || task.status !== 'active') {
      await ctx.answerCbQuery('Недоступно');
      return;
    }

    await ctx.answerCbQuery();
    await ctx.reply('Выберите новый дедлайн:', Markup.inlineKeyboard([
      [Markup.button.callback('+1ч', `task:resopt:${taskId}:plus1`), Markup.button.callback('+3ч', `task:resopt:${taskId}:plus3`)],
      [Markup.button.callback('Завтра 10:00', `task:resopt:${taskId}:tomorrow10`)],
      [Markup.button.callback('Ввести вручную HH:MM', `task:resopt:${taskId}:manual`)],
    ]));
  });

  bot.action(/^task:resopt:(\d+):(plus1|plus3|tomorrow10|manual)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const option = ctx.match[2];
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task || task.executor_id !== ctx.from.id || task.status !== 'active') {
      await ctx.answerCbQuery('Недоступно');
      return;
    }

    if (option === 'manual') {
      setState(ctx.from.id, 'awaiting_task_reschedule_time', { taskId });
      await ctx.answerCbQuery();
      await ctx.reply('Введите новое время в формате HH:MM (сегодня).');
      return;
    }

    let dueAt;
    const base = task.due_at && task.due_at > now() ? task.due_at : now();
    if (option === 'plus1') dueAt = base + 60 * 60 * 1000;
    if (option === 'plus3') dueAt = base + 3 * 60 * 60 * 1000;
    if (option === 'tomorrow10') {
      const d = startOfDay(new Date(), 1);
      d.setHours(10, 0, 0, 0);
      dueAt = d.getTime();
    }

    db.prepare('UPDATE tasks SET due_at=?, updated_at=? WHERE id=?').run(dueAt, now(), taskId);
    resetReminderFields(taskId, dueAt);
    await ctx.answerCbQuery('Перенесено');
    await ctx.reply(`⏰ Дедлайн задачи #${taskId} перенесён на ${new Date(dueAt).toLocaleString('ru-RU')}.`);
    await ctx.telegram.sendMessage(task.creator_id, `⏰ Исполнитель перенёс дедлайн задачи #${taskId} на ${new Date(dueAt).toLocaleString('ru-RU')}.`);
  });

  bot.on('text', async (ctx, next) => {
    const state = getState(ctx.from.id);
    if (!state) return next();

    if (state.state === 'awaiting_task_text') {
      const text = ctx.message.text.trim();
      if (!text) return ctx.reply('Текст задания не может быть пустым.');

      setState(ctx.from.id, 'awaiting_task_deadline', { text });
      await ctx.reply('Выберите дедлайн:', Markup.inlineKeyboard([
        [Markup.button.callback('Сегодня', 'task:deadline:today'), Markup.button.callback('Завтра', 'task:deadline:tomorrow')],
        [Markup.button.callback('Без дедлайна', 'task:deadline:none')],
      ]));
      return;
    }

    if (state.state === 'awaiting_task_time') {
      const payload = state.payload ? JSON.parse(state.payload) : {};
      const dueAt = buildDueAt(payload.dayType, ctx.message.text);
      if (!dueAt) return ctx.reply('Неверный формат. Используйте HH:MM, например 19:30.');
      if (dueAt <= now()) return ctx.reply('Это время уже прошло. Укажите время в будущем.');

      clearState(ctx.from.id);
      await createTaskRequest(ctx, payload.text, dueAt);
      return;
    }

    if (state.state === 'awaiting_task_reschedule_time') {
      const payload = state.payload ? JSON.parse(state.payload) : {};
      const parsed = parseHHMM(ctx.message.text);
      if (!parsed) return ctx.reply('Неверный формат. Используйте HH:MM.');

      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(payload.taskId);
      if (!task || task.executor_id !== ctx.from.id || task.status !== 'active') {
        clearState(ctx.from.id);
        return ctx.reply('Задача недоступна для переноса.');
      }

      const d = new Date();
      d.setHours(parsed.h, parsed.m, 0, 0);
      if (d.getTime() <= now()) d.setDate(d.getDate() + 1);
      const dueAt = d.getTime();

      db.prepare('UPDATE tasks SET due_at=?, updated_at=? WHERE id=?').run(dueAt, now(), task.id);
      resetReminderFields(task.id, dueAt);
      clearState(ctx.from.id);

      await ctx.reply(`⏰ Дедлайн задачи #${task.id} перенесён на ${new Date(dueAt).toLocaleString('ru-RU')}.`);
      await ctx.telegram.sendMessage(task.creator_id, `⏰ Исполнитель перенёс дедлайн задачи #${task.id} на ${new Date(dueAt).toLocaleString('ru-RU')}.`);
      return;
    }

    return next();
  });
}

async function createTaskRequest(ctx, text, dueAt) {
  const link = getActiveLinkForUser(ctx.from.id);
  if (!link) {
    clearState(ctx.from.id);
    await ctx.reply('Связь не найдена. Создание задания отменено.');
    return;
  }

  const executorId = pairPartner(link, ctx.from.id);
  const createdAt = now();
  const nextRemindAt = dueAt ? calculateNextReminder(dueAt, 0) : null;

  const res = db.prepare(`
    INSERT INTO tasks (creator_id, executor_id, text, due_at, status, remind_stage, reminders_sent_count, next_remind_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending_accept', 0, 0, ?, ?, ?)
  `).run(ctx.from.id, executorId, text, dueAt, nextRemindAt, createdAt, createdAt);

  const taskId = Number(res.lastInsertRowid);
  const dueText = dueAt ? new Date(dueAt).toLocaleString('ru-RU') : 'без дедлайна';

  await ctx.reply(`Задача #${taskId} создана и отправлена на согласование.\nДедлайн: ${dueText}`);

  await ctx.telegram.sendMessage(executorId,
    `📋 Новое задание #${taskId}:\n${text}\nДедлайн: ${dueText}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Принять', `task:accept:${taskId}`),
        Markup.button.callback('❌ Отклонить', `task:reject:${taskId}`),
      ],
    ]));
}

module.exports = { registerTasks };
