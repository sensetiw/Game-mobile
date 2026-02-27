const { Telegraf, Markup } = require('telegraf');
const { BOT_TOKEN } = require('./config');
const { upsertUser, getActiveLinkForUser, db, now } = require('./db');
const { mainMenu } = require('./keyboards/reply');
const { registerConnections } = require('./modules/connections');
const { registerShopping } = require('./modules/shopping');
const { registerAlias } = require('./modules/games/alias');
const { registerTasks } = require('./modules/tasks');
const { registerCoin } = require('./modules/coin');

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from) upsertUser(ctx.from);
  return next();
});

bot.start(async (ctx) => {
  await ctx.reply('Привет! Это модульная платформа-бот: связи, покупки, задания, игры и утилиты.', mainMenu);
});

bot.hears('❓ Помощь', async (ctx) => {
  await ctx.reply([
    'Разделы:',
    '👥 Связи — привязка по одноразовому коду с подтверждением.',
    '🛒 Покупки — список от создателя к исполнителю.',
    '📋 Задания — задачи с дедлайнами и напоминаниями.',
    '🎮 Игры — Alias по уровням сложности.',
    '🪙 Монетка — Орёл/Решка и серии бросков.',
    '⚙️ Настройки — разорвать связь.',
  ].join('\n'), mainMenu);
});

bot.hears('⚙️ Настройки', async (ctx) => {
  const hasLink = getActiveLinkForUser(ctx.from.id);
  await ctx.reply('Настройки:', Markup.inlineKeyboard([
    [Markup.button.callback('💔 Разорвать связь', 'settings:unlink')],
    [Markup.button.callback('📌 Статус связи', 'settings:status')],
  ]));
  if (!hasLink) await ctx.reply('Сейчас активной связи нет.');
});

bot.action('settings:status', async (ctx) => {
  await ctx.answerCbQuery();
  const link = getActiveLinkForUser(ctx.from.id);
  if (!link) return ctx.reply('Связь отсутствует.');
  const partnerId = link.user1_id === ctx.from.id ? link.user2_id : link.user1_id;
  return ctx.reply(`Вы связаны с пользователем ID: ${partnerId}`);
});

bot.action('settings:unlink', async (ctx) => {
  const link = getActiveLinkForUser(ctx.from.id);
  await ctx.answerCbQuery();
  if (!link) return ctx.reply('Связь уже отсутствует.');
  db.prepare("UPDATE links SET status='ended', ended_at=? WHERE id=? AND status='active'").run(now(), link.id);
  console.log(`[settings] unlink ${link.user1_id}<->${link.user2_id}`);
  await ctx.reply('Связь разорвана.');
});

registerConnections(bot);
registerShopping(bot);
registerTasks(bot);
registerAlias(bot);
registerCoin(bot);

module.exports = { bot };
