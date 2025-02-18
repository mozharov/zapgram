bot-name = ZapGram
bot-username = @zap_gram_bot

canceled = <b>❌ Действие отменено.</b>

button = 
    .back = ⬅️ Назад
    .help = ℹ️ Помощь
    .settings = ⚙️ Настройки
    .receive = 📩 Получить
    .send = ✉️ Отправить
    .enable-nwc-tips = ⚡️ Использовать NWC для отправки донатов в группах
    .disable-nwc-tips = 🤖 Использовать {bot-name} для отправки донатов в группах
    .disconnect-nwc = 🚫 Отсоединить NWC-кошелёк
    .connect-nwc = ⚡ Подключить кошелёк по NWC
    .groups = 👥 Групповые чаты и каналы
    .cancel = ❌ Отменить
    .add-to-group = 👥 Добавить {bot-name} в группу
    .pay-invoice = ⚡️ Оплатить Lightning счёт
    .send-to-user = 👤 Отправить сатоши пользователю
    .nwc-wallet = ⚡️ NWC
    .internal-wallet = 🤖 {bot-name}
    .confirm-pay-invoice = 📤 Оплатить счёт
    .skip = ➡️ Пропустить

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
    .no-recipient = <b>⚠️ Не указан получатель.</b>
    .to-bot = <b>⚠️ Ты не можешь отправлять саты ботам.</b>
    .from-bot = <b>⚠️ Ты не можешь отправлять саты с этого аккаунта.</b>

start = ⚡ <b>{bot-name} — Bitcoin Lightning кошелёк в Telegram.</b>

    С {bot-name} ты можешь отправлять и получать Bitcoin в чатах Telegram, а так же платить и принимать платежи по всему миру через Lightning Network.


    ℹ️ <b>Два вида кошельков в {bot-name}:</b>
    
    <b>Внутренний кошелёк.</b>
    Твои Bitcoin хранятся на наших серверах, что позволяет избегать комиссий при переводах внутри Telegram. Переводы бесплатны и мгновенны, как сообщения.
      
    <b>Внешний кошелёк.</b>
    Ты можешь подключить свой Lightning-кошелёк через Nostr Wallet Connect (NWC). 
    Твои сатоши остаются полностью под твоим контролем. {bot-name} действует в рамках установленных тобой лимитов.


    👥 <b>Групповые чаты и каналы:</b>
    Добавь {bot-username} в групповой чат, чтобы участники могли легко отправлять и принимать донаты.

    <i>Больше о возможностях {bot-name} в группах и каналах в /settings.</i>


    🕊 <b>Добро пожаловать в мир свободных платежей!</b>
    <i>Подробнее о {bot-name}, Bitcoin, Lightning Network и совместимых кошельках в /help.</i>

help = <b>ℹ️ Bitcoin</b>
    Bitcoin — совершенная форма денег, существующая в интернете. Децентрализованная система без разрешений, не имеющая хозяев и управляющих структур. Bitcoin — устойчивые деньги, которые быстрее, безопаснее и доступнее, чем традиционная финансовая система.
    
    Bitcoin — первый в истории человечества строго ограниченный ресурс; его количество никогда не превысит 21 миллион. 
    Самая маленькая единица Bitcoin — сатоши (сат). 100 000 000 сат = 1 Bitcoin. Фиатная стоимость Биткоина может меняться ежедневно. Однако, если вы живёте по Bitcoin-стандарту, то 1 сат всегда будет равен 1 сату.

    Если хочется узнать больше о Bitcoin, рекомендую начать с этой статьи:
    • <a href="https://21ideas.org/start/start/">Что такое Bitcoin?</a>

    <b>ℹ️ Lightning Network</b>
    Lightning Network — это платёжный протокол, который позволяет совершать быстрые и дешёвые платежи в Bitcoin с минимальным потреблением энергии. Именно он масштабирует Bitcoin для миллиардов людей по всему миру. 
    • <a href="https://21ideas.org/chto-takoe-laitning/">Что такое Lightning Network?</a>

    <b>ℹ️ Совместимые с {bot-name} кошельки (NWC)</b>
    • <a href="https://getalby.com">Alby</a> (рекомендуется)
    • <a href="https://coinos.io">Coinos</a>

    <b>ℹ️ {bot-name}</b>
    • Быстрая оплата: просто отправь сообщение с Lightning-счётом в чат.
    • Открытый исходный код: {bot-name} полностью открыт и доступен на <a href="https://github.com/v-mozharov/zapgram">GitHub</a>.

    <i>При оплате счетов, созданных вне кошелька {bot-name}, взимается комиссия в размере 1 сат + 1.5% от суммы перевода. Комиссия взимается только при оплате из кошелька {bot-name}.</i>

    <i>Если требуется помощь или возникли вопросы по работе {bot-name}, пишите мне в Telegram: @vmozharov</i>

wallet = <b>👛 Кошелёк</b> ㅤ ㅤ ㅤ ㅤ ㅤ

    {$nwcBalance -> 
    [no] <b>Баланс:</b> {$balance} сат
    *[other] <b>{bot-name}:</b> {$balance} сат
        <b>NWC:</b> {$nwcBalance} сат
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
    .groups = <b>👥 Групповые чаты и каналы</b>
        Ты можешь добавить @{bot-username} в групповой чат, чтобы включить донаты в чате с помощью команды /tip.

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

        <b>Синонимы</b>
        Ты также можешь использовать команды /zap или /send вместо команды /tip в группах. Это синонимы.
        Чтобы отключить определенные синонимы в случае, например, конфликта с другими ботами, используй <code>/disable [zap|tip|send]</code> в группе. Чтобы включить синонимы обратно, используй <code>/enable [zap|tip|send]</code> в группе.

        Например, команда <code>/disable tip</code> отключит реагирование на команду /tip в группе.

        Управлять синонимами может только владелец группы.

send-menu = <b>✉️ Отправить платёж</b>

    Оплати Lightning счёт или отправь сатоши другому пользователю Telegram.

sending-to-user = <b>✉️ Отправка сат пользователю Telegram...</b>
    .completed = <b>✅ Отправлено {$amount} сат пользователю @{$recipient}.</b>

wait-for-user = <b>👤 Введи username пользователя в формате:</b> <code>@username</code><b>.</b>
    .invalid = <b>⚠️ Невалидный username. Ожидаемый формат:</b> <code>@username</code><b>.</b>

wait-for-sats = <b>🔢 Введи сумму в сатах.</b>
    .invalid = <b>⚠️ Неверная сумма. Ожидается целое число от 1 до 100000000.</b>

wait-for-wallet = <b>👛 Выбери кошелёк</b>
    .nwc = <b>⚡️ Выбран NWC-кошелёк.</b>
    .internal = <b>🤖 Выбран кошелёк {bot-name}.</b>

sats-received = <b>📩 Тебе пришло {$amount} сат</b>. 
    {$username -> 
    [true] Отправитель: @{$username}.

        Баланс: <b>{$balance} сат</b>
    *[no] Баланс: <b>{$balance} сат</b>
    }

wait-for-invoice = <b>🗳 Отправь или перешли в этот чат сообщение с Lightning-счётом.</b>
    .invalid = <b>⚠️ Невалидный Lightning-счёт. Ожидаемый формат:</b> <i>lnbc1u1pn42...</i>

wait-for-invoice-review = <b>ℹ️ Проверка счёта</b>

        Сумма: <b>{$amount} сат</b>
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }{$fee -> 
        [no] <i></i>
        *[other] Комиссия: <b>{$fee} сат</b>
        <i></i>
        }Дата создания: <b>{DATETIME($createdDate, timeZone: "UTC")} {DATETIME($createdDate, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>
        {$expiryDate ->
        [no] <i></i>
        *[other] Срок действия: <b>{DATETIME($expiryDate, timeZone: "UTC")} {DATETIME($expiryDate, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>
        <i></i>
        }

        {$hasExpired ->
        [true] <b>⚠️ Срок действия счёта истёк.</b>
        *[other] <i></i>
        }

received-incoming-invoice = 📥 <b>Получен платёж за Lightning-счёт.</b>
        Сумма: <b>{$amount} сат</b>.
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>

            Баланс: <b>{$balance} сат</b>
        *[other] Баланс: <b>{$balance} сат</b>
        }

paying-invoice = <b>🧾 Оплата счёта Lightning...</b>
    .paid = <b>✅ Счёт оплачен.</b>

        Сумма платежа: <b>{$amount} сат</b>
        Комиссия: <b>{$fee} сат</b>
        Итого: <b>{$total} сат</b>

creating-invoice = <b>🧾 Создание счёта Lightning...</b>
     .created = Сумма: <b>{$amount} сат</b>
        {$hasDescription ->
        [true] Описание: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }Срок действия: <b>{DATETIME($expiresAt, timeZone: "UTC")} {DATETIME($expiresAt, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>

        Lightning счёт:
        <code>{$invoice}</code>

wait-for-memo = <b>🔡 Введи описание счёта.</b>
    .invalid = <b>⚠️ Невалидное описание. Ожидается строка до 150 символов.</b>
    .skipped = <b>Пропущено.</b>

tip = 
    .invalid-command = <b>⚠️ Неверное использование команды.</b>
    .to-author-of-the-message = <b>✅ {$sender} отправил {$sats} сат автору сообщения.</b>
    .to-chat-owner = <b>✅ {$sender} отправил {$sats} сат владельцу чата.</b>
    .to-user = <b>✅ {$sender} отправил(а) {$sats} {$recipient -> 
        [no]сат.
        *[other]сат пользователю {$recipient}.
        }</b>