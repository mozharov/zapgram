bot-name = ZapGram
bot-username = @zap_gram_bot

canceled = <b>❌ Action canceled.</b>

button = 
    .back = ⬅️ Back
    .help = ℹ️ Help
    .settings = ⚙️ Settings
    .receive = 📩 Receive
    .send = ✉️ Send
    .enable-nwc-tips = ⚡️ Use NWC for tips in groups
    .disable-nwc-tips = 🤖 Use {bot-name} for tips in groups
    .connect-nwc = ⚡ Connect a wallet via NWC
    .disconnect-nwc = 🚫 Disconnect the NWC wallet
    .groups = 👥 Groups and channels
    .cancel = ❌ Cancel
    .add-to-group = 👥 Add {bot-name} to a chat
    .add-chat = 👥 Add a chat
    .pay-invoice = ⚡️ Pay Lightning Invoice
    .send-to-user = 👤 Send payment to a user
    .nwc-wallet = ⚡️ NWC
    .internal-wallet = 🤖 {bot-name}
    .confirm-pay-invoice = 📤 Pay Invoice
    .skip = ➡️ Skip
    .chat-settings = ⚙️ Chat settings
    .prev = ⬅️
    .next = ➡️
    .enable-monthly-payment = 🔄 Turn to monthly payment
    .enable-one-time-payment = 🔄 Turn to one-time payment
    .change-price = Change price
    .enable-paid-access = Enable paid access
    .disable-paid-access = 🚫 Disable paid access
    .pay-subcription-with-wallet = Pay with {bot-name} balance
    .pay-subcription-with-nwc = Pay with NWC
    .enable-auto-renew = 🔄 Enable auto-renewal
    .disable-auto-renew = 🚫 Disable auto-renewal
    .custom-message = 💬 Custom message
    .edit-custom-message = 💬 Edit message
    .remove-custom-message = ❌ Reset to default message
    
callback-answer = 
    .nwc-tip-enabled = ⚡️ Now tips are sent from the NWC wallet
    .nwc-tip-disabled = 🤖 Now tips are sent from the {bot-name} wallet
    .unknown = ⚠️ Unknown button

error = 
    .unknown = <b>⚠️ Unknown error occurred.</b>
    .nwc-connection = <b>⚠️ Failed to connect to the wallet by NWC.</b>
    .nwc-timeout = <b>⚠️ NWC connection timed out.</b>
        Operation status is unknown. Check your NWC wallet connection.
    .to-yourself = <b>⚠️ You can't send sats to yourself.</b>
    .user-does-not-have-wallet = <b>⚠️ This user doesn't have a {bot-name} wallet.</b>
    .insufficient-funds = <b>⚠️ Insufficient funds.</b>
    .invoice-parsing = <b>⚠️ Error processing the Lightning invoice. Please check the invoice for validity.</b>
        ℹ️ {bot-name} currently does not support invoices without a payment amount.
    .no-nwc-answer = <b>⚠️ Could not get an answer from NWC.</b>
        Payment status is unknown. Check your balance.
    .nwc-payment-failed = <b>⚠️ Payment failed.</b>
        Check your balance.
    .invoice-already-paid = <b>⚠️ This invoice has already been paid.</b>
    .no-recipient = <b>⚠️ The recipient is not specified.</b>
    .to-bot = <b>⚠️ You can't send sats to bots.</b>
    .from-bot = <b>⚠️ You can't use {bot-name} from anonymous profile.</b>

start = ⚡ <b>{bot-name} — Bitcoin Lightning wallet in Telegram.</b>

    With {bot-name}, you can send and receive Bitcoin in Telegram chats, as well as pay and accept payments worldwide through the Lightning Network.


    ℹ️ <b>Two types of wallets in {bot-name}:</b>
    
    <b>Internal Wallet.</b>
    Your Bitcoin is stored on our servers, allowing you to avoid fees for transfers within Telegram. Transfers are free and as instant as messages.
      
    <b>External Wallet.</b>
    You can connect your Lightning wallet via Nostr Wallet Connect (NWC).
    Your sats remain fully under your control. {bot-name} operates within the limits you set.


    👥 <b>Groups and channels:</b>
    Add {bot-username} to a group chat so participants can easily send and receive tips.

    <i>Learn more about {bot-name} features in groups and channels in /settings.</i>

    👥 <b>Paid access to private chats:</b>
    Add {bot-username} to a chat with invitation and user blocking permissions to create paid access with one-time payment or monthly subscription.
    Use /chats to manage paid chats.

    🕊 <b>Welcome to the world of free payments!</b>
    <i>Find more details about {bot-name}, Bitcoin, Lightning Network, and supported wallets in /help.</i>

help = <b>ℹ️ Bitcoin</b>
    Bitcoin is the best form of money in our history that lives on the Internet. A decentralized and permissionless system with no rulers or controlling authorities. Bitcoin is sound money that is faster, more secure, and more accessible than fiat currencies we are coerced into using today.  
    
    Bitcoin is the first finitely scarce resource in human history: there will never be more than 21 million bitcoin.  
    The smallest unit of Bitcoin is satoshi (sat). 1 bitcoin = 100,000,000 sats.

    If you want to learn more about Bitcoin, I recommend starting with this article:  
    • <a href="https://21ideas.org/en/start/start/">What is Bitcoin?</a>

    <b>ℹ️ Lightning Network</b>
    The Lightning Network is a payment protocol that enables extremely fast and cheap bitcoin payments. It is open, borderless and efficient. It is available to 650+ million people in the world. It allows you to permissionlessly send and receive nearly instant and nearly free payments anywhere in the world.
    • <a href="https://21ideas.org/en/what-is-lightning-network/">What is Lightning Network?</a>

    <b>ℹ️ {bot-name} compatible wallets (NWC)</b>
    • <a href="https://getalby.com">Alby</a> (recommended)
    • <a href="https://coinos.io">Coinos</a>

    <b>ℹ️ {bot-name}</b>
    • Quick Payment: Simply send a Lightning invoice to the chat.
    • Paid Chat Access: Add {bot-username} to a private chat to create paid access with one-time payment or monthly subscription. Use /chats to manage chats with paid access.
    • Open Source: {bot-name} is fully open source and available on <a href="https://github.com/mozharov/zapgram">GitHub</a>.

    <i>When sending funds from {bot-name} to other wallets, a fee of 1 sat + 1.5% of the transfer amount is charged.</i>

    <i>If you need assistance or have any questions about using {bot-name}, feel free to contact me on Telegram: @vmozharov</i>

wallet = <b>👛 Wallet</b> ㅤ ㅤ ㅤ ㅤ ㅤ

    {$nwcBalance -> 
    [no] <b>Balance:</b> {$balance} sats 
    *[other]<b>{bot-name}:</b> {$balance} sats
        <b>NWC:</b> {$nwcBalance} sats
    }

nwc = 
    .disconnected = <b>✅ Wallet disconnected from {bot-name}.</b>
    .connecting = <b>🔗 Connecting a wallet by NWC...</b>
    .wait-url = <b>🔤 Enter the NWC URL of your Lightning wallet.</b>
        It's must start with <i>nostr+walletconnect://...</i>
    .invalid-url = <b>⚠️ Invalid NWC URL.</b>
    .connected = <b>✅ Wallet connected with NWC.</b>

settings = <b>⚙️ Settings</b>

    <b>⚡️ Connecting an external wallet</b>
    Connect your Lightning wallet to {bot-name} via Nostr Wallet Connect (NWC) so that you can make payments directly from the connected wallet.

    <b>Note:</b> To ensure stable operation of an NWC-connected wallet, it must remain online at all times.  
    If the connected wallet is unavailable during a payment, the transaction will fail. Use {bot-name} Wallet if keeping the connected wallet online is inconvenient for you.

    <i>Use /help to learn more.</i>
    .groups = <b>👥 Groups and channels</b>
        You can add {bot-username} to a group chat to enable tips in the chat using the /tip command.

        <b>Examples of Uses:</b>
        • <code>/tip</code> — send 21 sats to the chat owner
        • <code>/tip 100</code> — send 100 sats to the chat owner
        • (reply to message) <code>/tip</code> — send 21 sats to the author of the message
        • (reply to message) <code>/tip 1000</code> — send 1000 sats to the author of the message
        • <code>/tip @user</code> — send 21 sats to the selected user
        • <code>/tip 50 @user</code> — send 50 sats to the selected user

        <b>Advanced Features</b>
        If you make {bot-name} an admin of your group, all /tip commands without a specified recipient will be sent to your wallet. {bot-name} will automatically delete all technical messages to keep the chat clean. For the bot to work properly, it only needs the rights to delete messages.
        
        If you make {bot-name} an admin of your channel, all /tip commands in reply to that channel's posts will also be sent to your wallet.

send-menu = <b>✉️ Send payment</b>

        Pay a Lightning invoice or send payment to a Telegram user.

sending-to-user = <b>✉️ Sending sats to a Telegram user...</b>
    .completed = <b>✅ You sent {$amount} sats to @{$recipient}.</b>

wait-for-user = <b>👤 Enter the username of the user in this format:</b> <code>@username</code><b>.</b>
    .invalid = <b>⚠️ Invalid username. Expected username in this format:</b> <code>@username</code><b>.</b>

wait-for-sats = <b>🔢 Enter the amount of sats.</b>
    .invalid = <b>⚠️ Invalid amount of sats. Expected integer between 1 and 100000000.</b>

wait-for-wallet = <b>👛 Select Wallet</b>
    .nwc = <b>⚡️ NWC wallet selected.</b>
    .internal = <b>🤖 {bot-name} wallet selected.</b>

sats-received = <b>📩 You received {$amount} sats</b>. 
    {$username -> 
    [true] Sender: @{$username}.

        Balance: <b>{$balance} sats</b>
    *[no] Balance: <b>{$balance} sats</b>
    }

wait-for-invoice = <b>🗳 Send or forward a message with a Lightning invoice to this chat.</b>
    .invalid = <b>⚠️ Invalid Lightning invoice. An invoice in the format</b> <i>lnbc1u1pn42...</i> <b>is expected.</b>

wait-for-invoice-review = <b>ℹ️ Invoice review</b>

        Amount: <b>{$amount} sats</b>
        {$hasDescription ->
        [true] Description: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }{$fee -> 
        [no] <i></i>
        *[other] Fee: <b>{$fee} sats</b>
        <i></i>
        }Created at: <b>{DATETIME($createdDate, timeZone: "UTC")} {DATETIME($createdDate, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>
        {$expiryDate ->
        [no] <i></i>
        *[other] Expires at: <b>{DATETIME($expiryDate, timeZone: "UTC")} {DATETIME($expiryDate, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>
        <i></i>
        }

        {$hasExpired ->
        [true] <b>⚠️ Invoice expired.</b>
        *[other] <i></i>
        }

received-incoming-invoice = 📥 <b>You received payment for a Lightning invoice.</b>
        Amount: <b>{$amount} sats</b>.
        {$hasDescription ->
        [true] Description: <b>{$description}</b>

            Balance: <b>{$balance} sats</b>
        *[other] Balance: <b>{$balance} sats</b>
        }

paying-invoice = <b>🧾 Paying Lightning invoice...</b>
    .paid = <b>✅ Invoice paid.</b>

        Payment amount: <b>{$amount} sats</b>
        Fee: <b>{$fee} sats</b>
        Total: <b>{$total} sats</b>

creating-invoice = <b>🧾 Creating Lightning invoice...</b>
    .created = Amount: <b>{$amount} sats</b>
        {$hasDescription ->
        [true] Description: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }Expires at: <b>{DATETIME($expiresAt, timeZone: "UTC")} {DATETIME($expiresAt, hour: "numeric", minute: "numeric", timeZone: "UTC")} (UTC)</b>

        Lightning Invoice:
        <code>{$invoice}</code>

wait-for-memo = <b>🔡 Enter a memo for the invoice.</b>
    .invalid = <b>⚠️ Invalid memo. Expected string up to 150 characters.</b>
    .skipped = <b>Skipped.</b>

tip = 
    .invalid-command = <b>⚠️ Invalid command usage.</b>
    .to-author-of-the-message = <b>✅ {$sender} sent {$sats} sats to the author of this message.</b>
    .to-chat-owner = <b>✅ {$sender} sent {$sats} sats to the owner of this group.</b>
    .to-user = <b>✅ {$sender} sent {$sats} {$recipient -> 
        [no]sats.
        *[other]sats to {$recipient}.
        }</b>

paid-chat = 
    .bot-removed = <b>⚠️ {bot-name} was removed from {$username -> 
        [no]{$title} 
        *[other]{$title} (@{$username})
        }.</b>
        Paid access to this chat is disabled. Add {bot-username} to the chat with required rights to restore paid access.
    .bot-added = <b>✅ {bot-name} was added to {$username -> 
        [no]{$title} 
        *[other]{$title} (@{$username})
        }.</b>
        You can set up paid access to this chat.

chats = <b>👥 Your chats with the ability to enable paid access.</b>
    Add {bot-username} to a chat with invite and ban permissions to make it appear in the list.
    .empty = <b>👥 You don't have any chats with the ability to enable paid access.</b>
        Add {bot-username} to a chat with invite and ban permissions to make it appear in the list.

chat = <b>👥 {$title}</b>
    
    Paid access: <b>{$status ->
    [active] enabled
    *[other] disabled
    }</b>
    Price: <b>{$price} sats</b>
    Payment type: <b>{$paymentType ->
    [one_time] one-time
    *[other] monthly
    }</b>

    <i>When changing the price or payment type, the price and payment type for existing subscribers will not change.</i>
    .not-found = <b>👥 Chat not found.</b>
        Add {bot-username} to a chat with invite and ban permissions to use this command.
    .custom-message = You can change the part of the message that users see when they request to join the chat.

        <b>Current message:</b>
        
        <b>Ru:</b>
        {$ruMessage}

        <b>En:</b>
        {$enMessage}

changing-price = <b>₿ Changing the price of paid access...</b>
    .completed = <b>✅ The price of paid access has been set to {$price} sats.</b>

subscription-invoice = 
    .default-message = <b>🔒 Access to private community "{$title}"</b>
    .created = {$message}

    Price: <b>{$price} sats</b>
    Subscription type: <b>{$type ->
    [one_time] permanent access
    *[other] one month access
    }</b>

    <b>To get access to the community, pay the Lightning invoice:</b>
    <code>{$invoice}</code>

    <b>After successful payment, I will immediately grant you access to the community.</b>

    <i>The invoice is valid for 24 hours. To request a new invoice, submit another request to join the chat.</i>
    .paid = <b>✅ Access to the community "{$title}" received.</b>

    {$type ->
    [one_time] <i></i>
    *[other] <i>The subscription amount will be automatically debited from your {bot-name} wallet every month.</i>
        <i>For control of automatic debits, use the /subscriptions command.</i>
    }
    .paid-from-balance = <b>✅ Payment completed.</b>
        Access to the community will be granted within 5 minutes.

subscription-renewal = 
    .success = <b>✅ Your subscription to "{$title}" has been automatically renewed until {DATETIME($expiryDate, timeZone: "UTC")}.</b>
        Payment amount: <b>{$price} sats</b>
    .need-payment = <b>⚠️ Your subscription to "{$title}" expires in 24 hours. Pay the Lightning invoice for {$price} sats to extend access for one month:</b>
        <code>{$invoice}</code>

new-subscription-payment = <b>₿ New subscription payment!</b>

    User <b>{$username}</b> has paid for access to the community <b>"{$title}"</b>.

    Subscription type: <b>{$type ->
    [one_time] one-time (permanent access)
    *[other] monthly
    }</b>
    
    Payment amount: <b>{$price} sats</b>
    Fee: <b>{$fee} sats</b>
    Credited: <b>{$total} sats</b>

subscriptions = <b>👥 Your subscriptions to private chats.</b>
    .empty = <b>👥 You don't have any subscriptions.</b>


subscription = <b>👥 Subscription to chat "{$chatTitle}"</b>

    Price: <b>{$price} sats</b>
    Valid until: <b>{$endsAt ->
        [no] permanent
        *[other] {$endsAt}
    }</b>
    {$endsAt ->
        [no] <i></i>
        *[other] Auto-renewal: <b>{$autoRenew ->
            [yes] enabled
            *[no] disabled
        }</b>
    }
    
    .not-found = <b>👥 Subscription not found.</b>

edit-custom-message = 
    .enter-russian = <b>Enter a custom message in Russian (up to 1000 characters):</b>
        This text will be displayed to users requesting to join the chat.
    .enter-english = <b>Enter a custom message in English (up to 1000 characters):</b>
        This text will be displayed to users requesting to join the chat.
    .invalid = ❌ Please send a valid text message.
    .too-long = ❌ The message is too long. Maximum allowed length is 1000 characters.
    .completed = ✅ Custom message has been updated successfully.
