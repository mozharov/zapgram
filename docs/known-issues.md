# Known issues

Confirmed defects that are not fixed yet. Each entry states how it was reproduced, so the fix can
start from a failing test.

## Tip receipts never show the sender

**Status:** fixed. **Found:** 2026-08-02, while writing the tipping e2e suite.
**Fixed:** 2026-08-03 — Fluent variants in `en.ftl`/`ru.ftl` use `[no]` for no-username and
`*[other]` for a real username; tipping e2e asserts `Sender: @user_a`.

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

## An expired subscription still approves a new join request

**Status:** fixed. **Found:** 2026-08-02, while writing the subscription-join e2e suite.
**Fixed:** 2026-08-03 — `findByUserAndChat` only returns permanent or `endsAt > now` rows; join e2e
expects a new invoice and no `approveChatJoinRequest` for an expired seed.

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

**Status:** fixed. **Found:** 2026-08-02, while writing the subscription-join e2e suite.
**Fixed:** 2026-08-03 — join invoice keyboard compares wallet/NWC balances in msats via
`satsToMsats(chat.price)`; e2e expects an empty keyboard for 999,500 msat.

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

**Status:** fixed. **Found:** 2026-08-02, while writing the subscription-join e2e suite.
**Fixed:** 2026-08-03 — join invoice `sendMessage` uses `chatJoinRequest.user_chat_id`; payment owner
and approve still use `user.id`; e2e requires `chat_id=100004` when it differs from the applicant.

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

## A failed join approval does not stop subscription settlement

**Status:** open. **Found:** 2026-08-02, while writing the subscription-settlement e2e suite.

`settle` (`src/modules/subscriptions/settle.service.ts`) grants the subscription and then calls
`approveChatJoinRequest`. Its local `.catch` only logs an error; settlement continues through both
payout legs, deletes the only `subscription_payments` retry row, and sends the subscriber the
`subscription-invoice.paid` message even though Telegram did not grant chat access.

### Reproduction

Verified against the real container with HTTP fakes in
`test/e2e/scenarios/subscriptions-settle.e2e.test.ts` ("an approval failure currently still pays
out and deletes the retry row"). The chat is already `no_access`, and Telegram is configured to
reject `approveChatJoinRequest` with a 400. The job still creates the subscription, transfers 950
sats to the owner and 50 sats to the fee wallet, removes the payment row, and tells the subscriber
that access was received. The approval failure is logged.

The forced rejection and all later effects are confirmed. How often Telegram rejects approval in
production, including after rights changes or a withdrawn join request, was not measured.

### How a user reaches it

The user pays while ZapGram can no longer approve the original request: the bot lost rights, the
chat became inaccessible, the request disappeared, or Telegram returned a transient error. Their
payment is finalized and cannot be retried by this job, but their membership was never approved.

### Fix sketch

Do not acknowledge access or delete the payment's retry state after a failed approval. Represent
access delivery as a retryable step alongside the already idempotent grant and payout hashes. A
permanent approval failure still needs bounded attempts and manual review, because the subscriber's
invoice has already been paid and silently dropping either the access or the money is unsafe.

## A pending fee payout is logged as an owner payout

**Status:** open. **Found:** 2026-08-02, while writing the subscription-settlement e2e suite.

`distributeOnce` (`src/modules/subscriptions/settle.service.ts`) returns only `{status: 'pending'}`;
it does not identify which payout leg is pending. Its caller therefore always logs "Owner payout is
still in flight" and attaches `payment.payoutHash`, even when the owner transfer is already paid and
the pending hash is `feePayoutHash`.

### Reproduction

Verified against the real container with HTTP fakes
(`test/e2e/scenarios/subscriptions-settle.e2e.test.ts`, "a pending fee leg is currently logged as an
owner payout"). The owner hash is settled and the fee hash is a master-wallet outgoing payment with
`paid=false`. The row is correctly kept without another transfer, but the emitted diagnostic names
the owner leg and records the already-paid owner hash instead of the pending fee hash.

### How an operator reaches it

Any fee transfer that remains pending at LNbits reaches this branch. The payment remains retryable,
so funds are not duplicated, but the log sends incident response to the wrong transfer and hash.

### Fix sketch

Return the pending leg and hash from `distributeOnce`, for example
`{status: 'pending', leg: 'fee', hash}`. Log those values in `settle` and keep the existing behavior
of retaining the row until a later lookup resolves the transfer.

## A failed auto-renewal creates a second manual payment

**Status:** open. **Found:** 2026-08-02, while writing the subscription-renewal e2e suite.

`attemptAutoRenewal` (`src/modules/subscriptions/renewal.service.ts`) creates a master-wallet
invoice and persists its `subscription_payments` row before charging the subscriber. When that
charge fails, the row is intentionally retained, but `processExpiringSubscriptions` then calls
`createAndSendRenewalInvoice`, which creates another invoice and another row for the same renewal.

### Reproduction

Verified against the real container with HTTP fakes in
`test/e2e/scenarios/subscriptions-renewal.e2e.test.ts` ("an insufficient balance currently leaves
two renewal payments for one reminder"). An expiring 1,000-sat subscription and an empty subscriber
wallet produce two distinct unpaid master-wallet invoices and two `kind='renewal'` rows. Only the
second payment request appears in the single Telegram reminder and its wallet button. No balance
moves, and the subscription is marked `notificationSent=true`.

The duplicate unpaid state is confirmed. A lost response after an actually successful charge was
not simulated, so the more dangerous double-charge outcome remains a risk rather than a measured
result.

### How a user reaches it

Any automatic balance charge that fails while the subscription is inside its 24-hour renewal window
reaches this path, including ordinary insufficient balance. The subscriber sees one manual invoice;
the first row remains hidden from that UI until the settlement or expiry job resolves it.

### Fix sketch

Return the already-created payment from `attemptAutoRenewal` and reuse its `paymentRequest` for the
manual reminder instead of minting a second invoice. An ambiguous charge error must first be checked
by payment hash; do not offer another payable invoice while the first charge may have succeeded.

## Manual renewal invoices use the current chat price instead of the subscription price

**Status:** open. **Found:** 2026-08-02, while writing the subscription-renewal e2e suite.

`createAndSendRenewalInvoice` mints its BOLT11 with `chat.price`, but stores
`subscription.price` in the payment row and renders that saved subscription price in the caption.
Settlement also distributes `payment.price`, so the invoice amount and the accounting amount can
diverge as soon as the owner changes the chat price for future subscribers.

### Reproduction

Verified against the real container with HTTP fakes in
`test/e2e/scenarios/subscriptions-renewal.e2e.test.ts` ("a manual renewal invoice currently uses the
changed chat price instead of its saved price"). A subscription saved at 1,000 sats with a chat now
priced at 2,000 sats produces a real decoded BOLT11 for 2,000 sats. Its payment row still says
1,000, and the Telegram caption asks for 1,000. No payment was made in this characterization test,
so the later balance residue and payout consequences were not measured.

### How a user reaches it

The chat owner changes the price after somebody has subscribed, and that subscriber later needs a
manual renewal invoice. The UI promises that existing subscribers retain their price, but the
Lightning invoice requests the current chat price instead.

### Fix sketch

Pass `subscription.price` to `masterWallet.createInvoice`, matching the row, caption and eventual
payout. Keep `chat.price` only for new subscriptions.

## A failed renewal reminder is marked as sent

**Status:** open. **Found:** 2026-08-02, while writing the subscription-renewal e2e suite.

`createAndSendRenewalInvoice` catches its own failures and returns no outcome. The Telegram notifier
also logs and swallows `sendPhoto` failures. `processExpiringSubscriptions` therefore always writes
`notificationSent=true` after the call, even when no usable reminder reached the subscriber.

### Reproduction

Two permanent E2E characterizations in
`test/e2e/scenarios/subscriptions-renewal.e2e.test.ts` cover both sides:

- a forced LNbits 503 while minting leaves no payment row and sends nothing, but still marks the
  subscription notified;
- a forced Telegram 400 leaves one unpaid payment row and records the rejected `sendPhoto`, then
  also marks the subscription notified.

In both cases the next job run is a no-op because the query excludes notified rows. The exact error
is logged; the missing retry is confirmed.

### How a user reaches it

A transient LNbits, QR-generation or Telegram delivery failure happens during the only reminder
inside the 24-hour window. QR generation was not failed separately, but it is inside the same caught
block. The subscriber receives no payable reminder and automatic retry is disabled.

### Fix sketch

Make reminder creation return a success result and expose Telegram delivery failure to its caller.
Set `notificationSent=true` only after the invoice and photo are both delivered; otherwise retain
the row in the job query for a bounded retry.

## Expiry cleanup deletes the subscription even when ban or unban fails

**Status:** open. **Found:** 2026-08-02, while writing the subscription-renewal e2e suite.

`checkExpiredSubscriptions`
(`src/modules/subscriptions/jobs/check-expired-subscriptions.ts`) catches errors from both
`banChatMember` and `unbanChatMember`, then always deletes the subscription row. Either Telegram
failure therefore leaves the bot with no row to retry, and membership in the paid chat can diverge
from the database:

- **Ban fails:** the former subscriber may still be in the chat, but the subscription is gone — free
  access with nothing left for a later kick.
- **Unban fails after a successful ban:** the user may remain banned with no local row to retry the
  unban that would let them request access again.

### Reproduction

Verified against the real container with the Telegram HTTP fake in
`test/e2e/scenarios/subscriptions-renewal.e2e.test.ts`:

- "a failed ban currently still deletes the expired row" — `banChatMember` returns 400; the job
  still calls `unbanChatMember`, logs the ban error, and deletes the subscription.
- "a failed unban currently deletes the only expiry retry state" — ban succeeds, unban returns 403;
  the job logs the unban failure, deletes the subscription, and makes no Telegram call on the next
  run.

The HTTP calls and lost database retry state are confirmed. The fake does not model Telegram
membership, so “still in the chat” / “still banned” are inferred from the
[Bot API contract](https://core.telegram.org/bots/api#unbanchatmember), not observed as chat state
in the test.

### How a user reaches it

Any transient Telegram error or missing bot right during the expiry tick. Ban failure is the quieter
path (subscriber keeps reading the paid chat); unban failure is the louder one (they cannot rejoin).

### Fix sketch

Delete the subscription only after both ban and unban succeed. On either failure, keep the row and
return the batch verdict that advances safely while preserving it for a later retry; add bounded
attempts and an operator alert for persistent permission failures.

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

## Disconnect NWC still shows the NWC balance on the same reply

**Status:** open. **Found:** 2026-08-02, while writing the NWC e2e suite.

`disconnectNwcCallback` (`src/modules/wallet/telegram/handlers/disconnect-nwc.ts`) writes
`nwcUrl: null` and `nwcTips: false` to the database, then calls `replyWithWallet(ctx)`. Wallet
rendering reads NWC from `ctx.user.nwc` (`src/modules/wallet/telegram/messages/wallet.ts`), which
`attachUser` built at the start of the request from the still-connected row. The handler never
clears that in-memory field, so the “Wallet disconnected” confirmation is immediately followed by a
wallet screen that still lists `<b>NWC:</b> … sats`.

The database is correct. The next update rebuilds the context without NWC and shows the single
`Balance:` line. Only the same-request reply is wrong.

### Reproduction

Verified against the real container with HTTP fakes (`test/e2e/scenarios/nwc.e2e.test.ts`,
"disconnecting NWC clears nwc_url and nwc_tips"): after `disconnect-nwc`, the user row has
`nwcUrl: null` and `nwcTips: false`, but the third Telegram call of that update is a wallet message
matching `/<b>NWC:<\/b>/`. The following `/wallet` then matches `/<b>Balance:<\/b>/` and has no NWC
line.

### How a user reaches it

Settings → *Disconnect the NWC wallet*. They see “Wallet disconnected from ZapGram” and, under it, a
wallet that still claims an NWC balance until they open the wallet again.

### Fix sketch

After the repository update, drop the live wallet from the context before rendering:

```ts
await updateUser(ctx.user.id, {nwcUrl: null, nwcTips: false})
ctx.user.nwcUrl = null
ctx.user.nwcTips = false
ctx.user.nwc = undefined
```

The e2e case above is the regression: the same-request wallet reply should match the single-balance
copy, and the extra “next `/wallet`” step becomes redundant.
