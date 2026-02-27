const { Telegraf } = require('telegraf');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('Ошибка: переменная окружения BOT_TOKEN не задана. Добавьте токен бота в BOT_TOKEN.');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start((ctx) => ctx.reply('Привет! Я тестовый бот'));

bot.on('text', (ctx) => {
  const message = ctx.message.text.trim().toLowerCase();

  if (message === 'ping') {
    return ctx.reply('pong');
  }

  return ctx.reply('Напиши: ping');
});

bot.launch()
  .then(() => {
    console.log('Бот запущен (long polling)...');
  })
  .catch((error) => {
    console.error('Ошибка запуска бота:', error.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
