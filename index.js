const { bot } = require('./src/bot');

bot.launch()
  .then(() => console.log('[core] Бот запущен'))
  .catch((err) => {
    console.error('[core] Ошибка запуска:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
