const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Ошибка запуска: переменная окружения BOT_TOKEN не задана. Укажите токен, например: export BOT_TOKEN=123:ABC');
  process.exit(1);
}

module.exports = {
  BOT_TOKEN,
  DB_PATH: process.env.DB_PATH || path.join(process.cwd(), 'data', 'bot.db'),
  INVITE_TTL_MS: 10 * 60 * 1000,
};
