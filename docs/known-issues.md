# Known issues

Confirmed defects that are not fixed yet. Each entry states how it was reproduced, so the fix can
start from a failing test.

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

Verified against the real container with HTTP fakes (throwaway e2e probe, not committed): with a
chat owned by user `100003`, a callback query from user `100001` carrying
`chat:<chatId>:on-paid` flipped `status` to `active`, returned the full chat card, and a following
`chat:<chatId>:change-price` opened the price conversation. No error, no log line.

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
already use, so a probe cannot distinguish "no such chat" from "not yours". Add the regression to
the chats e2e scenario: a stranger's callback must change nothing and must not reveal the title.
