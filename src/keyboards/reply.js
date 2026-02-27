const { Markup } = require('telegraf');

const mainMenu = Markup.keyboard([
  ['👥 Связи', '🛒 Покупки'],
  ['📋 Задания', '🎮 Игры'],
  ['🪙 Монетка', '⚙️ Настройки'],
  ['❓ Помощь'],
]).resize();

module.exports = { mainMenu };
