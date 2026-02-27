const crypto = require('crypto');
const { Markup } = require('telegraf');
const { db, now, setState, clearState, getActiveLinkForUser } = require('../db');
const { INVITE_TTL_MS } = require('../config');

function genCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function pairPartner(link, userId) {
  return link.user1_id === userId ? link.user2_id : link.user1_id;
}

function registerConnections(bot) {
  bot.hears('👥 Связи', async (ctx) => {
    await ctx.reply('Раздел «Связи». Выберите действие:', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Создать инвайт', 'link:create')],
      [Markup.button.callback('🔑 Ввести код', 'link:enter')],
      [Markup.button.callback('📌 Моя связь', 'link:status')],
    ]));
  });

  bot.action('link:create', async (ctx) => {
    const userId = ctx.from.id;
    const active = getActiveLinkForUser(userId);
    if (active) {
      await ctx.answerCbQuery();
      return ctx.reply('У вас уже есть активная связь. Сначала разорвите её в ⚙️ Настройки.');
    }

    db.prepare("UPDATE invites SET status='expired' WHERE creator_id=? AND status='open' AND expires_at < ?").run(userId, now());

    const code = genCode();
    const expiresAt = now() + INVITE_TTL_MS;
    db.prepare('INSERT INTO invites (creator_id, code, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, code, 'open', expiresAt, now());

    console.log(`[connections] invite created by ${userId}, code=${code}`);

    let deepLinkText = '';
    if (ctx.botInfo?.username) {
      deepLinkText = `\nСсылка: https://t.me/${ctx.botInfo.username}?start=invite_${code}`;
    }

    await ctx.answerCbQuery('Инвайт создан');
    await ctx.reply(`Ваш код: ${code}\nДействует 10 минут.${deepLinkText}`);
  });

  bot.action('link:enter', async (ctx) => {
    setState(ctx.from.id, 'awaiting_invite_code');
    await ctx.answerCbQuery();
    await ctx.reply('Введите инвайт-код (например: A1B2C3).');
  });

  bot.action('link:status', async (ctx) => {
    const link = getActiveLinkForUser(ctx.from.id);
    await ctx.answerCbQuery();
    if (!link) return ctx.reply('Активной связи нет.');
    const partnerId = pairPartner(link, ctx.from.id);
    return ctx.reply(`Активная связь с пользователем ID: ${partnerId}`);
  });

  bot.command('unlink', async (ctx) => {
    const link = getActiveLinkForUser(ctx.from.id);
    if (!link) return ctx.reply('У вас нет активной связи.');
    db.prepare("UPDATE links SET status='ended', ended_at=? WHERE id=? AND status='active'").run(now(), link.id);
    console.log(`[connections] unlinked ${link.user1_id} and ${link.user2_id}`);
    await ctx.reply('Связь разорвана.');
  });

  bot.action(/^link:confirm:(\d+):(accept|reject)$/, async (ctx) => {
    const inviteId = Number(ctx.match[1]);
    const decision = ctx.match[2];
    const invite = db.prepare('SELECT * FROM invites WHERE id = ?').get(inviteId);

    if (!invite) {
      await ctx.answerCbQuery('Инвайт не найден');
      return;
    }

    if (ctx.from.id !== invite.creator_id) {
      await ctx.answerCbQuery('Это не ваш запрос');
      return;
    }

    if (invite.status !== 'awaiting_creator') {
      await ctx.answerCbQuery('Уже обработано');
      return;
    }

    const creatorBusy = getActiveLinkForUser(invite.creator_id);
    const inviteeBusy = getActiveLinkForUser(invite.used_by);
    if (creatorBusy || inviteeBusy) {
      db.prepare("UPDATE invites SET status='rejected', responded_at=? WHERE id=?").run(now(), invite.id);
      await ctx.answerCbQuery('Не удалось: у кого-то уже есть связь');
      return ctx.editMessageText('Запрос закрыт: у одного из пользователей уже есть активная связь.');
    }

    if (decision === 'reject') {
      db.prepare("UPDATE invites SET status='rejected', responded_at=? WHERE id=?").run(now(), invite.id);
      console.log(`[connections] invite rejected by ${invite.creator_id} from ${invite.used_by}`);
      await ctx.answerCbQuery('Отклонено');
      await ctx.editMessageText('Вы отклонили запрос на связь.');
      await ctx.telegram.sendMessage(invite.used_by, 'Ваш запрос на связь отклонён.');
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE invites SET status='accepted', responded_at=? WHERE id=?").run(now(), invite.id);
      db.prepare('INSERT INTO links (user1_id, user2_id, status, created_at) VALUES (?, ?, ?, ?)')
        .run(invite.creator_id, invite.used_by, 'active', now());
    })();

    console.log(`[connections] link active ${invite.creator_id}<->${invite.used_by}`);

    await ctx.answerCbQuery('Принято');
    await ctx.editMessageText('Связь подтверждена ✅');
    await ctx.telegram.sendMessage(invite.used_by, 'Ваша связь активирована ✅');
  });

  bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    if (!payload?.startsWith('invite_')) return;
    const code = payload.replace('invite_', '').toUpperCase();
    setState(ctx.from.id, 'awaiting_invite_code', { codePrefill: code });
    await ctx.reply(`Получен инвайт-код ${code}. Отправьте любой текст, чтобы подтвердить ввод кода.`);
  });

  bot.on('text', async (ctx, next) => {
    const stateRow = db.prepare('SELECT * FROM user_states WHERE user_id=?').get(ctx.from.id);
    if (!stateRow || stateRow.state !== 'awaiting_invite_code') return next();

    const code = (stateRow.payload ? JSON.parse(stateRow.payload).codePrefill : null) || ctx.message.text.trim().toUpperCase();
    clearState(ctx.from.id);

    const active = getActiveLinkForUser(ctx.from.id);
    if (active) return ctx.reply('У вас уже есть активная связь. Сначала разорвите её.');

    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!invite) return ctx.reply('Код не найден. Проверьте и попробуйте снова.');
    if (invite.creator_id === ctx.from.id) return ctx.reply('Нельзя использовать свой же код.');
    if (invite.status !== 'open') return ctx.reply('Код уже использован или закрыт.');
    if (invite.expires_at < now()) {
      db.prepare("UPDATE invites SET status='expired' WHERE id=?").run(invite.id);
      return ctx.reply('Срок действия кода истёк.');
    }

    db.prepare("UPDATE invites SET status='awaiting_creator', used_by=? WHERE id=?").run(ctx.from.id, invite.id);
    console.log(`[connections] ${ctx.from.id} entered invite code ${code}`);

    await ctx.reply('Запрос отправлен. Ожидайте подтверждения.');
    await ctx.telegram.sendMessage(invite.creator_id,
      `Принять связь с пользователем ${ctx.from.first_name || ctx.from.id}?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Принять', `link:confirm:${invite.id}:accept`),
          Markup.button.callback('❌ Отклонить', `link:confirm:${invite.id}:reject`),
        ],
      ]),
    );
  });
}

module.exports = { registerConnections, pairPartner };
