import {afterEach, beforeEach, expect, test} from 'bun:test'
import {usersTable} from '@infra/db/schema.js'
import {staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {
  groupEphemeralCommand,
  groupReply,
  groupReplyToChannel,
  groupText,
  groupTextAsAnonymousAdmin,
  groupTextAsChannel,
  privateCallback,
  privateText,
  type TestUpdate,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {
  expectDelta,
  expectLedgerBalanced,
  snapshot,
  type TelegramCallExpectation,
} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.tipping

/**
 * Internal tips, whether they start in a group or in the private send conversation.
 *
 * A successful tip is one paid invoice on the recipient's wallet and one matching outgoing
 * payment on the sender's wallet. The assertions below name every balance and Bot API call so a
 * friendly confirmation cannot hide a missing transfer, a wrong recipient, or a duplicate payout.
 *
 * A connected NWC wallet takes a different route and is deliberately not represented here.
 */

const TIP_SATS = 21
const STARTING_BALANCE_SATS = 1000
const CHAT_OWNER = 777

type TelegramExpectation = TelegramCallExpectation

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Private send conversation ---

test('the private send conversation transfers sats and closes after the amount', async () => {
  await seedSenderAndRecipient()
  e2e.tg.reply('getChat', {
    id: USER_B,
    type: 'private',
    username: 'user_b',
    first_name: 'User B',
  })
  await e2e.send(privateCallback(staticCallback.sendToUser))
  const usernameInput = privateText('@user_b')
  const usernameMessageId = usernameInput.message?.message_id
  if (usernameMessageId === undefined) throw new Error('Expected the username input message')
  const telegramMark = e2e.tg.calls.length
  await e2e.send(usernameInput)

  expect(e2e.tg.last('getChat')?.chat_id).toBe(USER_B)
  // The accepted @username is echoed into every later screen, so the typed message is noise.
  const deletedSingle = e2e.tg.calls
    .slice(telegramMark)
    .filter(call => call.method === 'deleteMessage')
    .map(call => Number(call.payload.message_id))
  expect(deletedSingle).toContain(usernameMessageId)

  await expectInternalTransfer(
    () => e2e.send(privateText(String(TIP_SATS))),
    USER_B,
    '100002 wallet',
    [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
      {method: 'editMessageText', to: USER_A, text: /You sent 21 sats(?: \(\$[^)]+\))? to @user_b/},
    ],
    {conversationRemoved: true},
  )

  // The wizard's own screen becomes the report and keeps a self-disappearing "Open wallet" button
  // rather than sending the wallet screen straight away.
  expect(e2e.tg.last('editMessageText')?.reply_markup).toEqual({
    inline_keyboard: [[{text: '👛 Open wallet', callback_data: staticCallback.openMenu}]],
  })

  expect(notificationTo(USER_B)).toContain('Sender: @user_a')
  expect(notificationTo(USER_B)).toMatch(/Balance: <b>21 sats(?: \(\$[^)]+\))?<\/b>/)
})

test('an invalid private-send amount can be corrected without restarting the flow', async () => {
  await seedSenderAndRecipient()
  e2e.tg.reply('getChat', {
    id: USER_B,
    type: 'private',
    username: 'user_b',
    first_name: 'User B',
  })
  await e2e.send(privateCallback(staticCallback.sendToUser))
  await e2e.send(privateText('@user_b'))

  const invalidInput = privateText('not-a-number')
  const invalidMessageId = invalidInput.message?.message_id
  if (invalidMessageId === undefined) throw new Error('Expected the invalid tip input message')
  await expectDelta(e2e, () => e2e.send(invalidInput), {
    db: {conversations: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/}],
  })

  const correctedInput = privateText(String(TIP_SATS))
  const telegramMark = e2e.tg.calls.length
  await expectInternalTransfer(
    () => e2e.send(correctedInput),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessages', to: USER_A},
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
      {method: 'editMessageText', to: USER_A, text: /You sent 21 sats(?: \(\$[^)]+\))? to @user_b/},
    ],
    {conversationRemoved: true},
  )
  expect(deletedMessageIdsSince(telegramMark)).toContain(invalidMessageId)
  expectNoErrors(e2e.logs)
})

// --- Group recipient resolution ---

test('/tip with an amount and username pays that stored user', async () => {
  await seedSenderAndRecipient()

  await expectInternalTransfer(
    () => e2e.send(groupText('/tip 21 @user_b')),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  )

  expect(notificationTo(USER_B)).toContain('Sender: @user_a')
  expect(notificationTo(USER_B)).toMatch(/Balance: <b>21 sats(?: \(\$[^)]+\))?<\/b>/)
})

// Clients append the bot username as soon as a group holds more than one bot.
test('/tip@this_bot pays exactly like a bare /tip', async () => {
  await seedSenderAndRecipient()

  await expectInternalTransfer(
    () => e2e.send(groupText('/tip@zap_gram_bot 21 @user_b')),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  )
})

test('a mention of this bot pays like /tip, an unrelated mention is ignored', async () => {
  await seedSenderAndRecipient()

  await expectInternalTransfer(
    () => e2e.send(groupText('@zap_gram_bot 21 @user_b')),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  )

  await expectDelta(e2e, () => e2e.send(groupText('@user_b 21 @user_a')), {telegram: []})
})

test('/tip addressed to another bot is left to that bot', async () => {
  await seedSenderAndRecipient()

  await expectDelta(e2e, () => e2e.send(groupText('/tip@other_bot 21 @user_b')), {telegram: []})
  expectNoErrors(e2e.logs)
})

test('replying to a user provisions their wallet and pays them', async () => {
  await seedSender()
  const update = groupReply(
    `/tip ${TIP_SATS}`,
    {text: 'A useful message', from: {id: USER_B, username: 'user_b', first_name: 'User B'}},
    {from: {id: USER_A, username: 'user_a'}},
  )

  await expectInternalTransfer(
    () => e2e.send(update),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
    {recipientAdded: true},
  )

  expect(groupConfirmation()?.reply_parameters).toEqual({
    message_id: update.message?.reply_to_message?.message_id,
  })
  expect(e2e.tg.last('sendMessage')?.chat_id).toBe(USER_B)
})

test('replying to a channel post pays the channel creator', async () => {
  await seedSender()
  const update = groupReplyToChannel(`/tip ${TIP_SATS}`, {
    from: {id: USER_A, username: 'user_a'},
  })

  await expectInternalTransfer(
    () => e2e.send(update),
    CHAT_OWNER,
    '777 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'getChatAdministrators'},
      {method: 'sendMessage', to: CHAT_GROUP, text: /author of this message/},
      {method: 'sendMessage', to: CHAT_OWNER, text: /You received 21 sats/},
    ],
    {recipientAdded: true},
  )

  expect(e2e.tg.last('getChatAdministrators')?.chat_id).toBe(CHAT_CHANNEL)
  expect(groupConfirmation()?.reply_parameters).toEqual({
    message_id: update.message?.reply_to_message?.message_id,
  })
})

test('/tip without arguments sends the default 21 sats to the group creator', async () => {
  await seedSender()

  await expectInternalTransfer(
    () => e2e.send(groupText('/tip', {from: {id: USER_A, username: 'user_a'}})),
    CHAT_OWNER,
    '777 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'getChatAdministrators'},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to the owner of this group/},
      {method: 'sendMessage', to: CHAT_OWNER, text: /You received 21 sats/},
    ],
    {recipientAdded: true},
  )
})

test('a mixed-case username resolves to the normalized stored username', async () => {
  await seedSenderAndRecipient()

  await expectInternalTransfer(
    () => e2e.send(groupText('/tip 21 @UsEr_B')),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  )
})

// --- Non-identifiable senders (cannot debit a real wallet) ---

test('send-as channel tip is refused with a public temp message (no money moves)', async () => {
  await seedSenderAndRecipient()
  const beforeUsers = await e2e.db.select().from(usersTable)

  await expectDelta(e2e, () => sendAndWaitForTempMessage(groupTextAsChannel('/tip 21 @user_b')), {
    telegram: [
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: null,
        text: /bot, channel, group, or anonymous profile/,
      },
      {method: 'deleteMessages', to: CHAT_GROUP},
    ],
  })

  // No fake channel-identity user row; existing users unchanged.
  expect(await e2e.db.select().from(usersTable)).toEqual(beforeUsers)
  expect(errorMessages()).toEqual(['Bot error'])
})

test('anonymous admin tip is refused with a public temp message (no money moves)', async () => {
  await seedSenderAndRecipient()

  await expectDelta(
    e2e,
    () => sendAndWaitForTempMessage(groupTextAsAnonymousAdmin('/tip 21 @user_b')),
    {
      telegram: [
        {
          method: 'sendMessage',
          to: CHAT_GROUP,
          receiverUserId: null,
          text: /bot, channel, group, or anonymous profile/,
        },
        {method: 'deleteMessages', to: CHAT_GROUP},
      ],
    },
  )

  expect(errorMessages()).toEqual(['Bot error'])
})

// --- Refused tips ---

test('a tip to the sender is refused without moving money', async () => {
  await seedSender()

  await expectRefusedTip(groupText('/tip 21 @user_a'), /can't send sats to yourself/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {
      method: 'sendMessage',
      to: CHAT_GROUP,
      receiverUserId: USER_A,
      text: /can't send sats to yourself/,
    },
  ])
})

const botRecipients = [
  {label: 'a bot message', id: 200001, isBot: true},
  {label: 'a Telegram service message', id: 777000, isBot: false},
] as const

for (const recipient of botRecipients) {
  test(`a reply to ${recipient.label} is refused without moving money`, async () => {
    await seedSender()
    const update = groupReply(
      `/tip ${TIP_SATS}`,
      {
        text: 'Automated message',
        from: {
          id: recipient.id,
          is_bot: recipient.isBot,
          username: 'automated_account',
          first_name: 'Automated account',
        },
      },
      {from: {id: USER_A, username: 'user_a'}},
    )

    await expectRefusedTip(update, /can't send sats to bots/, [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: USER_A,
        text: /can't send sats to bots/,
      },
    ])
  })
}

// Platform bot (this bot) tips route to ADMIN_TELEGRAM_IDS[0] — separate E2E world with admins set.
test('replying to this bot pays the configured admin wallet', async () => {
  await e2e.dispose()
  e2e = await createE2E({env: {ADMIN_TELEGRAM_IDS: String(OWNER)}})
  await seedSender()
  const update = groupReply(
    `/tip ${TIP_SATS}`,
    {
      text: 'ZapGram says hi',
      from: {
        id: 1,
        is_bot: true,
        username: 'zap_gram_bot',
        first_name: 'ZapGram',
      },
    },
    {from: {id: USER_A, username: 'user_a'}},
  )

  await expectInternalTransfer(
    () => e2e.send(update),
    OWNER,
    `${OWNER} wallet`,
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @zap_gram_bot/},
      {method: 'sendMessage', to: OWNER, text: /You received 21 sats/},
    ],
    {recipientAdded: true},
  )
})

test('/tip @zap_gram_bot pays the configured admin wallet', async () => {
  await e2e.dispose()
  e2e = await createE2E({env: {ADMIN_TELEGRAM_IDS: String(OWNER)}})
  await seedSender()

  await expectInternalTransfer(
    () => e2e.send(groupText('/tip 21 @zap_gram_bot', {from: {id: USER_A, username: 'user_a'}})),
    OWNER,
    `${OWNER} wallet`,
    [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @zap_gram_bot/},
      {method: 'sendMessage', to: OWNER, text: /You received 21 sats/},
    ],
    {recipientAdded: true},
  )
})

test('replying to this bot without ADMIN_TELEGRAM_IDS is refused', async () => {
  await seedSender()
  const update = groupReply(
    `/tip ${TIP_SATS}`,
    {
      text: 'ZapGram says hi',
      from: {
        id: 1,
        is_bot: true,
        username: 'zap_gram_bot',
        first_name: 'ZapGram',
      },
    },
    {from: {id: USER_A, username: 'user_a'}},
  )

  await expectRefusedTip(update, /can't send sats to bots/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {
      method: 'sendMessage',
      to: CHAT_GROUP,
      receiverUserId: USER_A,
      text: /can't send sats to bots/,
    },
  ])
})

test('an unknown username is refused without creating a wallet', async () => {
  await seedSender()

  await expectRefusedTip(groupText('/tip 21 @missing_user'), /doesn't have a ZapGram wallet/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {
      method: 'sendMessage',
      to: CHAT_GROUP,
      receiverUserId: USER_A,
      text: /doesn't have a ZapGram wallet/,
    },
  ])
})

test('a group with no discoverable creator reports that no recipient was specified', async () => {
  await seedSender()
  e2e.tg.reply('getChatAdministrators', [])

  await expectRefusedTip(groupText('/tip'), /recipient is not specified/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'getChatAdministrators'},
    {
      method: 'sendMessage',
      to: CHAT_GROUP,
      receiverUserId: USER_A,
      text: /recipient is not specified/,
    },
  ])
})

test('an insufficient balance is refused before an invoice is created', async () => {
  await seedSenderAndRecipient({senderBalanceSats: TIP_SATS - 1})

  await expectRefusedTip(groupText('/tip 21 @user_b'), /Insufficient funds/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'sendMessage', to: CHAT_GROUP, receiverUserId: USER_A, text: /Insufficient funds/},
  ])
})

// --- Ephemeral /tip command ---

test('an ephemeral /tip deletes the command and still confirms publicly', async () => {
  await seedSenderAndRecipient()

  await expectInternalTransfer(
    () => e2e.send(groupEphemeralCommand('/tip 21 @user_b')),
    USER_B,
    '100002 wallet',
    [
      {method: 'deleteEphemeralMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: null,
        text: /sent 21 sats to @user_b/,
      },
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  )
})

test('an ephemeral /tip that fails deletes the command and answers its sender', async () => {
  await seedSenderAndRecipient({senderBalanceSats: TIP_SATS - 1})

  await expectRefusedTip(groupEphemeralCommand('/tip 21 @user_b'), /Insufficient funds/, [
    {method: 'deleteEphemeralMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'sendMessage', to: CHAT_GROUP, receiverUserId: USER_A, text: /Insufficient funds/},
  ])
})

test('an invalid /tip command is deleted and answered only to its sender', async () => {
  await seedSender()

  await expectDelta(e2e, () => e2e.send(groupText('/tip twenty @user_b')), {
    telegram: [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: USER_A,
        text: /Invalid command usage/,
      },
    ],
  })

  expectNoErrors(e2e.logs)
})

test('a zero-sat tip is silently discarded after deleting the command', async () => {
  await seedSenderAndRecipient()

  await expectDelta(e2e, () => e2e.send(groupText('/tip 0 @user_b')), {
    telegram: [{method: 'deleteMessage', to: CHAT_GROUP}],
  })

  expectNoErrors(e2e.logs)
})

// --- Building and checking the world ---

async function seedSender(balanceSats = STARTING_BALANCE_SATS): Promise<void> {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  credit(USER_A, balanceSats)
}

async function seedSenderAndRecipient(opts: {senderBalanceSats?: number} = {}): Promise<void> {
  await seedSender(opts.senderBalanceSats ?? STARTING_BALANCE_SATS)
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
}

async function expectInternalTransfer(
  action: () => Promise<void>,
  recipientId: number,
  recipientWallet: string,
  telegram: TelegramExpectation[],
  opts: {recipientAdded?: boolean; conversationRemoved?: boolean} = {},
): Promise<void> {
  const before = await snapshot(e2e)
  await expectDelta(e2e, action, {
    db: {
      ...(opts.recipientAdded ? {users: {added: 1}} : {}),
      ...(opts.conversationRemoved ? {conversations: {removed: 1}} : {}),
    },
    lnbits: {
      balances: {'100001 wallet': -TIP_SATS, [recipientWallet]: TIP_SATS},
      payments: [
        {out: false, sats: TIP_SATS, times: 1},
        {out: true, sats: TIP_SATS, times: 1},
      ],
    },
    telegram,
  })

  expectLedgerBalanced(before, await snapshot(e2e))
  expectPayoutsExactly(e2e.ln, {toWallet: recipientWallet, sats: TIP_SATS, times: 1})
  expect(e2e.ln.state.wallets.find(wallet => wallet.name === recipientWallet)?.balanceMsat).toBe(
    TIP_SATS * 1000,
  )
  expect(e2e.tg.of('sendMessage').some(call => Number(call.chat_id) === recipientId)).toBe(true)
  expectNoErrors(e2e.logs)
}

async function expectRefusedTip(
  update: TestUpdate,
  errorText: RegExp,
  telegram: TelegramExpectation[],
): Promise<void> {
  await expectDelta(e2e, () => e2e.send(update), {telegram})
  expect(e2e.tg.of('sendMessage').some(call => errorText.test(String(call.text)))).toBe(true)
  expect(errorMessages()).toEqual(['Bot error'])
}

async function sendAndWaitForTempMessage(update: TestUpdate): Promise<void> {
  const previousDeletes = e2e.tg.of('deleteMessages').length
  await e2e.send(update)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (e2e.tg.of('deleteMessages').length > previousDeletes) return
    await Bun.sleep(5)
  }
  throw new Error('The temporary error message was never deleted')
}

function notificationTo(userId: number): string {
  const call = e2e.tg
    .of('sendMessage')
    .find(
      payload => Number(payload.chat_id) === userId && String(payload.text).includes('received'),
    )
  if (!call) throw new Error(`No tip notification was sent to ${userId}`)
  return String(call.text)
}

function groupConfirmation(): Record<string, unknown> | undefined {
  return e2e.tg
    .of('sendMessage')
    .find(
      payload => Number(payload.chat_id) === CHAT_GROUP && String(payload.text).includes('sent'),
    )
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function deletedMessageIdsSince(mark: number): number[] {
  return e2e.tg.calls
    .slice(mark)
    .filter(call => call.method === 'deleteMessages')
    .flatMap(call => (Array.isArray(call.payload.message_ids) ? call.payload.message_ids : []))
    .map(Number)
}
