/**
 * Точка входа сервера.
 *
 * Порядок импортов имеет значение: config/env.js первым, потому что при
 * импорте он читает .env. Всё остальное рассчитывает на готовые переменные.
 */

import express from 'express';
import cors from 'cors';

import { config } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { assertDatabaseConnection, closeDatabaseConnection } from './config/database.js';
import { syncModels } from './models/index.js';
import { router } from './routes/wallet.js';
import { ApiError } from './controllers/walletController.js';

export const app = express();

/**
 * CORS.
 *
 * По умолчанию открыт всем — так удобно разрабатывать, когда фронт живёт
 * на другом порту. Но открытый API означает, что чужой сайт может дёргать
 * наши эндпоинты и жечь лимит TronGrid от нашего имени.
 *
 * Поэтому на проде список источников задаётся явно через CORS_ORIGINS
 * (через запятую). Пустое значение = разрешено всем.
 */
app.use(
  cors(
    config.server.corsOrigins.length > 0
      ? { origin: config.server.corsOrigins }
      : undefined,
  ),
);
app.use(express.json({ limit: '100kb' }));

/*
 * Доверие к заголовку X-Forwarded-For.
 *
 * За обратным прокси без этого все запросы выглядят пришедшими с одного
 * адреса, и лимит превращается в общий на всех пользователей сразу.
 * Без прокси доверять нельзя: заголовок подделывается тривиально.
 */
if (config.server.trustProxy) app.set('trust proxy', 1);

/**
 * Проверка живости — для мониторинга и для того, чтобы убедиться,
 * что сервер поднялся, не дёргая внешние API.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', network: config.app.defaultNetwork, uptime: process.uptime() });
});

// Ограничение частоты — до маршрутов, чтобы дорогие запросы не успели
// уйти во внешние API
app.use('/api', apiLimiter);
app.use('/api', router);

// Неизвестный путь — 404 с понятным телом, а не HTML-страница Express
app.use((req, res) => {
  res.status(404).json({ error: `Маршрут не найден: ${req.method} ${req.originalUrl}` });
});

/**
 * Обработчик ошибок.
 *
 * В Express 5 исключения из async-обработчиков долетают сюда сами — в
 * четвёртой версии их приходилось ловить обёрткой вокруг каждого маршрута.
 *
 * Четыре аргумента обязательны: по их количеству Express отличает
 * обработчик ошибок от обычного middleware. Отсюда и _next, который
 * не используется.
 */
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  // Неожиданная ошибка: в лог — целиком, наружу — без внутренностей.
  // Тексты наших исключений содержат пути к файлам и параметры запросов
  // к внешним API, показывать их пользователю незачем.
  console.error('[error]', error);

  return res.status(500).json({
    error: 'Внутренняя ошибка сервера',
    ...(config.server.isDev ? { detail: error.message } : {}),
  });
});

/**
 * Поднять сервер: сначала база, потом порт.
 *
 * Проверяем подключение к БД ДО начала приёма запросов — иначе первый же
 * пользователь получит 500 вместо внятной ошибки в консоли при старте.
 */
export async function start() {
  await assertDatabaseConnection();
  await syncModels();

  const server = app.listen(config.server.port, () => {
    console.log(`Wallet Explorer API: http://localhost:${config.server.port}`);
    console.log(`  сеть по умолчанию: ${config.app.defaultNetwork}`);
    console.log(`  база: ${config.db.host}:${config.db.port}/${config.db.name}`);
    console.log(`  проверка: http://localhost:${config.server.port}/health`);
  });

  // Корректное завершение: дать текущим запросам доиграть и закрыть пул
  // соединений, иначе процесс висит и docker/nodemon убивают его силой
  const shutdown = async (signal) => {
    console.log(`\n${signal}: останавливаюсь…`);

    // Страховка: если какое-то соединение зависло, server.close() не вызовет
    // колбэк никогда, и процесс останется висеть — docker и systemd убьют
    // его через SIGKILL, не дав закрыть пул соединений с базой
    const forceExit = setTimeout(() => {
      console.warn('Соединения не закрылись за 10 секунд, выходим принудительно');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      clearTimeout(forceExit);
      await closeDatabaseConnection();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Запускаемся только при прямом вызове файла: при импорте из тестов
// сервер подниматься не должен
if (process.argv[1] && process.argv[1].endsWith('app.js')) {
  start().catch((error) => {
    console.error('Не удалось запустить сервер:\n', error.message);
    process.exit(1);
  });
}
