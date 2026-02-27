const { Markup } = require('telegraf');

const mainMenu = Markup.keyboard([
  ['👥 Связи', '🛒 Покупки'],
  ['🎮 Игры', '⚙️ Настройки'],
  ['❓ Помощь'],
]).resize();

module.exports = { mainMenu };
