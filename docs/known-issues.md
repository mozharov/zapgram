# Known issues

Confirmed defects that are not fixed yet. Each entry states how it was reproduced, so the fix can
start from a failing test.

## Tip receipts never show the sender

**Status:** open. **Found:** 2026-08-02, while writing the tipping e2e suite.

`notifySatsReceived` (`src/modules/tipping/notify-sats-received.ts`) passes the sender's username as
the Fluent variable `username`. Both locale files branch on that value using variants `[true]` and
`[no]`. An actual username such as `user_a` matches neither named variant, so Fluent chooses the
default `[no]` branch and drops the `Sender: @user_a` line.

### Reproduction

Verified against the real container with HTTP fakes
(`test/e2e/scenarios/tipping.e2e.test.ts`, the private-send and `/tip 21 @user_b` scenarios): both
paths call `notifySatsReceived(..., 'user_a')`, but the recipient only gets the amount and balance.
The outgoing text contains no sender line. The transfer and both wallet balances are otherwise
correct.

### How a user reaches it

Every successful tip from a user who has a Telegram username reaches it, both through `/tip` in a
group and through the private send-to-user conversation. The recipient sees that sats arrived but
cannot tell who sent them. Senders without a username intentionally use the same no-sender copy and
are unaffected.

### Fix sketch

In both `en.ftl` and `ru.ftl`, make `[no]` the explicit no-username variant and use `*[other]` for
the branch that renders `@{$username}`. Keep `notifySatsReceived` passing the actual username: the
copy needs the value as well as the presence check. The two e2e assertions that currently pin the
missing sender then become the regression by expecting the sender line.

## A repeated join request issues a second subscription invoice

**Status:** open. **Found:** 2026-08-02, while writing the input-coverage e2e suite.

`chatJoinRequestHandler` (`src/modules/subscriptions/telegram/handlers/chat-join-request.ts`) only
checks for an existing *subscription* before issuing an invoice. It never looks for an in-flight
`subscription_payments` row, so every join request mints a fresh master-wallet invoice and inserts
another payment row for the same `(userId, chatId)`.

Settlement is guarded per row, not per subscriber: `grantSubscriptionAccessIfNeeded`
(`src/core/subscriptions/grant.ts`) skips only when *that row's* `settledAt` is set. Two paid rows
therefore settle twice — the subscriber is debited twice and the chat owner is paid out twice,
which for a `one_time` chat buys the subscriber nothing the first payment did not already give.

### Reproduction

Verified against the real container with HTTP fakes (`test/e2e/scenarios/input.e2e.test.ts`, "a
redelivered join request issues a second invoice for the same chat"): sending the identical
`chat_join_request` update twice leaves two `subscription_payments` rows with two distinct payment
hashes, two unpaid master-wallet invoices, and two invoice messages to the user. No error is logged.

### How a user reaches it

Two ways, neither of which needs anything unusual:

- Telegram redelivers an update it did not get a `200` for — a dropped connection or a restart
  mid-request is enough. Nothing between the webhook and the handler remembers `update_id`.
- The user cancels their join request in the client and requests again, which is a second genuine
  `chat_join_request`. Both invoices stay payable for a day (`EXPIRY`).

Whether a real subscriber would pay both invoices rather than one was not established — the
duplicate row itself is confirmed, the double debit follows from the per-row settle guard.

### Fix sketch

The repository already has the lookup this needs: `getPendingForSubscription(userId, chatId)`, used
by auto-renewal for exactly this reason. Before creating the invoice, reuse a pending row that has
not expired — resend its `paymentRequest` instead of minting a new one — and only create a payment
when there is none. The e2e case above then flips from "a second invoice" to "the same invoice".

## An expired subscription still approves a new join request

**Status:** open. **Found:** 2026-08-02, while writing the subscription-join e2e suite.

`chatJoinRequestHandler` (`src/modules/subscriptions/telegram/handlers/chat-join-request.ts`) treats
any row returned by `findByUserAndChat` as active. That repository lookup
(`src/modules/subscriptions/repository.ts`) filters only by `(userId, chatId)` and never checks
`endsAt`, so a monthly subscription whose end time is already in the past takes the same immediate
approval path as a permanent or current subscription.

### Reproduction

Verified against the real container with HTTP fakes
(`test/e2e/scenarios/subscriptions-join.e2e.test.ts`, "an expired subscription is currently approved
before cleanup runs"): an active monthly chat and a subscription ending one minute in the past
produce one `approveChatJoinRequest` call with the exact chat and user IDs. No invoice or
`subscription_payments` row is created and no wallet balance moves.

### How a user reaches it

`check-expired-subscriptions` runs when the scheduler starts and then hourly. Between `endsAt` and
the next run, a former subscriber who submits another join request is admitted without paying
again. A delayed or failing cleanup extends that window.

### Fix sketch

Make the lookup used by the join handler mean *current* subscription: permanent rows
(`endsAt IS NULL`) or rows with `endsAt > now`. Keep the cleanup job responsible for banning and
deleting expired rows, but do not let its schedule define authorization. The committed
characterization test then becomes the regression by expecting a new join invoice and no approval.

## A rounded balance can expose an unusable subscription payment button

**Status:** open. **Found:** 2026-08-02, while writing the subscription-join e2e suite.

`replyWithSubscriptionInvoice` (`src/modules/subscriptions/telegram/handlers/chat-join-request.ts`)
converts the user's millisatoshi balance with `msatsToSats` before checking it against the integer
chat price. `msatsToSats` (`src/core/money/sats.ts`) uses `Math.round`, so a balance half a satoshi
below the price rounds up and is presented as sufficient even though the wallet cannot fund the
invoice.

### Reproduction

Verified against the real container with HTTP fakes
(`test/e2e/scenarios/subscriptions-join.e2e.test.ts`, "a rounded-up insufficient balance currently
offers the wallet button"): a 1,000-sat chat with a 999,500-msat wallet produces the exact
`pay-sub:<paymentId>:wallet` button. The saved and decoded BOLT11 is for 1,000,000 msat, while the
wallet remains 500 msat short. The displayed button is confirmed; rejection after selecting it is
inferred from those exact amounts and is not exercised by this join scenario.

### How a user reaches it

Any internal wallet balance in the final half-satoshi below a chat's integer price reaches this
branch. The join message offers payment from the ZapGram balance even though that balance is
smaller than the invoice amount.

### Fix sketch

Compare like units without rounding:
`ctx.user.wallet.balance >= satsToMsats(chat.price)`. Keep `msatsToSats` for display-only values.
After the fix, the committed characterization test should expect an empty keyboard for 999,500
msat and retain the exact-price test as the positive boundary.

## Join invoices ignore the request's private-chat identifier

**Status:** open. **Found:** 2026-08-02, while writing the subscription-join e2e suite.

The Telegram Bot API gives every `ChatJoinRequest` a `user_chat_id`: the identifier the bot may use
to contact the applicant during the short join-request window. In
`src/modules/subscriptions/telegram/handlers/chat-join-request.ts`,
`replyWithSubscriptionInvoice` ignores that field and sends the invoice to `ctx.user.id` instead.
The API defines `from.id` as a user identifier and `user_chat_id` as a private-chat identifier; it
does not make their equality part of the contract.

### Reproduction

Verified against the real container with HTTP fakes
(`test/e2e/scenarios/subscriptions-join.e2e.test.ts`,
"the invoice currently ignores the join request private-chat id"): a valid `chat_join_request` with
applicant ID `100001` and `user_chat_id` `100004` produces `sendMessage(chat_id=100001)`. The
dedicated private-chat ID is never read. The payment row and invoice are otherwise correct.

The field's purpose and five-minute contact window are documented in the
[Telegram Bot API `ChatJoinRequest` contract](https://core.telegram.org/bots/api#chatjoinrequest).
The contract defect is confirmed by the payload above; how often production Telegram currently
emits numerically different IDs was not measured.

### How a user reaches it

An applicant who has not already opened the bot's private chat depends on the temporary contact
route attached to their join request. If its chat ID differs from the user ID, ZapGram addresses the
invoice to the wrong peer. Telegram may reject that target; if it does, the caught failure is logged
and the payment remains while the applicant receives no invoice.

### Fix sketch

Pass `ctx.chatJoinRequest.user_chat_id` as the first argument to `sendMessage`; keep `ctx.user.id`
for the database payment owner and for `approveChatJoinRequest`, whose API explicitly expects a
user ID. Update the shared invoice assertion and characterization test to require
`chat_id=100004`.

## Chat settings callbacks do not check ownership

**Status:** open. **Found:** 2026-08-02, while writing the routing e2e suite.

Every chat-settings handler resolves the chat with `getAccessibleChat(id)`
(`src/modules/chats/repository.ts`), which filters only on `status != 'no_access'`. None of them
compares `chat.ownerId` with `ctx.user.id`:

- `chat-callback.ts` — reads the chat card
- `turn-paid-access.ts` — writes `status`
- `turn-payment-type.ts` — writes `paymentType`
- `change-price.ts` — enters the price conversation, which writes `price`
- `custom-message.ts`, `edit-custom-message.ts`, `remove-custom-message.ts` — read and write the
  join message shown to subscribers

Only the chat *list* (`chats-callback.ts` → `getPaginatedAccessible`) is scoped by owner, so the
list never shows a foreign chat — but nothing stops a handler from acting on one.

### Reproduction

Permanently covered against the real container with HTTP fakes by
`test/e2e/scenarios/chats.e2e.test.ts` ("a different user can currently enable paid access for
someone else's chat"). With a chat owned by user `100003`, a callback query from user `100001`
carrying `chat:<chatId>:on-paid` changes `status` to `active` and returns an edited card containing
the foreign chat's title. The test asserts the exact row change and Telegram call; no error is
logged. It is a characterization of the open defect, not the desired behavior.

The original throwaway probe also verified that a following `chat:<chatId>:change-price` opens the
price conversation for the same non-owner. That broader write path is verified but does not yet
have its own committed scenario.

### How a user reaches it without forging callback_data

The webhook secret makes fabricated updates a non-issue, and the official client only sends buttons
it actually received. This still has a path that needs neither:

`handleRightsGrant()` in `my-chat-member.ts` sets `ownerId` to the *current chat creator* every time
the bot is granted rights. When a group's ownership is transferred, the next rights grant reassigns
`ownerId` to the new creator — but the previous owner still has the old settings message in their
private chat with the bot, and its buttons keep working. An ex-owner can therefore keep switching
paid access, changing the price and rewriting the join message of a chat that is no longer theirs.

(Whether Telegram validates the `data` field of a callback query against the message's actual
keyboard was not established either way — the path above does not depend on it.)

### Fix sketch

Give the chats module an owner-scoped lookup (`findAccessibleByIdAndOwner(id, ownerId)`) and use it
in all seven handlers, answering `chat.not-found` when it misses — the same copy the handlers
already use, so a probe cannot distinguish "no such chat" from "not yours". Flip the committed
characterization scenario after the fix: a stranger's callback must change nothing, must return the
generic not-found card, and must not reveal the title.

## The error handler repeats the read that just failed

**Status:** open. **Found:** 2026-08-02, while writing the wallet e2e suite.

After any error in a private chat, `errorHandler` (`src/telegram/handlers/error.ts`) sends the error
copy and then appends the wallet screen. `replyWithWallet`
(`src/modules/wallet/telegram/messages/wallet.ts`) reads the balance live — `GET /api/v1/wallet` —
so when the error *was* a failed balance read, the handler immediately repeats it. `got` retries a
failed GET twice with backoff, and nothing about the second round is visible to the user: the reply
fails too and only the error copy is delivered.

This is not wrong output — the user gets the right message — but it doubles the latency and the
load on a service that is already failing.

### Reproduction

Measured against the real container with HTTP fakes (`test/e2e/scenarios/wallet.e2e.test.ts`, "a
balance endpoint that stays down leaves the user with an error and the world untouched"): with
`GET /api/v1/wallet` failing persistently, one `/wallet` command produces **8** requests to LNbits —
2 to resolve the wallet, then 3 + 3 for the two balance reads — and takes ~6.3 s before the user
sees a single message. Four `level=error` lines are logged, the last being
`Failed to reply with wallet in error handler`.

Measured for `/wallet`. That the same cost applies to *every* private-chat error during an LNbits
outage follows from the error handler being shared, and was not measured separately.

### Fix sketch

`editMessageWithWallet` already renders from `ctx.user.wallet.balance`, which the `lnbitsWallet`
middleware loaded moments earlier. Give the error handler the same non-fetching path instead of
`replyWithWallet`, and have it tolerate a missing `ctx.user.wallet` — when the failure happened in
the middleware itself there is no wallet on the context at all, which is what the last error line
above is. Fixing this also removes the slowest test in the e2e suite.

## Whether a command interrupts a conversation depends on registration order

**Status:** open. **Found:** 2026-08-02, while writing the invoices/conversations e2e suite.

A waiting conversation only sees an update if the conversation's `createConversation(...)` sits
above the handler that would otherwise take it. Each module registers its own conversations
(`modules/*/register.ts`) at the point in `registerHandlers` where the module is composed
(`src/telegram/composition.ts`), so the six conversations end up scattered through the chain and
each one interrupts a different set of commands:

| conversation | registered in | commands above it (so they bypass it) |
|---|---|---|
| `connectingNWC` | wallet, before its own commands | `/start`, `/help` |
| `sendingToUser` | tipping | + `/wallet`, `/settings` |
| `payingInvoice`, `creatingInvoice` | invoices | + `/wallet`, `/settings` |
| `changingPrice`, `editCustomMessage` | chats | + `/chats` and every chat callback |

A bypassed conversation is not ended — it stays in `conversations` waiting for the same answer, and
claims the *next* message instead.

### Reproduction

Verified against the real container with HTTP fakes (`test/e2e/scenarios/invoices.e2e.test.ts`,
"a command registered before the conversation answers without ending it" and "the same command
cancels a conversation that was registered before it"):

- with `creatingInvoice` waiting for an amount, `/wallet` renders the wallet screen, sends nothing
  else and leaves the `conversations` row byte-identical. The following `/chats` is then read as the
  amount: the user gets `⚠️ Invalid amount of sats`, `❌ Action canceled` and only then their chat
  list.
- with `connectingNWC` waiting for a URL, the identical `/wallet` is consumed by the conversation
  instead: `⚠️ Invalid NWC URL`, `❌ Action canceled`, wallet screen.

A `help` callback behaves the same way as `/wallet` in the first case and was measured too.

### How a user reaches it

Tapping ⚡️ *Create invoice*, deciding against it, and typing any command other than one the active
conversation happens to sit above. Nothing unusual is required and no error is logged.

### Fix sketch

Make the rule uniform rather than incidental: install all six `createConversation(...)` in
`registerHandlers` immediately after the `conversations` middleware, before any command or callback
handler, and delete them from the module `register.ts` files. Every command then reaches the active
conversation and cancels it — the `connectingNWC` behaviour above, which is the one users can
already rely on today.

The trade-off is that `/start` and `/help` start cancelling conversations too. If that is not
wanted, the alternative is the opposite rule — a `filter` in front of the conversation plugin that
lets `bot_command` messages through untouched — but then the abandoned conversation survives on
purpose and needs its own expiry, which nothing implements today.

Either way the two e2e cases above are the regression: they currently pin the asymmetry, so a fix
has to rewrite them into one shared expectation.
