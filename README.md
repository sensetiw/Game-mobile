# Простой тестовый Telegram-бот (Node.js + Telegraf)

Минимальный бот для запуска на Render.com как **Web Service** в режиме **long polling** (без webhook).

## Функционал

- `/start` → `Привет! Я тестовый бот`
- `ping` → `pong`
- любое другое сообщение → `Напиши: ping`

## 1) Как создать бота и получить `BOT_TOKEN`

1. Откройте Telegram и найдите **@BotFather**.
2. Отправьте команду `/newbot`.
3. Укажите имя бота (display name).
4. Укажите уникальный username бота, который заканчивается на `bot` (например, `my_test_render_bot`).
5. BotFather пришлёт токен вида:
   `123456789:AA...`

Сохраните этот токен — это значение переменной окружения `BOT_TOKEN`.

## 2) Локальный запуск

### Требования

- Node.js 18+ (рекомендуется)
- npm

### Шаги

```bash
npm install
BOT_TOKEN=ваш_токен npm start
```

Если переменная `BOT_TOKEN` не задана, приложение завершится с понятной ошибкой.

## 3) Деплой на Render (Web Service)

1. Загрузите проект в GitHub/GitLab.
2. В Render нажмите **New +** → **Web Service**.
3. Подключите репозиторий и выберите ветку.
4. Укажите параметры сервиса:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Добавьте переменную окружения:
   - ключ: `BOT_TOKEN`
   - значение: токен от BotFather
6. Нажмите **Create Web Service**.

После деплоя Render запустит процесс `npm start`, и бот начнёт работать в long polling режиме.

## Структура

- `index.js`
- `package.json`
- `README.md`
