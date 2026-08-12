bot-name = ZapGram
bot-username = @zap_gram_bot

canceled = <b>❌ Action canceled.</b>

conversation-state =
    .cancelled = <i>Action canceled.</i>
    .inactive = <i>This step is no longer active.</i>
    .interrupted-fallback = ❌ Previous action canceled: {$action}.
    .inactive-fallback = ℹ️ Previous step is no longer active: {$action}.
    .invoice-memo-inactive = <i>Adding a description is no longer active.</i>
    .use-buttons = Use the buttons on the active message.

conversation-action =
    .enter-sats = entering an amount
    .enter-invoice = entering a Lightning invoice
    .connect-nwc = connecting an NWC wallet
    .select-recipient = selecting a recipient
    .edit-message-ru = editing the Russian join message
    .edit-message-en = editing the English join message
    .select-wallet = selecting a wallet
    .confirm-invoice-payment = confirming an invoice payment
    .invoice-memo-options = adding an invoice description
    .enter-invoice-memo = entering an invoice description
    .enable-onchain = enabling on-chain payments
    .donate-one-shot = entering a support amount
    .donation-percent = entering an auto-donation percent
    .donate-monthly = entering a monthly support amount
    .feature-text = entering a feature request
    .feature-fund = choosing feature funding
    .feature-fund-amount = entering a feature funding amount
    .broadcast-locale = selecting a broadcast language
    .broadcast-source = selecting a broadcast message
    .broadcast-confirm = confirming a broadcast

button = 
    .back = ⬅️ Back
    .help = ℹ️ Help
    .settings = ⚙️ Settings
    .receive = 📩 Receive
    .send = ✉️ Send
    .subscriptions = 🔐 My subscriptions
    .chats = 👥 Chats
    .feature-request = 💡 I want a feature
    .open-wallet = 👛 Open wallet
    .how-it-works = ℹ️ How it works
    .enable-nwc-tips = ⚡️ Use NWC for tips in groups
    .disable-nwc-tips = 🤖 Use {bot-name} for tips in groups
    .connect-nwc = ⚡ Connect a wallet via NWC
    .disconnect-nwc = 🚫 Disconnect the NWC wallet
    .groups = 👥 Groups and channels
    .cancel = ❌ Cancel
    .add-to-group = 👥 Add to a chat
    .add-chat = 👥 Add chat
    .paid-chats = 🔐 Paid chats
    .add-invoice-memo = 🔡 Add memo
    .copy-invoice = 📋 Copy invoice
    .pay-invoice = ⚡️ Pay Lightning Invoice
    .send-to-user = 👤 Send payment to a user
    .nwc-wallet = ⚡️ NWC
    .nwc-wallet-with-balance = ⚡️ NWC · {$balance} sats
    .internal-wallet = 🤖 {bot-name}
    .internal-wallet-with-balance = 🤖 {bot-name} · {$balance} sats
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
    .pay-subcription-with-wallet = 💰 Pay with {bot-name} balance
    .pay-subcription-with-nwc = 💰 Pay with NWC
    .enable-auto-renew = 🔄 Enable auto-renewal
    .disable-auto-renew = 🚫 Disable auto-renewal
    .custom-message = 💬 Custom message
    .edit-custom-message = 💬 Edit message
    .remove-custom-message = ❌ Reset to default message
    .edit-custom-message-locale = ✏️ Edit {$locale}
    .preview-custom-message = 👁 Preview {$locale}
    .reset-custom-message = ♻️ Reset {$locale}
    .enable-onchain = ⛓ Enable on-chain pay
    .disable-onchain = 🚫 Disable on-chain pay
    .pay-onchain = ⛓ Bitcoin
    .pay-lightning = ⚡ Lightning
    .donation-settings = ⚡️ Auto % on tips
    .donate = 💚 Support project
    .donate-amount = {$sats} sats
    .donate-custom = ✏️ Custom amount…
    .donate-custom-short = ✏️
    .donate-monthly = 📅 Monthly
    .donate-monthly-on = 📅 {$sats}/30d
    .donate-monthly-disable = 🚫 Disable monthly
    .donation-auto-percent = ⚡️ Auto %
    .donation-percent = {$percent}%
    .donation-custom-percent = ✏️ Custom %…
    .donation-scope-tips = Tips only
    .donation-scope-all = Tips + invoices
    .back-to-support = ⬅️ Support
    .feature-fund-skip = Skip
    .feature-fund-custom-short = ✏️

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
    .invoice-generation-failed = <b>⚠️ Failed to create the Lightning invoice.</b>
        Please try again in a moment. If you requested chat access, send a new one.
    .no-recipient = <b>⚠️ The recipient is not specified.</b>
    .to-bot = <b>⚠️ You can't send sats to bots.</b>
    .from-bot = <b>⚠️ You can't send from a bot, channel, group, or anonymous profile.</b>
        Use your personal account.

start = <img src="https://zapgram.mozharov.me/assets/bot-description-en.png"/>
    <h1>⚡ {bot-name}</h1>
    <p>A Bitcoin Lightning wallet: send and receive sats, tip people in chats, and manage paid access to groups and channels.</p>

    <h2>How it works</h2>
    <ol>
    <li>Open Wallet — your internal wallet is ready immediately.</li>
    <li>Receive sats or send them to another Telegram user. Transfers inside Telegram are instant and have zero fees.</li>
    <li>Optionally connect your own Lightning wallet through NWC. Your sats remain under your control.</li>
    </ol>

    <details><summary>Voluntary support 5% included</summary><p>For new accounts, a voluntary 5% donation is enabled by default for tips only. Invoice payments are excluded. Change or disable it in /donate.</p></details>

    <footer>🤝 Supported by the <a href="https://t.me/bitcoin21ideas">21ideas</a> community.</footer>

feature =
    .prompt = 💡 <b>What should we build?</b>
        Send one text message with your idea.
        Or use <code>/feature your idea here</code>.
    .invalid-text = ⚠️ Send a non-empty text message with your idea.
    .fund-prompt = 💰 Optionally attach sats to this idea (tip, not a promise we ship it).
        Or skip to send for free.
    .custom-amount = 🔤 Enter how many sats to attach (1–100000000).
    .invalid-amount = ⚠️ Enter a whole number of sats between 1 and 100000000.
    .submitted = ✅ Thanks! Your feature request was sent.
    .submitted-funded = ✅ Thanks! Your request was sent with <b>{$sats}</b> sats{$usdSuffix} attached.
    .fund-failed-submitted = ⚠️ Could not charge sats, but your feature request was still sent without funding.

broadcast =
    .pick-locale = 📣 <b>Broadcast</b>
        Choose the audience language:
    .locale-en = 🇬🇧 English
    .locale-ru = 🇷🇺 Russian
    .send-message = ✏️ Send the message to broadcast (text, photo, video, document…).
        It will be copied to users via Telegram <code>copyMessage</code>.
    .invalid-message = ⚠️ Send a regular message (not a bot command) to use as the broadcast body.
    .confirm-yes = ✅ Send
    .confirm-no = ❌ Cancel

donation = 
    .failed = ⚠️ Your payment succeeded, but the optional {$donationSats} sat{$usdSuffix} support tip could not be sent. Check balance / NWC, or use /donate.

donate = 
    .hub = 💚 <b>Support {bot-name}</b>
        Thanks for keeping the project alive.

        🌍 <b>Community</b>
        ⏱ All time: <b>{$platformTotalSats}</b> sats{$platformTotalUsdSuffix}
        📅 Last 30 days: <b>{$platformLastMonthSats}</b> sats{$platformLastMonthUsdSuffix}

        👤 <b>You</b>
        💸 Sent: <b>{$totalSats}</b> sats{$totalUsdSuffix} · {$count} payments
        🕐 {$last}
        📅 Monthly: <b>{$monthlyStatus}</b>
        ⚡️ Auto on payments: <b>{$autoPercent}</b> · {$autoScope}

        Tap an amount for a one-shot donation, or open Monthly / Auto %.

        🤝 Project is supported by the <a href="https://t.me/bitcoin21ideas">21ideas</a> community

        ⚡ <b>Lightning address:</b> <code>zapgram@getalby.com</code>
    .stats-last = Last: {TGTIME($date, format: "d")}
    .stats-last-none = No donations yet
    .auto-off = Off
    .auto-on = {$percent}%
    .auto-scope-tips = tips only
    .auto-scope-all = tips + invoices
    .success = ✅ Thanks! You sent {$sats} sats{$usdSuffix} to support {bot-name}.
    .failed = ⚠️ Could not send {$sats} sats{$usdSuffix}. Check your balance or NWC connection.
    .invalid-amount = ⚠️ Enter a whole number of sats between 1 and 100000000.
    .custom-amount = 🔤 Enter the amount in sats you want to donate.
    .monthly-status-on = {$sats} sats{$usdSuffix} / 30 days
    .monthly-status-off = Off
    .monthly-menu = 📅 <b>Monthly donation</b>

        Current: <b>{$sats}</b> sats{$usdSuffix} (0 = off).
        Choose an amount. Enabling charges once now, then every 30 days.
        Back returns to the full support hub (one-shot + auto %).
    .monthly-enabled = ✅ Monthly donation set to {$sats} sats{$usdSuffix}. First payment received; next charge in 30 days.
    .monthly-enable-failed = ⚠️ Monthly donation set to {$sats} sats{$usdSuffix}, but the first charge failed. We will retry automatically. Check balance / NWC.
    .monthly-amount-updated = ✅ Monthly amount updated to {$sats} sats{$usdSuffix}. Next charge stays on schedule.
    .monthly-disabled-toast = Monthly donation disabled
    .monthly-failed = ⚠️ Could not charge your monthly {$sats} sat{$usdSuffix} donation. Check balance / NWC or /donate.
    .monthly-custom-amount = 🔤 Enter monthly donation amount in sats.

help = <img src="https://zapgram.mozharov.me/assets/bot-description-en.png"/>
    <h1>How {bot-name} works</h1>
    <p>{bot-name} brings fast Bitcoin payments, tips, and paid communities to Telegram through the Lightning Network.</p>

    <details open><summary>Wallets and fees</summary>
    <ul>
    <li><b>Internal wallet:</b> custodial storage on {bot-name} servers. Transfers between Telegram users are instant and free.</li>
    <li><b>External wallet:</b> connect your own wallet through NWC. Your sats stay under your control and {bot-name} acts within the limits you set.</li>
    <li>Compatible NWC wallets: <a href="https://getalby.com/invited-by/mozharov">Alby</a> (recommended) and <a href="https://coinos.io">Coinos</a>.</li>
    <li>Sending from the internal {bot-name} wallet to an external wallet costs 1 sat + 1.5% of the transfer amount.</li>
    </ul>
    </details>

    <details><summary>Payments and tips</summary>
    <ul>
    <li>To pay quickly, send a Lightning invoice to this chat.</li>
    <li>Add {bot-username} to a group or channel so participants can send tips.</li>
    <li>Transfers between {bot-name} users inside Telegram have zero fees.</li>
    </ul>
    </details>

    <details><summary>Groups, channels, and paid access</summary><p>Add {bot-username} to a private group or channel to create access with a one-time payment or a monthly subscription. For paid access, make the bot an admin with invite and ban rights. Manage everything through Chats in the Wallet.</p></details>

    <details><summary>Voluntary support</summary><p>New accounts contribute 5% on tips only by default; invoice payments are excluded. Change or disable this in /donate. You can also use <code>zapgram@getalby.com</code>.</p></details>

    <details><summary>Learn about Bitcoin and Lightning</summary>
    <ul>
    <li><a href="https://21ideas.org/en/start/start/">What is Bitcoin?</a></li>
    <li><a href="https://21ideas.org/en/what-is-lightning-network/">What is Lightning Network?</a></li>
    </ul>
    </details>

    <h2>Partner: 21ideas</h2>
    <p>The <a href="https://21ideas.org/en/">21ideas</a> community uses {bot-name} for tips and paid access. Follow <a href="https://t.me/bitcoin21ideas">@bitcoin21ideas</a> or read the <a href="https://21ideas.org/zapgram/">ZapGram guide</a>.</p>
    <hr/>
    <footer>Open source: <a href="https://github.com/v-mozharov/zapgram">GitHub</a> · Support: @vmozharov · Suggest a feature: /feature</footer>

wallet = <h1>👛 Wallet</h1>
    {$nwcBalance ->
    [no] <p><b>Balance:</b> {$balance} sats{$usdSuffix}</p>
    *[other] <p><b>{bot-name}:</b> {$balance} sats{$usdSuffix}</p>
        <p><b>NWC:</b> {$nwcBalance} sats{$nwcUsdSuffix}</p>
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
    .groups = <b>👥 Chats</b>
        You can add {bot-username} to a group chat to enable tips in the chat using the /tip command.

        <b>Paid access</b> is configured separately: make the bot an admin with invite and ban rights, then open <b>Paid chats</b> below (or <code>/chats</code>). Adding the bot alone does not enable paid access.

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

settings-donation = ⚡️ <b>Auto % on payments</b>

    Current: <b>{$status}</b> · {$scope}

    A voluntary % added on top of your tips and invoice pays (never blocks the main payment).
    0% turns it off. One-shot and monthly: use the Support hub buttons.
    .off = Off
    .percent = {$percent}%
    .scope-tips = tips only
    .scope-all = tips + invoices
    .percent-set = Auto % set to {$percent}%
    .scope-tips-toast = Scope: tips only
    .scope-all-toast = Scope: tips + invoices
    .custom-percent-prompt = 🔤 Enter auto-donation percent (0–100).
    .invalid-percent = ⚠️ Enter an integer between 0 and 100.

send-menu = <b>✉️ Send payment</b>

        Pay a Lightning invoice or send payment to a Telegram user.

sending-to-user = <b>✉️ Sending sats to a Telegram user...</b>
    .completed = <b>✅ You sent {$amount} sats{$usdSuffix} to @{$recipient}.</b>

wait-for-user = <b>👤 Enter the username of the user in this format:</b> <code>@username</code><b>.</b>
    .invalid = <b>⚠️ Invalid username. Expected username in this format:</b> <code>@username</code><b>.</b>
    .selected = <b>👤 @{$username}</b>

wait-for-sats = <b>🔢 Enter the amount of sats.</b>
    .invalid = <b>⚠️ Invalid amount of sats. Expected integer between 1 and 100000000.</b>

wait-for-wallet = <b>👛 Select Wallet</b>
    .nwc = <b>⚡️ NWC wallet selected.</b>
    .internal = <b>🤖 {bot-name} wallet selected.</b>
    .auto-only-internal = <b>🤖 Only the {bot-name} wallet has enough balance, so it was selected automatically.</b>
    .auto-only-nwc = <b>⚡️ Only the NWC wallet has enough balance, so it was selected automatically.</b>
    .nwc-unreachable = <b>⚠️ Couldn't reach the connected NWC wallet.</b>

sats-received = <b>📩 You received {$amount} sats{$usdSuffix}</b>.
    {$username -> 
    [no] Balance: <b>{$balance} sats{$balanceUsdSuffix}</b>
    *[other] Sender: @{$username}.

        Balance: <b>{$balance} sats{$balanceUsdSuffix}</b>
    }

wait-for-invoice = <b>🗳 Send or forward a message with a Lightning invoice to this chat.</b>
    .invalid = <b>⚠️ Invalid Lightning invoice. An invoice in the format</b> <i>lnbc1u1pn42...</i> <b>is expected.</b>

wait-for-invoice-review = <b>ℹ️ Invoice review</b>

        Amount: <b>{$amount} sats{$usdSuffix}</b>
        {$hasDescription ->
        [true] Description: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }{$fee -> 
        [no] <i></i>
        *[other] Fee: <b>{$fee} sats{$feeUsdSuffix}</b>
        <i></i>
        }Created: <b>{TGTIME($createdDate, format: "Dt")}</b>
        {$expiryDate ->
        [no] <i></i>
        *[other] Expires: <b>{TGTIME($expiryDate, format: "Dt")}</b>
        <i></i>
        }

        {$hasExpired ->
        [true] <b>⚠️ Invoice expired.</b>
        *[other] <i></i>
        }

        <blockquote expandable><code>{$invoice}</code></blockquote>

received-incoming-invoice = 📥 <b>You received payment for a Lightning invoice.</b>
        Amount: <b>{$amount} sats{$usdSuffix}</b>.
        {$hasDescription ->
        [true] Description: <b>{$description}</b>

            Balance: <b>{$balance} sats{$balanceUsdSuffix}</b>
        *[other] Balance: <b>{$balance} sats{$balanceUsdSuffix}</b>
        }

paying-invoice = <b>🧾 Paying Lightning invoice...</b>
    .paid = <b>✅ Invoice paid.</b>

        Payment amount: <b>{$amount} sats{$usdSuffix}</b>
        Fee: <b>{$fee} sats{$feeUsdSuffix}</b>
        Total: <b>{$total} sats{$totalUsdSuffix}</b>

creating-invoice = <b>🧾 Creating Lightning invoice...</b>
    .created = Amount: <b>{$amount} sats{$usdSuffix}</b>

        {$wallet ->
        [nwc] Wallet: <b>NWC</b>
        *[internal] Wallet: <b>{bot-name}</b>
        }

        {$hasDescription ->
        [true] Description: <b>{$description}</b>
        <i></i>
        *[other] <i></i>
        }Expires: <b>{TGTIME($expiresAt, format: "Dt")}</b>

        <blockquote expandable><code>{$invoice}</code></blockquote>

wait-for-memo = <b>🔡 Enter a memo for the invoice.</b>
    .invalid = <b>⚠️ Invalid memo. Expected string up to 150 characters.</b>

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
    This list is for configuring paid access on chats where the bot is already an admin.
    Add {bot-username} to a chat with invite and ban permissions to make it appear here.
    .empty = <b>👥 You don't have any chats with the ability to enable paid access.</b>
        Add {bot-username} to a chat with invite and ban permissions (button below), then open /chats again to configure paid access.

chat = <b>👥 {$title}</b>
    
    Paid access: <b>{$status ->
    [active] enabled
    *[other] disabled
    }</b>
    Price: <b>{$price} sats{$usdSuffix}</b>
    Payment type: <b>{$paymentType ->
    [one_time] one-time
    *[other] monthly
    }</b>
    On-chain pay: <b>{$onchain ->
    [on] enabled (fingerprint {$fingerprint})
    *[other] disabled
    }</b>

    <i>When changing the price or payment type, the price and payment type for existing subscribers will not change.</i>
    <i>On-chain payments go directly to your wallet (zpub/xpub). Access is usually granted soon after the transaction appears on the network.</i>
    <i>For paid access to work, the chat must require <b>admin approval for new members</b> (Approve New Members / invite link with join request). Then the bot can message applicants with an invoice and approve them after payment.</i>
    .not-found = <b>👥 Chat not found.</b>
        Add {bot-username} to a chat with invite and ban permissions to use this command.
    .custom-message = <b>💬 Join request message</b>
        Configure Russian and English independently. Each language falls back to its default text until you customize it.

        RU: <b>{$ruStatus}</b>
        EN: <b>{$enStatus}</b>
    .custom-message-status-custom = custom
    .custom-message-status-default = default
    .custom-message-preview = <b>👁 Preview · {$locale}</b>

        {$message}

changing-price = <b>₿ Changing the price of paid access...</b>
    .completed = <b>✅ The price of paid access has been set to {$price} sats{$usdSuffix}.</b>

enabling-onchain = <b>⛓ Enable on-chain payments</b>

    Paste an <b>account-level</b> public key from Sparrow / BlueWallet / Electrum (watch-only export):

    • <b>zpub</b> — recommended (Native SegWit, bc1q), path <code>m/84'/0'/0'</code>
    • <b>ypub</b> — Nested SegWit, <code>m/49'/0'/0'</code>
    • <b>xpub</b> — Legacy, <code>m/44'/0'/0'</code>
    • Or a full <b>output descriptor</b> from Sparrow (for custom paths)

    <i>Not the wallet root key (depth 0) — export the receive <b>account</b> xpub/zpub.</i>

    Funds go only to addresses from this key. {bot-name} never receives your seed.
    Paste another key or tap Cancel.
    .invalid = <b>⚠️ That does not look like a valid account key.</b>
        Paste a zpub / xpub / ypub (or descriptor). Check you copied the full string.
        You can try again or tap Cancel.
    .nonstandard-depth = <b>⚠️ This key is not an account-level xpub/zpub.</b>
        LNbits only accepts bare keys at BIP44/49/84 account depth (<code>m/…/0'</code>).

        In Sparrow: select the account → export <b>xpub</b> / <b>zpub</b> for that account, or export the <b>output descriptor</b>.
        You can paste another key or tap Cancel.
    .network-mismatch = <b>⚠️ Key network does not match this bot.</b>
        Use a Mainnet zpub/xpub on Mainnet, or Testnet <code>tpub</code>/<code>vpub</code> on Testnet.
        You can paste another key or tap Cancel.
    .failed = <b>⚠️ Could not enable on-chain payments.</b>
        Check the key and try again, or tap Cancel. If it still fails, contact support.
    .completed = <b>✅ On-chain pay enabled.</b>
        Fingerprint: <code>{$fingerprint}</code>
        Compare it with your wallet to confirm the correct account.

onchain-invoice =
    .created = <b>⛓ On-chain payment for "{$title}"</b>

        Send <b>at least {$price} sats{$usdSuffix}</b> to:

        <code>{$address}</code>

        Subscription type: <b>{$type ->
        [one_time] permanent access
        *[other] one month access
        }</b>

        <i>Any amount above {$price} sats{$usdSuffix} is a donation to the community owner.</i>

        {$remaining}
    .paid = <b>✅ Access to the community "{$title}" received.</b>

        {$type ->
        [one_time] <i></i>
        *[other] <i>Monthly access renews via Lightning from your {bot-name} balance when auto-renew is on.</i>
            <i>To get expiry reminders, open the bot and press /start.</i>
        }
    .disabled = On-chain pay is not available for this chat.
    .create-failed = Could not create an on-chain payment. Please try again later.
    .expired = <b>⚠️ This on-chain payment request has expired.</b>
        Tap <b>Pay on-chain</b> again (or send a new join request) for a fresh address.
    .grace = <b>⚠️ The time to pay this address has ended.</b>
        If you already sent the transaction, we still watch for a while and will grant access when it appears.
        Otherwise tap <b>Pay on-chain</b> again for a new address.

new-onchain-subscription-payment = <b>⛓ New on-chain subscription payment!</b>

    User <b>{$username}</b> paid on-chain for access to <b>"{$title}"</b>.

    Subscription type: <b>{$type ->
    [one_time] one-time (permanent access)
    *[other] monthly
    }</b>

    Amount: <b>{$price} sats{$usdSuffix}</b>
    Address: <code>{$address}</code>

    <i>Funds are already on your on-chain wallet (no Lightning fee split).</i>

subscription-invoice = 
    .default-message = <b>🔒 Access to private community "{$title}"</b>
    .choose-method = {$message}

    Price: <b>{$price} sats{$usdSuffix}</b>
    Subscription type: <b>{$type ->
    [one_time] permanent access
    *[other] one month access
    }</b>

    Choose a payment method:
    .created = {$message}

    Price: <b>{$price} sats{$usdSuffix}</b>
    Subscription type: <b>{$type ->
    [one_time] permanent access
    *[other] one month access
    }</b>

    <b>To get access to the community, pay the Lightning invoice:</b>
    <code>{$invoice}</code>

    <b>After successful payment, I will immediately grant you access to the community.</b>

    {$remaining}
    .insufficient-balance = ⚠️ Not enough balance to pay for access.
    .remaining-time = <i>The invoice expires <b>{TGTIME($expiresAt, format: "r")}</b>.</i>
    .paid = <b>✅ Access to the community "{$title}" received.</b>

    {$type ->
    [one_time] <i></i>
    *[other] <i>The subscription amount will be automatically debited from your {bot-name} wallet every month.</i>
        <i>To get expiry reminders and manage auto-renew, open the bot (/start) and use /subscriptions.</i>
    }
    .paid-from-balance = <b>✅ Payment completed.</b>
        Access to the community will be granted within 5 minutes.
    .duplicate-refunded = <b>↩️ A repeated subscription payment of {$price} sats{$usdSuffix} was credited to your ZapGram balance.</b>

        Access and the payment to the community owner were processed only once.
    .expired = <b>⚠️ This subscription invoice has expired.</b>
        Submit another request to join the chat to get a new invoice.

subscription-renewal = 
    .renewed = <b>✅ Your subscription to "{$title}" has been extended until {TGTIME($expiryDate, format: "D")}.</b>
        Payment amount: <b>{$price} sats{$usdSuffix}</b>
    .need-payment = <b>⚠️ Your subscription to "{$title}" expires in 24 hours. Pay the Lightning invoice for {$price} sats{$usdSuffix} to extend access for one month:</b>
        <code>{$invoice}</code>

new-subscription-payment = <b>₿ New subscription payment!</b>

    User <b>{$username}</b> has paid for access to the community <b>"{$title}"</b>.

    Subscription type: <b>{$type ->
    [one_time] one-time (permanent access)
    *[other] monthly
    }</b>
    
    Payment amount: <b>{$price} sats{$usdSuffix}</b>
    Fee: <b>{$fee} sats{$feeUsdSuffix}</b>
    Credited: <b>{$total} sats{$totalUsdSuffix}</b>

subscriptions = <b>👥 Your subscriptions to private chats.</b>
    .empty = <b>👥 You don't have any subscriptions.</b>


subscription = <b>👥 Subscription to chat "{$chatTitle}"</b>

    Price: <b>{$price} sats{$usdSuffix}</b>
    Valid until: <b>{$endsAt ->
        [no] permanent
        *[other] {TGTIME($endsAt, format: "Dt")}
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
    .completed = ✅ {$locale} custom message has been updated.
