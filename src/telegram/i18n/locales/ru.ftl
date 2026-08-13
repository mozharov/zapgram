bot-name = ZapGram
bot-username = @zap_gram_bot

canceled = <b>❌ Действие отменено.</b>

conversation-state =
    .cancelled = <i>Действие отменено.</i>
    .inactive = <i>Этот шаг больше не активен.</i>
    .interrupted-fallback = ❌ Предыдущее действие отменено: {$action}.
    .inactive-fallback = ℹ️ Предыдущий шаг больше не активен: {$action}.
    .invoice-memo-inactive = <i>Добавление описания больше не активно.</i>
    .use-buttons = Используй кнопки в активном сообщении.

conversation-action =
    .enter-sats = ввод суммы
    .enter-invoice = ввод Lightning-счёта
    .connect-nwc = подключение NWC-кошелька
    .select-recipient = выбор получателя
    .edit-message-ru = редактирование сообщения на русском
    .edit-message-en = редактирование сообщения на английском
    .select-wallet = выбор кошелька
    .confirm-invoice-payment = подтверждение оплаты счёта
    .invoice-memo-options = добавление описания счёта
    .enter-invoice-memo = ввод описания счёта
    .enable-onchain = включение on-chain оплаты
    .donate-one-shot = ввод суммы поддержки
    .donation-percent = ввод процента авто-доната
    .donate-monthly = ввод суммы ежемесячной поддержки
    .feature-text = ввод предложения функции
    .feature-fund = выбор поддержки функции
    .broadcast-locale = выбор языка рассылки
    .broadcast-source = выбор сообщения рассылки
    .broadcast-confirm = подтверждение рассылки

button = 
    .back = ⬅️ Назад
    .help = ℹ️ Помощь
    .settings = ⚙️ Настройки
    .receive = 📩 Получить
    .send = ✉️ Отправить
    .subscriptions = 🔐 Мои подписки
    .chats = 👥 Чаты
    .feature-request = 💡 Предложить идею
    .open-wallet = 👛 Открыть кошелёк
    .how-it-works = ℹ️ Как это работает
    .enable-nwc-tips = ⚡️ Использовать NWC для отправки донатов в группах
    .disable-nwc-tips = 🤖 Использовать {bot-name} для отправки донатов в группах
    .disconnect-nwc = 🚫 Отсоединить NWC-кошелёк
    .connect-nwc = ⚡ Подключить кошелёк по NWC
    .groups = 👥 Групповые чаты и каналы
    .cancel = ❌ Отменить
    .add-to-group = 👥 Добавить в чат
    .add-chat = 👥 Добавить чат
    .paid-chats = 🔐 Платные чаты
    .add-invoice-memo = 🔡 Добавить описание
    .copy-invoice = 📋 Скопировать счёт
    .pay-invoice = ⚡️ Оплатить Lightning счёт
    .send-to-user = 👤 Отправить сатоши пользователю
    .nwc-wallet = ⚡️ NWC
    .internal-wallet = 🤖 {bot-name}
    .confirm-pay-invoice = 📤 Оплатить счёт
    .skip = ➡️ Пропустить
    .chat-settings = ⚙️ Настройки чата
    .prev = ⬅️
    .next = ➡
    .enable-monthly-payment = 🔄 Переключить на ежемесячную оплату
    .enable-one-time-payment = 🔄 Переключить на разовую оплату
    .change-price = Изменить цену
    .enable-paid-access = Включить платный доступ
    .disable-paid-access = 🚫 Отключить платный доступ
    .pay-subcription-with-wallet = 💰 С баланса {bot-name}
    .pay-subcription-with-nwc = 💰 Через NWC
    .enable-auto-renew = 🔄 Включить автопродление
    .disable-auto-renew = 🚫 Отключить автопродление
    .custom-message = 💬 Пользовательское сообщение
    .edit-custom-message = 💬 Изменить сообщение
    .remove-custom-message = ❌ Вернуть сообщение по умолчанию
    .edit-custom-message-locale = ✏️ Изменить {$locale}
    .preview-custom-message = 👁 Превью {$locale}
    .reset-custom-message = ♻️ Сбросить {$locale}
    .enable-onchain = ⛓ Включить on-chain оплату
    .disable-onchain = 🚫 Выключить on-chain оплату
    .pay-onchain = ⛓ Биткоин
    .pay-lightning = ⚡ Лайтнинг
    .donation-settings = ⚡️ Авто % с tips
    .donate = 💚 Поддержать проект
    .donate-amount = {$sats} сат
    .donate-custom = ✏️ Своя сумма…
    .donate-custom-short = ✏️
    .donate-monthly = 📅 Ежемесячно
    .donate-monthly-on = 📅 {$sats}/30д
    .donate-monthly-disable = 🚫 Выкл. ежемесячный
    .donation-auto-percent = ⚡️ Авто %
    .donation-percent = {$percent}%
    .donation-custom-percent = ✏️ Свой %…
    .donation-scope-tips = Только tips
    .donation-scope-all = Tips + счета
    .back-to-support = ⬅️ Поддержка
    .feature-fund-skip = Без сат

callback-answer = 
    .nwc-tip-enabled = ⚡️ Теперь донаты отправляются из NWC-кошелька
    .nwc-tip-disabled = 🤖 Теперь донаты отправляются из кошелька {bot-name}
    .unknown = ⚠️ Неизвестная кнопка

error = 
    .unknown = <b>⚠️ Произошла неизвестная ошибка.</b>
    .nwc-connection = <b>⚠️ Неудалось подключиться к кошельку по NWC.</b>
    .nwc-timeout = <b>⚠️ Время ожидания ответа от NWC истекло.</b>
        Статус операции неизвестен. Проверь подключение NWC-кошелька.
    .to-yourself = <b>⚠️ Нельзя отправлять сатоши самому себе.</b>
    .user-does-not-have-wallet = <b>⚠️ У этого пользователя нет кошелька {bot-name}.</b>
    .insufficient-funds = <b>⚠️ Недостаточно средств.</b>
    .invoice-parsing = <b>⚠️ Ошибка при обработке счёта Lightning. Проверь счёт на валидность.</b>
        ℹ️ {bot-name} пока не поддерживает счета без указанной суммы платежа.
    .no-nwc-answer = <b>⚠️ Не удалось получить ответ от NWC.</b>
        Статус платежа неизвестен. Проверь баланс.
    .nwc-payment-failed = <b>⚠️ Платеж не прошёл.</b>
        Проверь баланс.
    .invoice-already-paid = <b>⚠️ Этот счёт уже оплачен.</b>
    .invoice-generation-failed = <b>⚠️ Не удалось создать Lightning-счёт.</b>
        Попробуй ещё раз через минуту. Если это заявка на вступление в чат — подай её снова.
    .no-recipient = <b>⚠️ Не указан получатель.</b>
    .to-bot = <b>⚠️ Ты не можешь отправлять саты ботам.</b>
    .from-bot = <b>⚠️ Нельзя отправлять от лица бота, канала, группы или анонимного профиля.</b>
        Пиши со своего личного аккаунта.

start = <img src="https://zapgram.mozharov.me/assets/bot-description-ru.png"/>
    <h1>⚡ {bot-name}</h1>
    <p>Bitcoin Lightning кошелёк: отправляй и получай сатоши в чатах, включай платный доступ к группам и каналам.</p>

    <h2>Как это работает</h2>
    <ol>
    <li>Открой Кошелёк — внутренний кошелёк уже готов к работе.</li>
    <li>Получи сатоши или отправь их другому пользователю Telegram. Переводы внутри Telegram мгновенные, комиссия — 0.</li>
    <li>При желании подключи свой Lightning-кошелёк через NWC. Сатоши останутся под твоим контролем.</li>
    </ol>

    <details><summary>Добровольная поддержка 5% включена</summary><p>По умолчанию включён добровольный донат 5% от суммы перевода только при отправке /tip в чатах. Оплата счетов не входит. Изменить или отключить: /donate.</p></details>

    <footer>🤝 При поддержке сообщества <a href="https://t.me/bitcoin21ideas">21 идея</a>.</footer>

feature =
    .prompt = 💡 <b>Что сделать в боте?</b>
        Пришли одно текстовое сообщение с идеей.
        Или так: <code>/feature твоя идея</code>.
    .invalid-text = ⚠️ Пришли непустое текстовое сообщение с идеей.
    .fund-prompt = 💰 Можно прикрепить сатоши к этой идее (тип, не обещание, что сделаем).
        Выбери сумму ниже, пришли любую другую числом или отправь бесплатно.
    .invalid-amount = ⚠️ Введи целое число сат от 1 до 100000000.
    .submitted = ✅ Спасибо! Запрос фичи отправлен.
    .submitted-funded = ✅ Спасибо! Запрос отправлен с <b>{$sats}</b> сат{$usdSuffix}.
    .fund-failed-submitted = ⚠️ Не удалось списать саты, но запрос всё равно отправлен без финансирования.

broadcast =
    .pick-locale = 📣 <b>Рассылка</b>
        Выбери язык аудитории:
    .locale-en = 🇬🇧 English
    .locale-ru = 🇷🇺 Русский
    .send-message = ✏️ Отправь сообщение для рассылки (текст, фото, видео, документ…).
        Оно будет скопировано пользователям через Telegram <code>copyMessage</code>.
    .invalid-message = ⚠️ Пришли обычное сообщение (не команду бота) как тело рассылки.
    .confirm-yes = ✅ Отправить
    .confirm-no = ❌ Отмена

donation = 
    .failed = ⚠️ Платёж прошёл, но опциональный донат {$donationSats} сат{$usdSuffix} отправить не удалось. Проверь баланс / NWC или используй /donate.

donate = 
    .hub = 💚 <b>Поддержать {bot-name}</b>
        Спасибо, что помогаешь проекту жить.

        🌍 <b>Сообщество</b>
        ⏱ За всё время: <b>{$platformTotalSats}</b> сат{$platformTotalUsdSuffix}
        📅 За 30 дней: <b>{$platformLastMonthSats}</b> сат{$platformLastMonthUsdSuffix}

        👤 <b>Ты</b>
        💸 Отправлено: <b>{$totalSats}</b> сат{$totalUsdSuffix} · {$count} платежей
        🕐 {$last}
        📅 Ежемесячно: <b>{$monthlyStatus}</b>
        ⚡️ Авто с платежей: <b>{$autoPercent}</b> · {$autoScope}

        Нажми сумму для разового доната или открой «Ежемесячно» / «Авто %».

        🤝 Проект поддерживается сообществом <a href="https://t.me/bitcoin21ideas">21 идея</a>

        ⚡ <b>Lightning-адрес:</b> <code>zapgram@getalby.com</code>
    .stats-last = Последний: {TGTIME($date, format: "d")}
    .stats-last-none = Донатов пока нет
    .auto-off = Выкл
    .auto-on = {$percent}%
    .auto-scope-tips = только tips
    .auto-scope-all = tips + счета
    .success = ✅ Спасибо! Ты отправил {$sats} сат{$usdSuffix} в поддержку {bot-name}.
    .failed = ⚠️ Не удалось отправить {$sats} сат{$usdSuffix}. Проверь баланс или NWC.
    .invalid-amount = ⚠️ Введи целое число сат от 1 до 100000000.
    .custom-amount = 🔤 Введи сумму доната в сатоши.
    .monthly-status-on = {$sats} сат{$usdSuffix} / 30 дней
    .monthly-status-off = Выкл
    .monthly-menu = 📅 <b>Ежемесячный донат</b>

        Сейчас: <b>{$sats}</b> сат{$usdSuffix} (0 = выкл).
        Выбери сумму. При включении спишем сразу, затем каждые 30 дней.
        «Назад» — в общий хаб поддержки (разово + авто %).
    .monthly-enabled = ✅ Ежемесячный донат: {$sats} сат{$usdSuffix}. Первый платёж получен; следующий через 30 дней.
    .monthly-enable-failed = ⚠️ Ежемесячный донат: {$sats} сат{$usdSuffix}, но первый платёж не прошёл. Повторим автоматически. Проверь баланс / NWC.
    .monthly-amount-updated = ✅ Сумма обновлена: {$sats} сат{$usdSuffix}. Следующее списание по расписанию.
    .monthly-disabled-toast = Ежемесячный донат отключён
    .monthly-failed = ⚠️ Не удалось списать ежемесячный донат {$sats} сат{$usdSuffix}. Проверь баланс / NWC или /donate.
    .monthly-custom-amount = 🔤 Введи сумму ежемесячного доната в сатоши.

help = <img src="https://zapgram.mozharov.me/assets/bot-description-ru.png"/>
    <h1>Как работает {bot-name}</h1>
    <p>{bot-name} добавляет в Telegram быстрые Bitcoin-платежи, tips и платный доступ к сообществам через Lightning Network.</p>

    <details open><summary>Кошельки и комиссии</summary>
    <ul>
    <li><b>Внутренний кошелёк:</b> кастодиальное хранение на серверах {bot-name}. Переводы между пользователями Telegram мгновенные и бесплатные.</li>
    <li><b>Внешний кошелёк:</b> подключи свой кошелёк через NWC. Сатоши останутся под твоим контролем, а {bot-name} будет действовать в заданных тобой лимитах.</li>
    <li>Совместимые NWC-кошельки: <a href="https://getalby.com/invited-by/mozharov">Alby</a> (рекомендуется) и <a href="https://coinos.io">Coinos</a>.</li>
    <li>При отправке из внутреннего кошелька {bot-name} на внешний кошелёк комиссия составляет 1 сат + 1.5% от суммы.</li>
    </ul>
    </details>

    <details><summary>Платежи и tips</summary>
    <ul>
    <li>Для быстрой оплаты отправь Lightning-счёт в этот чат.</li>
    <li>Добавь {bot-username} в группу или канал, чтобы участники могли отправлять tips.</li>
    <li>Переводы между пользователями {bot-name} внутри Telegram проходят без комиссии.</li>
    </ul>
    </details>

    <details><summary>Группы, каналы и платный доступ</summary><p>Добавь {bot-username} в закрытую группу или канал, чтобы настроить разовую оплату или ежемесячную подписку. Для платного доступа сделай бота админом с правами приглашать и банить. Управление доступно в разделе «Чаты» внутри Кошелька.</p></details>

    <details><summary>Добровольная поддержка</summary><p>Для новых аккаунтов по умолчанию включён вклад 5% только с tips; оплата счетов не входит. Изменить или отключить: /donate. Также доступен адрес <code>zapgram@getalby.com</code>.</p></details>

    <details><summary>Узнать о Bitcoin и Lightning</summary>
    <ul>
    <li><a href="https://21ideas.org/start/start/">Что такое Bitcoin?</a></li>
    <li><a href="https://21ideas.org/chto-takoe-laitning/">Что такое Lightning Network?</a></li>
    </ul>
    </details>

    <h2>Партнёр: 21 идея</h2>
    <p>Сообщество <a href="https://21ideas.org">21 идея</a> использует {bot-name} для tips и платного доступа. Канал: <a href="https://t.me/bitcoin21ideas">@bitcoin21ideas</a>. Также доступен <a href="https://21ideas.org/zapgram/">гайд по ZapGram</a>.</p>
    <hr/>
    <footer>Открытый код: <a href="https://github.com/v-mozharov/zapgram">GitHub</a> · Поддержка: @vmozharov · Предложить функцию: /feature</footer>

wallet = <h1>👛 Кошелёк</h1>
    {$nwcBalance ->
    [no] <p><b>Баланс:</b> {$balance} сат{$usdSuffix}</p>
    *[other] <p><b>{bot-name}:</b> {$balance} сат{$usdSuffix}</p>
        <p><b>NWC:</b> {$nwcBalance} сат{$nwcUsdSuffix}</p>
    }

nwc = 
    .disconnected = <b>✅ Кошелёк отключён от {bot-name}.</b>
    .connecting = <b>🔗 Подключение кошелька по NWC...</b>
    .wait-url = <b>🔤 Введи NWC URL твоего Lightning кошелька.</b> 
        Он должен начинаться с <i>nostr+walletconnect://...</i>
    .invalid-url = <b>⚠️ Невалидный URL NWC.</b>
    .connected = <b>✅ Кошелёк подключён по NWC.</b>

settings = <b>⚙️ Настройки</b>

    <b>⚡️ Подключение внешнего кошелька</b>
    Подключи свой Lightning-кошелёк к {bot-name} через Nostr Wallet Connect (NWC), чтобы совершать платежи напрямую из подключённого кошелька.

    <b>Обрати внимание:</b> для стабильной работы подключённого по NWC кошелька необходимо постоянно поддерживать его в сети.
    Если твой NWC-кошелёк будет недоступен во время платежа, платёж не пройдёт. Используй кошелёк {bot-name}, если поддержание NWC-кошелька в сети для тебя проблематично.

    <i>Используй /help для дополнительной информации.</i>
    .groups = <b>👥 Чаты</b>
        Ты можешь добавить {bot-username} в групповой чат, чтобы включить донаты в чате с помощью команды /tip.

        <b>Платный доступ</b> настраивается отдельно: сделай бота админом с правами приглашать и банить, затем открой <b>Платные чаты</b> ниже (или <code>/chats</code>). Одно только добавление бота платный доступ не включает.

        <b>Примеры использования:</b>
        • <code>/tip</code> — отправить 21 сат владельцу чата 
        • <code>/tip 100</code> — отправить 100 сат владельцу чата
        • (ответ на сообщение) <code>/tip</code> — отправить 21 сат автору сообщения
        • (ответ на сообщение) <code>/tip 1000</code> — отправить 1000 сат автору сообщения
        • <code>/tip @user</code> — отправить 21 сат выбранному пользователю
        • <code>/tip 50 @user</code> — отправить 50 сат выбранному пользователю

        <b>Расширенные возможности</b>
        Если ты сделаешь {bot-name} администратором своей группы, то все /tip без указанного получателя будут отправляться на твой кошелёк. {bot-name} будет автоматически удалять все технические сообщения, чтобы поддерживать чистоту в чате. Для корректной работы боту необходимы только права на удаления сообщений.
        
        Если ты сделаешь {bot-name} администратором своего канала, то все /tip в ответ на публикации этого канала будут отправляться на твой кошелёк.

settings-donation = ⚡️ <b>Авто % с платежей</b>

    Сейчас: <b>{$status}</b> · {$scope}

    Добровольный % сверху tips и оплаты счетов (основной платёж не блокируется).
    0% — выкл. Разово и ежемесячно — кнопки в хабе «Поддержать».
    .off = Выкл
    .percent = {$percent}%
    .scope-tips = только tips
    .scope-all = tips + счета
    .percent-set = Авто %: {$percent}%
    .scope-tips-toast = Область: только tips
    .scope-all-toast = Область: tips + счета
    .custom-percent-prompt = 🔤 Введи процент авто-доната (0–100).
    .invalid-percent = ⚠️ Введи целое число от 0 до 100.

send-menu = <b>✉️ Отправить платёж</b>

    Оплати Lightning счёт или отправь сатоши другому пользователю Telegram.

sending-to-user = <b>✉️ Отправка сат пользователю Telegram...</b>
    .completed = <b>✅ Отправлено {$amount} сат{$usdSuffix} пользователю @{$recipient}.</b>

wait-for-user = <b>👤 Введи username пользователя в формате:</b> <code>@username</code><b>.</b>
    .invalid = <b>⚠️ Невалидный username. Ожидаемый формат:</b> <code>@username</code><b>.</b>
    .selected = <b>👤 @{$username}</b>

wait-for-sats = <b>🔢 Введи сумму в сатах.</b>
    .invalid = <b>⚠️ Неверная сумма. Ожидается целое число от 1 до 100000000.</b>

wait-for-wallet = <b>👛 Выбери кошелёк</b>
    .nwc = <b>⚡️ Выбран NWC-кошелёк.</b>
    .internal = <b>🤖 Выбран кошелёк {bot-name}.</b>
    .auto-only-internal = <b>🤖 Баланса достаточно только на кошельке {bot-name}, поэтому он выбран автоматически.</b>
    .auto-only-nwc = <b>⚡️ Баланса достаточно только на NWC-кошельке, поэтому он выбран автоматически.</b>
    .nwc-unreachable = <b>⚠️ Не удалось подключиться к NWC-кошельку.</b>
    .pay-invoice = <b>👛 Выбери кошелёк для оплаты счёта</b>

sats-received = <b>📩 Тебе пришло {$amount} сат{$usdSuffix}</b>.
    {$username -> 
    [no] Баланс: <b>{$balance} сат{$balanceUsdSuffix}</b>
    *[other] Отправитель: @{$username}.

        Баланс: <b>{$balance} сат{$balanceUsdSuffix}</b>
    }

wait-for-invoice = <b>🗳 Отправь или перешли в этот чат сообщение с Lightning-счётом.</b>
    .invalid = <b>⚠️ Невалидный Lightning-счёт. Ожидаемый формат:</b> <i>lnbc1u1pn42...</i>

wait-for-invoice-review = <b>ℹ️ Проверка счёта</b>

        Сумма: <b>{$amount} сат{$usdSuffix}</b>
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>
        <i></i>
        *[other]{""}
        }{$fee ->
        [no]{""}
        *[other] Комиссия: <b>{$fee} сат{$feeUsdSuffix}</b>
        <i></i>
        }Дата создания: <b>{TGTIME($createdDate, format: "Dt")}</b>
        {$expiryDate ->
        [no]{""}
        *[other] Срок действия: <b>{TGTIME($expiryDate, format: "Dt")}</b>
        }{$hasExpired ->
        [true]
        <b>⚠️ Срок действия счёта истёк.</b>
        *[other]{""}
        }

        <blockquote expandable><code>{$invoice}</code></blockquote>

received-incoming-invoice = 📥 <b>Получен платёж за Lightning-счёт.</b>
        Сумма: <b>{$amount} сат{$usdSuffix}</b>.
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>

            Баланс: <b>{$balance} сат{$balanceUsdSuffix}</b>
        *[other] Баланс: <b>{$balance} сат{$balanceUsdSuffix}</b>
        }

paying-invoice = <b>🧾 Оплата счёта Lightning...</b>
    .paid = <b>✅ Счёт оплачен.</b>

        Сумма платежа: <b>{$amount} сат{$usdSuffix}</b>
        Комиссия: <b>{$fee} сат{$feeUsdSuffix}</b>
        Итого: <b>{$total} сат{$totalUsdSuffix}</b>
        {$wallet ->
        [nwc] Кошелёк: <b>NWC</b>
        *[internal] Кошелёк: <b>{bot-name}</b>
        }
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>
        <i></i>
        *[other]{""}
        }
        <blockquote expandable><code>{$invoice}</code></blockquote>

creating-invoice = <b>🧾 Создание счёта Lightning...</b>
    .created = Сумма: <b>{$amount} сат{$usdSuffix}</b>

        {$wallet ->
        [nwc] Кошелёк: <b>NWC</b>
        *[internal] Кошелёк: <b>{bot-name}</b>
        }

        {$hasDescription ->
        [true] Описание: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }Срок действия: <b>{TGTIME($expiresAt, format: "Dt")}</b>

        <blockquote expandable><code>{$invoice}</code></blockquote>

wait-for-memo = <b>🔡 Введи описание счёта.</b>
    .invalid = <b>⚠️ Невалидное описание. Ожидается строка до 150 символов.</b>

tip = 
    .invalid-command = <b>⚠️ Неверное использование команды.</b>
    .to-author-of-the-message = <b>✅ {$sender} отправил {$sats} сат автору сообщения.</b>
    .to-chat-owner = <b>✅ {$sender} отправил {$sats} сат владельцу чата.</b>
    .to-user = <b>✅ {$sender} отправил(а) {$sats} {$recipient -> 
        [no]сат.
        *[other]сат пользователю {$recipient}.
        }</b>

paid-chat = 
    .bot-removed = <b>⚠️ {bot-name} был удален из {$username -> 
        [no]{$title} 
        *[other]{$title} (@{$username})
        }.</b>
        Платный доступ к этому чату отключен. Добавь {bot-username} в чат с необходимыми правами, чтобы восстановить платный доступ.
    .bot-added = <b>✅ {bot-name} был добавлен в {$username -> 
        [no]{$title} 
        *[other]{$title} (@{$username})
        }.</b>
        Ты можешь настроить платный доступ к этому чату.

chats = <b>👥 Твои чаты с возможностью платного доступа.</b>
    Здесь настраивается платный доступ для чатов, куда бот уже добавлен админом.
    Добавь {bot-username} в чат с правами на приглашение и блокировку, чтобы чат появился в списке.
    .empty = <b>👥 У тебя нет чатов с возможностью платного доступа.</b>
        Добавь {bot-username} в чат с правами на приглашение и блокировку (кнопка ниже), затем снова открой /chats, чтобы настроить платный доступ.

chat = <b>👥 {$title}</b>
    
    Платный доступ: <b>{$status ->
    [active] активен
    *[other] выключен
    }</b>
    Цена: <b>{$price} сат{$usdSuffix}</b>
    Тип оплаты: <b>{$paymentType ->
    [one_time] разовая
    *[other] ежемесячная
    }</b>
    On-chain оплата: <b>{$onchain ->
    [on] включена (fingerprint {$fingerprint})
    *[other] выключена
    }</b>

    <i>При изменении цены или типа оплаты, цена и тип оплаты для существующих подписчиков не изменятся.</i>
    <i>On-chain платежи идут сразу на твой кошелёк (zpub/xpub). Доступ обычно открывается вскоре после появления транзакции в сети.</i>
    <i>Чтобы платный доступ работал, в чате должны быть <b>заявки на вступление</b> (одобрение новых участников / invite-ссылка с запросом на вступление). Тогда бот сможет отправить инвойс вступившему и принять его после оплаты.</i>
    .not-found = <b>👥 Чат не найден.</b>
        Добавь {bot-username} в чат с правами на приглашение и блокировку пользователей, чтобы использовать эту команду.
    .custom-message = <b>💬 Сообщение для заявки на вступление</b>
        Настраивай русскую и английскую версии независимо. Пока язык не настроен, используется текст по умолчанию.

        RU: <b>{$ruStatus}</b>
        EN: <b>{$enStatus}</b>
    .custom-message-status-custom = своё
    .custom-message-status-default = по умолчанию
    .custom-message-preview = <b>👁 Превью · {$locale}</b>

        {$message}

changing-price = <b>₿ Изменение цены платного доступа...</b>
    .completed = <b>✅ Цена платного доступа установлена на {$price} сат{$usdSuffix}.</b>

enabling-onchain = <b>⛓ Включение on-chain оплаты</b>

    Вставь <b>account-level</b> публичный ключ из Sparrow / BlueWallet / Electrum (export watch-only):

    • <b>zpub</b> — рекомендуется (Native SegWit, bc1q), путь <code>m/84'/0'/0'</code>
    • <b>ypub</b> — Nested SegWit, <code>m/49'/0'/0'</code>
    • <b>xpub</b> — Legacy, <code>m/44'/0'/0'</code>
    • Или полный <b>output descriptor</b> из Sparrow (для кастомных путей)

    <i>Не корневой ключ кошелька (depth 0) — нужен xpub/zpub именно <b>аккаунта</b> receive.</i>

    Средства идут только на адреса из этого ключа. {bot-name} не получает твой seed.
    Можно вставить другой ключ или нажать «Отмена».
    .invalid = <b>⚠️ Это не похоже на валидный account-ключ.</b>
        Вставь zpub / xpub / ypub (или дескриптор). Проверь, что скопировал строку целиком.
        Можно попробовать снова или нажать «Отмена».
    .nonstandard-depth = <b>⚠️ Это не account-level xpub/zpub.</b>
        LNbits принимает bare-ключи только на глубине BIP44/49/84 (<code>m/…/0'</code>).

        В Sparrow: аккаунт → export <b>xpub</b> / <b>zpub</b> этого аккаунта, либо <b>output descriptor</b>.
        Можно вставить другой ключ или нажать «Отмена».
    .network-mismatch = <b>⚠️ Сеть ключа не совпадает с ботом.</b>
        На Mainnet — zpub/xpub, на Testnet — <code>tpub</code>/<code>vpub</code>.
        Можно вставить другой ключ или нажать «Отмена».
    .failed = <b>⚠️ Не удалось включить on-chain оплату.</b>
        Проверь ключ и попробуй снова, или нажми «Отмена». Если не поможет — напиши в поддержку.
    .completed = <b>✅ On-chain оплата включена.</b>
        Fingerprint: <code>{$fingerprint}</code>
        Сверь его со своим кошельком.

onchain-invoice =
    .created = <b>⛓ On-chain оплата за "{$title}"</b>

        Отправь <b>не меньше {$price} сат{$usdSuffix}</b> на адрес:

        <code>{$address}</code>

        Тип подписки: <b>{$type ->
        [one_time] вечный доступ
        *[other] доступ на месяц
        }</b>

        <i>Сумма сверх {$price} сат{$usdSuffix} — донат владельцу сообщества.</i>

        {$remaining}
    .paid = <b>✅ Доступ к сообществу "{$title}" получен.</b>

        {$type ->
        [one_time] <i></i>
        *[other] <i>Ежемесячное продление — через Lightning с баланса {bot-name}, если включено автопродление.</i>
            <i>Чтобы получать напоминания об окончании подписки, открой бота и нажми /start.</i>
        }
    .disabled = On-chain оплата для этого чата недоступна.
    .create-failed = Не удалось создать on-chain платёж. Попробуй позже.
    .expired = <b>⚠️ Срок on-chain заявки истёк.</b>
        Нажми <b>Оплатить on-chain</b> снова (или отправь новую заявку) — придёт новый адрес.
    .grace = <b>⚠️ Время оплаты по этому адресу закончилось.</b>
        Если ты уже отправил транзакцию, мы ещё какое-то время ждём её и откроем доступ.
        Иначе нажми <b>Оплатить on-chain</b> для нового адреса.

new-onchain-subscription-payment = <b>⛓ Новый on-chain платёж за подписку!</b>

    Пользователь <b>{$username}</b> оплатил on-chain доступ к <b>"{$title}"</b>.

    Тип подписки: <b>{$type ->
    [one_time] разовая (вечный доступ)
    *[other] ежемесячная
    }</b>

    Сумма: <b>{$price} сат{$usdSuffix}</b>
    Адрес: <code>{$address}</code>

    <i>Средства уже на твоём on-chain кошельке (без Lightning-комиссии платформы).</i>

subscription-invoice = 
    .default-message = <b>🔒 Доступ к закрытому сообществу "{$title}"</b>
    .choose-method = {$message}

    Цена: <b>{$price} сат{$usdSuffix}</b>
    Тип подписки: <b>{$type ->
    [one_time] вечный доступ
    *[other] доступ на месяц
    }</b>

    Выбери способ оплаты:
    .created = {$message}

    Цена: <b>{$price} сат{$usdSuffix}</b>
    Тип подписки: <b>{$type ->
    [one_time] вечный доступ
    *[other] доступ на месяц
    }</b>

    <b>Чтобы получить доступ к сообществу, оплати счёт Lightning:</b>
    <code>{$invoice}</code>

    <b>После успешной оплаты, я сразу предоставу тебе доступ к сообществу.</b>

    {$remaining}
    .insufficient-balance = ⚠️ Недостаточно баланса для оплаты доступа.
    .remaining-time = <i>Счёт истекает <b>{TGTIME($expiresAt, format: "r")}</b>.</i>
    .paid = <b>✅ Доступ к сообществу "{$title}" получен.</b>

    {$type ->
    [one_time] <i></i>
    *[other] <i>Сумма подписки будет автоматически списываться с твоего кошелька {bot-name} каждый месяц.</i>
        <i>Чтобы получать напоминания об окончании и управлять автопродлением, открой бота (/start) и /subscriptions.</i>
    }
    .paid-from-balance = <b>✅ Оплата прошла.</b>
        В течение 5-ти минут ты получишь доступ к сообществу.
    .duplicate-refunded = <b>↩️ Повторный платёж за подписку на {$price} сат{$usdSuffix} зачислен на твой баланс ZapGram.</b>

        Доступ и выплата владельцу сообщества были обработаны только один раз.
    .expired = <b>⚠️ Срок действия счёта на подписку истёк.</b>
        Отправь новую заявку на вступление в чат, чтобы получить новый счёт.

subscription-renewal = 
    .renewed = <b>✅ Твоя подписка на "{$title}" продлена до {TGTIME($expiryDate, format: "D")}.</b>
        Сумма оплаты: <b>{$price} сат{$usdSuffix}</b>
    .need-payment = <b>⚠️ Твоя подписка на "{$title}" истекает через 24 часа. Оплати счёт Lightning на сумму {$price} сат{$usdSuffix}, чтобы продлить доступ на месяц:</b>
        <code>{$invoice}</code>

new-subscription-payment = <b>₿ Новый платёж за подписку!</b>

    Пользователь <b>{$username}</b> оплатил доступ к сообществу <b>"{$title}"</b>.

    Тип подписки: <b>{$type ->
    [one_time] разовая (вечный доступ)
    *[other] ежемесячная
    }</b>
    
    Сумма платежа: <b>{$price} сат{$usdSuffix}</b>
    Комиссия: <b>{$fee} сат{$feeUsdSuffix}</b>
    Получено: <b>{$total} сат{$totalUsdSuffix}</b>

subscriptions = <b>👥 Твои подписки на приватные чаты.</b>
    .empty = <b>👥 У тебя нет активных подписок.</b>

subscription = <b>👥 Подписка на чат "{$chatTitle}"</b>

    Стоимость: <b>{$price} сат{$usdSuffix}</b>
    Срок действия до: <b>{$endsAt ->
        [no] бессрочно
        *[other] {TGTIME($endsAt, format: "Dt")}
    }</b>
    {$endsAt ->
        [no] <i></i>
        *[other] Автопродление: <b>{$autoRenew ->
            [yes] включено
            *[no] отключено
        }</b>
    }
    
    .not-found = <b>👥 Подписка не найдена.</b>

edit-custom-message = 
    .enter-russian = <b>Введи пользовательское сообщение на русском (до 1000 символов):</b>
        Этот текст будет отображаться пользователям, запрашивающим вступление в чат.
    .enter-english = <b>Введи пользовательское сообщение на английском (до 1000 символов):</b>
        Этот текст будет отображаться пользователям, запрашивающим вступление в чат.
    .invalid = ❌ Пожалуйста, отправь валидное текстовое сообщение.
    .too-long = ❌ Сообщение слишком длинное. Максимальная допустимая длина 1000 символов.
    .completed = ✅ Пользовательское сообщение {$locale} обновлено.
