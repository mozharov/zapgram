import {afterEach, beforeEach, expect, test} from 'bun:test'
import {staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import {CHAT_CHANNEL, CHAT_GROUP, USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {
  groupReply,
  groupReplyToChannel,
  groupText,
  privateCallback,
  privateText,
  type TestUpdate,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
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

type TelegramExpectation = {method: string; to?: number; text?: RegExp}

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
  await e2e.send(privateText('@user_b'))

  expect(e2e.tg.last('getChat')?.chat_id).toBe(USER_B)
  await expectInternalTransfer(
    () => e2e.send(privateText(String(TIP_SATS))),
    USER_B,
    '100002 wallet',
    [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
      {method: 'sendMessage', to: USER_A, text: /You sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
    {conversationRemoved: true},
  )

  expect(notificationTo(USER_B)).toContain('Sender: @user_a')
  expect(notificationTo(USER_B)).toMatch(/Balance: <b>21 sats<\/b>/)
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
  expect(notificationTo(USER_B)).toMatch(/Balance: <b>21 sats<\/b>/)
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

// --- Refused tips ---

test('a tip to the sender is refused without moving money', async () => {
  await seedSender()

  await expectRefusedTip(groupText('/tip 21 @user_a'), /can't send sats to yourself/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'sendMessage', to: CHAT_GROUP, text: /can't send sats to yourself/},
    {method: 'deleteMessages', to: CHAT_GROUP},
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
      {method: 'sendMessage', to: CHAT_GROUP, text: /can't send sats to bots/},
      {method: 'deleteMessages', to: CHAT_GROUP},
    ])
  })
}

test('an unknown username is refused without creating a wallet', async () => {
  await seedSender()

  await expectRefusedTip(groupText('/tip 21 @missing_user'), /doesn't have a ZapGram wallet/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'sendMessage', to: CHAT_GROUP, text: /doesn't have a ZapGram wallet/},
    {method: 'deleteMessages', to: CHAT_GROUP},
  ])
})

test('a group with no discoverable creator reports that no recipient was specified', async () => {
  await seedSender()
  e2e.tg.reply('getChatAdministrators', [])

  await expectRefusedTip(groupText('/tip'), /recipient is not specified/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'getChatAdministrators'},
    {method: 'sendMessage', to: CHAT_GROUP, text: /recipient is not specified/},
    {method: 'deleteMessages', to: CHAT_GROUP},
  ])
})

test('an insufficient balance is refused before an invoice is created', async () => {
  await seedSenderAndRecipient({senderBalanceSats: TIP_SATS - 1})

  await expectRefusedTip(groupText('/tip 21 @user_b'), /Insufficient funds/, [
    {method: 'deleteMessage', to: CHAT_GROUP},
    {method: 'sendChatAction', to: CHAT_GROUP},
    {method: 'sendMessage', to: CHAT_GROUP, text: /Insufficient funds/},
    {method: 'deleteMessages', to: CHAT_GROUP},
  ])
})

test('an invalid /tip command is deleted and replaced with a temporary usage hint', async () => {
  await seedSender()

  await expectDelta(e2e, () => sendAndWaitForTempMessage(groupText('/tip twenty @user_b')), {
    telegram: [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, text: /Invalid command usage/},
      {method: 'deleteMessages', to: CHAT_GROUP},
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
  await expectDelta(e2e, () => sendAndWaitForTempMessage(update), {telegram})
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
  throw new Error('The temporary tip message was never deleted')
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
