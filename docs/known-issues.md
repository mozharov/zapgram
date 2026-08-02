# Known issues

Confirmed defects that are not fixed yet. Each entry states how it was reproduced, so the fix can
start from a failing test.

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
