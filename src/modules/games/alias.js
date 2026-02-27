const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const { db, now } = require('../../db');

const dictionaries = {
  easy: JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/alias/easy.json'), 'utf-8')),
  medium: JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/alias/medium.json'), 'utf-8')),
  hard: JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/alias/hard.json'), 'utf-8')),
};

function nextWord(session) {
  const pool = dictionaries[session.difficulty] || [];
  let used = [];
  try {
    used = JSON.parse(session.used_words || '[]');
  } catch (_) {}

  let candidates = pool.filter((w) => w !== session.last_word && !used.includes(w));
  if (!candidates.length) {
    used = [];
    candidates = pool.filter((w) => w !== session.last_word);
  }
  const word = candidates[Math.floor(Math.random() * candidates.length)];
  used.push(word);

  db.prepare('UPDATE alias_sessions SET current_word=?, last_word=?, used_words=?, updated_at=? WHERE user_id=?')
    .run(word, word, JSON.stringify(used), now(), session.user_id);
  return word;
}

async function showRound(ctx, userId) {
  const session = db.prepare("SELECT * FROM alias_sessions WHERE user_id=? AND status='active'").get(userId);
  if (!session) return;
  const word = nextWord(session);
  await ctx.reply(`Слово: ${word}`, Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Угадали', 'alias:guess'),
      Markup.button.callback('⏭ Пропустить', 'alias:skip'),
    ],
    [Markup.button.callback('🛑 Стоп', 'alias:stop')],
  ]));
}

function registerAlias(bot) {
  bot.hears('🎮 Игры', async (ctx) => {
    await ctx.reply('Игры:', Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Alias', 'alias:menu')],
    ]));
  });

  bot.action('alias:menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Выберите сложность Alias:', Markup.inlineKeyboard([
      [
        Markup.button.callback('Лёгкий', 'alias:start:easy'),
        Markup.button.callback('Средний', 'alias:start:medium'),
        Markup.button.callback('Сложный', 'alias:start:hard'),
      ],
    ]));
  });

  bot.action(/^alias:start:(easy|medium|hard)$/, async (ctx) => {
    const difficulty = ctx.match[1];
    db.prepare(`
      INSERT INTO alias_sessions (user_id, difficulty, score, status, current_word, last_word, used_words, updated_at, created_at)
      VALUES (?, ?, 0, 'active', NULL, NULL, '[]', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        difficulty=excluded.difficulty,
        score=0,
        status='active',
        current_word=NULL,
        last_word=NULL,
        used_words='[]',
        updated_at=excluded.updated_at
    `).run(ctx.from.id, difficulty, now(), now());

    console.log(`[alias] start user=${ctx.from.id} difficulty=${difficulty}`);
    await ctx.answerCbQuery('Игра началась');
    await ctx.reply('Правила: за каждое угаданное слово +1 очко, пропуск не штрафуется.');
    await showRound(ctx, ctx.from.id);
  });

  bot.action(/^alias:(guess|skip|stop)$/, async (ctx) => {
    const op = ctx.match[1];
    const session = db.prepare("SELECT * FROM alias_sessions WHERE user_id=? AND status='active'").get(ctx.from.id);
    if (!session) {
      await ctx.answerCbQuery('Сессия не активна');
      return;
    }

    if (op === 'stop') {
      db.prepare("UPDATE alias_sessions SET status='stopped', updated_at=? WHERE user_id=?").run(now(), ctx.from.id);
      console.log(`[alias] stop user=${ctx.from.id} score=${session.score}`);
      await ctx.answerCbQuery('Игра остановлена');
      await ctx.reply(`Итог: ${session.score} очков. Сыграть снова?`, Markup.inlineKeyboard([
        [Markup.button.callback('🔁 Играть снова', `alias:start:${session.difficulty}`)],
      ]));
      return;
    }

    if (op === 'guess') {
      db.prepare('UPDATE alias_sessions SET score=score+1, updated_at=? WHERE user_id=?').run(now(), ctx.from.id);
    }
    await ctx.answerCbQuery(op === 'guess' ? '+1' : 'Пропуск');
    await showRound(ctx, ctx.from.id);
  });
}

module.exports = { registerAlias };
