# Wallet Explorer — план разработки (3 дня)

## Идея проекта

Веб-приложение для визуализации движения криптовалютных средств. Пользователь
вводит адрес кошелька Ethereum → видит граф транзакций (откуда пришли деньги,
куда ушли) → может кликать по узлам и раскрывать граф дальше → простая
эвристика подсвечивает подозрительные паттерны (дробление средств между
множеством адресов за короткий срок).

## Стек

- **Frontend:** React 19, Vite, TailwindCSS, React Flow (граф), Zustand
- **Backend:** Node.js, Express, Sequelize, PostgreSQL
- **Внешний API:** Etherscan API (обычные транзакции + токен-переводы)
- **Сеть:** Ethereum mainnet (только одна сеть для MVP, без BSC/Polygon)

---

## Подготовка (сделать до старта в Claude Code)

1. Зарегистрироваться на https://etherscan.io/apis, получить бесплатный API-ключ
2. Вручную проверить пару запросов в браузере/Postman, чтобы увидеть реальный
   формат ответа:
   - `https://api.etherscan.io/api?module=account&action=txlist&address=0xADDRESS&sort=desc&apikey=YOUR_KEY`
   - `https://api.etherscan.io/api?module=account&action=tokentx&address=0xADDRESS&sort=desc&apikey=YOUR_KEY`
3. Взять любой адрес крупной биржи с etherscan.io для тестирования (у него
   гарантированно много транзакций)

---

## День 1 — Backend + база данных

### Структура проекта

```
wallet-explorer/
├── server/
│   ├── src/
│   │   ├── config/
│   │   │   └── database.js       # подключение Sequelize к PostgreSQL
│   │   ├── models/
│   │   │   ├── Address.js
│   │   │   ├── Transaction.js
│   │   │   └── index.js
│   │   ├── services/
│   │   │   ├── etherscan.js      # обёртка над Etherscan API
│   │   │   └── graphBuilder.js   # превращение списка tx в граф-структуру
│   │   ├── controllers/
│   │   │   └── walletController.js
│   │   ├── routes/
│   │   │   └── wallet.js
│   │   └── app.js
│   ├── .env.example
│   └── package.json
└── client/                       # React (день 2)
```

### Схема БД (Sequelize models)

**Address**
```js
{
  address: { type: DataTypes.STRING, primaryKey: true }, // хранить в lowercase!
  label: { type: DataTypes.STRING, allowNull: true },     // "Binance Hot Wallet" и т.п.
  lastFetchedAt: { type: DataTypes.DATE, allowNull: true },
  isSuspicious: { type: DataTypes.BOOLEAN, defaultValue: false } // эвристика, день 3
}
```

**Transaction**
```js
{
  hash: { type: DataTypes.STRING, primaryKey: true },
  fromAddress: { type: DataTypes.STRING, allowNull: false },
  toAddress: { type: DataTypes.STRING, allowNull: true }, // null если контракт-деплой
  value: { type: DataTypes.DECIMAL(38, 18), allowNull: false }, // wei нужен точный тип!
  tokenSymbol: { type: DataTypes.STRING, allowNull: true }, // null = нативный ETH
  tokenContractAddress: { type: DataTypes.STRING, allowNull: true },
  blockNumber: { type: DataTypes.BIGINT, allowNull: false },
  timestamp: { type: DataTypes.DATE, allowNull: false }
}
// Индексы: fromAddress, toAddress, blockNumber — обязательно, иначе граф будет
// строиться медленно при росте таблицы
```

### Задачи по порядку

1. **Инициализация проекта:** `npm init`, установить express, sequelize, pg,
   axios (или fetch), dotenv, cors
2. **Настроить Sequelize + PostgreSQL** (Docker Compose как в Telinko — этот
   паттерн уже знаком)
3. **Сервис `etherscan.js`** — функции:
   - `getNormalTransactions(address)` → вызов `action=txlist`
   - `getTokenTransfers(address)` → вызов `action=tokentx`
   - Обязательно: обработка rate limit (free tier Etherscan — 5 запросов/сек),
     обработка ошибок API (поле `status` в ответе может быть `"0"` с
     сообщением об ошибке даже при HTTP 200 — это частая ловушка)
4. **Эндпоинт `GET /api/wallet/:address`:**
   - Валидация формата адреса (regex `^0x[a-fA-F0-9]{40}$`)
   - Проверить в БД: если адрес уже запрашивался недавно (например, < 1 часа
     назад) — отдать закэшированные транзакции из БД, не дёргать Etherscan
     повторно
   - Если нет в кэше — запросить Etherscan, сохранить транзакции в БД
     (upsert по hash, чтобы не дублировать), обновить `lastFetchedAt`
   - Вернуть JSON: список транзакций + базовую агрегацию (сколько всего
     входящих/исходящих, суммарный объём)
5. **Тест через curl/Postman**, что эндпоинт реально отдаёт данные с реального
   адреса

### Критерий готовности дня 1
`curl http://localhost:4000/api/wallet/0xADDRESS` возвращает JSON со списком
реальных транзакций, повторный запрос идёт из кэша БД (проверить по логам —
не должно быть повторного похода в Etherscan).

---

## День 2 — Frontend и граф

### Структура

```
client/
├── src/
│   ├── api/
│   │   └── wallet.js           # axios-запросы к backend
│   ├── components/
│   │   ├── AddressInput.jsx
│   │   ├── TransactionGraph.jsx  # обёртка над React Flow
│   │   ├── AddressNode.jsx       # кастомный узел графа
│   │   └── TransactionDetails.jsx # панель при клике на ребро
│   ├── store/
│   │   └── graphStore.js       # Zustand: текущие узлы, рёбра, раскрытые адреса
│   └── App.jsx
```

### Задачи по порядку

1. **Установить react-flow:** `npm install reactflow`
2. **Компонент `AddressInput`** — форма с валидацией адреса, при сабмите
   вызывает backend и инициализирует граф с центральным узлом
3. **Преобразование данных в формат react-flow:**
   ```js
   // Транзакции → узлы (уникальные адреса) + рёбра (переводы)
   function buildGraphData(transactions, centerAddress) {
     const nodes = new Map();
     const edges = [];
     nodes.set(centerAddress, { id: centerAddress, data: { label: shorten(centerAddress) }, type: 'address' });
     transactions.forEach(tx => {
       if (!nodes.has(tx.fromAddress)) nodes.set(tx.fromAddress, {...});
       if (!nodes.has(tx.toAddress)) nodes.set(tx.toAddress, {...});
       edges.push({
         id: tx.hash,
         source: tx.fromAddress,
         target: tx.toAddress,
         label: `${tx.value} ${tx.tokenSymbol || 'ETH'}`,
       });
     });
     return { nodes: [...nodes.values()], edges };
   }
   ```
4. **Layout графа** — react-flow сам не расставляет узлы красиво, понадобится
   простой layout-алгоритм. Для MVP достаточно `dagre` (npm-библиотека для
   авто-раскладки графов слоями) — не изобретайте свой алгоритм расстановки
5. **Клик по узлу → expand:**
   - При клике на адрес-узел вызвать `/api/wallet/:address` для этого адреса
   - Добавить новые узлы/рёбра к существующему графу (не перезатирать)
   - Визуально пометить уже "раскрытые" узлы (например, другой цвет), чтобы
     не было путаницы, что уже смотрели
6. **Панель деталей** — клик по ребру (транзакции) показывает: хэш, дату,
   сумму, ссылку на etherscan.io/tx/{hash}

### Критерий готовности дня 2
Ввели адрес → увидели граф с несколькими узлами → кликнули по любому узлу →
граф достроился новыми транзакциями этого адреса, не потеряв старые.

---

## День 3 — Эвристика, полировка, деплой

### Эвристика дробления средств

Простое пороговое правило (не ML, честно и достаточно для MVP):

```js
// В graphBuilder.js или отдельном сервисе detectStructuring.js
function detectStructuring(transactions, address) {
  const outgoing = transactions.filter(tx => tx.fromAddress === address);

  // Группируем исходящие транзакции по окнам в 1 час
  const windows = groupByTimeWindow(outgoing, 60 * 60 * 1000);

  for (const window of windows) {
    if (window.length >= 3) {
      const amounts = window.map(tx => tx.value);
      const avg = average(amounts);
      // Если суммы примерно равны (разброс < 15%) — подозрительно
      const isUniform = amounts.every(a => Math.abs(a - avg) / avg < 0.15);
      if (isUniform) {
        return { suspicious: true, reason: 'Дробление на равные части', window };
      }
    }
  }
  return { suspicious: false };
}
```

Подсветить такие узлы на графе другим цветом (например, красная обводка) +
tooltip с объяснением, почему помечено.

### Полировка

- Loading-состояния при запросах (граф может строиться пару секунд)
- Обработка ошибок: невалидный адрес, адрес без транзакций, Etherscan
  недоступен — везде понятные сообщения, не белый экран
- Ограничение на количество узлов при expand (например, топ-20 последних
  транзакций адреса, а не все 10000, если это адрес биржи) — иначе граф
  превратится в нечитаемую кашу

### Деплой

Повторить паттерн из Telinko: Docker Compose для PostgreSQL локально, на
проде — нативная установка (если ресурсы сервера ограничены так же, как
в прошлый раз) + nginx как reverse proxy.

**Не забыть:** Etherscan API-ключ — в `.env`, никогда не коммитить в git.

### Критерий готовности дня 3
Проект задеплоен, доступен по ссылке, граф работает на реальных адресах,
хотя бы один явно подозрительный паттерн (можно сконструировать вручную,
отправив тестовые транзакции в testnet) корректно подсвечивается.

---

## Важно держать в голове при работе с Claude Code

1. **Просите объяснять, а не только генерировать.** После каждого крупного
   куска кода — попросите Claude Code кратко объяснить логику своими
   словами, и проверьте, что можете пересказать её сами, без подсказки.
2. **Не гонитесь за всеми тремя сетями сразу** — Ethereum mainnet, доведённый
   до рабочего состояния, лучше, чем три сети "на скорую руку".
3. **Если день 1 съедает больше времени, чем планировалось** (Etherscan API
   не такой уж простой в реальности, особенно rate limits) — лучше сдвинуть
   день 3 (эвристику) вправо, а не резать день 1.
4. **Резервный вариант, если не укладываетесь в 3 дня:** отдать MVP без
   эвристики дробления — сам факт работающего графа реальных ончейн-данных
   уже достаточно сильный кейс для резюме, эвристику можно добавить позже.
