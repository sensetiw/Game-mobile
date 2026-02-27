const { Markup } = require('telegraf');

function toss() {
  return Math.random() < 0.5 ? 'Орёл' : 'Решка';
}

function tossSeries(length) {
  return Array.from({ length }, () => toss());
}

function registerCoin(bot) {
  bot.hears('🪙 Монетка', async (ctx) => {
    await ctx.reply('Раздел «Монетка».', Markup.inlineKeyboard([
      [Markup.button.callback('🪙 Кинуть монетку', 'coin:toss')],
      [Markup.button.callback('🎲 Серия из 3', 'coin:series:3'), Markup.button.callback('🎲 Серия из 5', 'coin:series:5')],
    ]));
  });

  bot.action('coin:toss', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`Результат: ${toss()}`);
  });

  bot.action(/^coin:series:(3|5)$/, async (ctx) => {
    const size = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    await ctx.reply(`Серия (${size}): ${tossSeries(size).join(' • ')}`);
  });
}

module.exports = { registerCoin };
