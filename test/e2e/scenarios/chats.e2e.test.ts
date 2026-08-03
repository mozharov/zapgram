import {afterEach, beforeEach, expect, test} from 'bun:test'
import type {Chat} from '@infra/db/types.js'
import {
  chatChangePriceRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
  chatsPageRoute,
} from '@telegram/callback-data.js'
import {expectEditedNotSent, expectNoConversations, expectNoErrors} from '../asserts.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedUser} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  myChatMember,
  newChatTitle,
  privateCallback,
  privateCommand,
  privateText,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.chats

/**
 * Paid-chat administration from Telegram updates all the way through the real repositories.
 *
 * The assertions deliberately distinguish edits from new messages. A settings button belongs to
 * an existing card and must edit it, while the two conversations delete that card and later send
 * a fresh one after the user has supplied the requested text.
 */

const CHAT_PRICE = 1000
const CHANGED_PRICE = 123
const OWNER_PROFILE = {
  id: OWNER,
  is_bot: false,
  first_name: 'Chat Owner',
  username: 'chat_owner',
  language_code: 'en',
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Telegram rights and chat metadata ---

for (const type of ['supergroup', 'channel'] as const) {
  test(`granting the required rights registers an inactive ${type} and notifies its owner`, async () => {
    queueChatOwner()
    const update = myChatMember(type, true)
    const chatId = type === 'channel' ? CHAT_CHANNEL : CHAT_GROUP
    const title = type === 'channel' ? 'E2E Channel' : 'E2E Group'

    await expectDelta(e2e, () => e2e.send(update), {
      db: {
        users: {
          added: 1,
          match: rows => {
            expect(rows[0]?.after).toMatchObject({
              id: OWNER,
              username: 'chat_owner',
              firstName: 'Chat Owner',
              languageCode: 'en',
            })
          },
        },
        chats: {
          added: 1,
          match: rows => {
            expect(rows[0]?.after).toMatchObject({
              id: chatId,
              ownerId: OWNER,
              title,
              type,
              status: 'inactive',
              price: CHAT_PRICE,
              paymentType: 'one_time',
              customMessageEn: null,
              customMessageRu: null,
            })
          },
        },
      },
      telegram: [
        {method: 'getChatAdministrators'},
        {method: 'sendMessage', to: OWNER, text: new RegExp(`was added to ${title}`)},
      ],
    })

    expect(e2e.tg.last('getChatAdministrators')?.chat_id).toBe(chatId)
    expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([chatRoute.build({chatId})])
    expectNoErrors(e2e.logs)
  })
}

test('losing the required rights marks an active chat as inaccessible', async () => {
  await seedOwner()
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active'})

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', false)), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {status: 'no_access'}),
      },
    },
    telegram: [{method: 'sendMessage', to: OWNER, text: /was removed from E2E Group/}],
  })

  expect(e2e.tg.of('getChatAdministrators')).toHaveLength(0)
  expect(urlsOf(e2e.tg.last('sendMessage'))).toEqual(['https://t.me/zap_gram_bot?startgroup=true'])
  expectNoErrors(e2e.logs)
})

test('returning the required rights restores an inaccessible chat as inactive', async () => {
  await seedOwner()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E Group',
    status: 'no_access',
  })
  queueChatOwner()

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', true)), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {status: 'inactive'}),
      },
    },
    telegram: [
      {method: 'getChatAdministrators'},
      {method: 'sendMessage', to: OWNER, text: /was added to E2E Group/},
    ],
  })

  expectNoErrors(e2e.logs)
})

for (const permission of ['can_invite_users', 'can_restrict_members'] as const) {
  test(`a first grant without ${permission} does not register the chat`, async () => {
    const update = myChatMember('supergroup', true)
    const member = update.my_chat_member?.new_chat_member
    if (member?.status !== 'administrator') throw new Error('Expected an administrator fixture')
    member[permission] = false

    await expectDelta(e2e, () => e2e.send(update), {})

    expectNoErrors(e2e.logs)
  })
}

test('a failed administrator lookup is logged and leaves the world unchanged', async () => {
  e2e.tg.fail('getChatAdministrators', {
    error_code: 400,
    description: 'Bad Request: chat administrators unavailable',
  })

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', true)), {
    telegram: [{method: 'getChatAdministrators'}],
  })

  expect(errorMessages()).toEqual(['Cannot get chat creator of paid chat'])
})

test('a new chat title changes only the stored title', async () => {
  await seedOwner()
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active'})

  await expectDelta(e2e, () => e2e.send(newChatTitle('Renamed paid chat')), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {title: 'Renamed paid chat'}),
      },
    },
  })

  expectNoErrors(e2e.logs)
})

// --- Chat card callbacks ---

type CardCase = {
  label: string
  seed: Partial<Pick<Chat, 'status' | 'paymentType' | 'price'>>
  data: string
  changes?: Partial<Pick<Chat, 'status' | 'paymentType'>>
  text: RegExp
}

const cardCases: CardCase[] = [
  {
    label: 'opening a chat card',
    seed: {status: 'active', paymentType: 'monthly', price: 4321},
    data: chatRoute.build({chatId: CHAT_GROUP}),
    text: /E2E paid chat/,
  },
  {
    label: 'disabling paid access',
    seed: {status: 'active'},
    data: chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'inactive'}),
    changes: {status: 'inactive'},
    text: /Paid access: <b>disabled/,
  },
  {
    label: 'enabling paid access',
    seed: {status: 'inactive'},
    data: chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'active'}),
    changes: {status: 'active'},
    text: /Paid access: <b>enabled/,
  },
  {
    label: 'switching to monthly payments',
    seed: {paymentType: 'one_time'},
    data: chatPaymentTypeRoute.build({chatId: CHAT_GROUP, paymentType: 'monthly'}),
    changes: {paymentType: 'monthly'},
    text: /Payment type: <b>monthly/,
  },
  {
    label: 'switching to one-time payments',
    seed: {paymentType: 'monthly'},
    data: chatPaymentTypeRoute.build({chatId: CHAT_GROUP, paymentType: 'one_time'}),
    changes: {paymentType: 'one_time'},
    text: /Payment type: <b>one-time/,
  },
]

for (const cardCase of cardCases) {
  test(`${cardCase.label} edits the existing card instead of sending a new one`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    const chat = await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      ...cardCase.seed,
    })

    await expectDelta(e2e, () => e2e.send(privateCallback(cardCase.data)), {
      db: cardCase.changes
        ? {
            chats: {
              changed: 1,
              match: rows => expectOnlyChatChanges(rows, cardCase.changes ?? {}),
            },
          }
        : undefined,
      telegram: [{method: 'editMessageText', to: USER_A, text: cardCase.text}],
    })

    expectEditedNotSent(e2e.tg)
    const finalChat = {...chat, ...cardCase.changes}
    expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual([
      chatPaidAccessRoute.build({
        chatId: CHAT_GROUP,
        status: finalChat.status === 'active' ? 'inactive' : 'active',
      }),
      chatPaymentTypeRoute.build({
        chatId: CHAT_GROUP,
        paymentType: finalChat.paymentType === 'monthly' ? 'one_time' : 'monthly',
      }),
      chatChangePriceRoute.build({chatId: CHAT_GROUP}),
      chatCustomMessageRoute.build({chatId: CHAT_GROUP}),
      chatsPageRoute.build({page: 1}),
    ])
    expectNoErrors(e2e.logs)
  })
}

test("a different user can currently enable paid access for someone else's chat", async () => {
  await seedOwner()
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'Foreign paid chat',
    status: 'inactive',
  })

  // This pins the confirmed defect in docs/known-issues.md. Once handlers scope lookups by owner,
  // the same scenario should expect an unchanged row and the generic not-found card.
  await expectDelta(
    e2e,
    () =>
      e2e.send(privateCallback(chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'active'}))),
    {
      db: {
        chats: {
          changed: 1,
          match: rows => expectOnlyChatChanges(rows, {status: 'active'}),
        },
      },
      telegram: [{method: 'editMessageText', to: USER_A, text: /Foreign paid chat/}],
    },
  )

  expectEditedNotSent(e2e.tg)
  expectNoErrors(e2e.logs)
})

// --- Price conversation ---

test('a valid price is stored and the completed conversation sends a fresh card', async () => {
  await enterChangingPrice()

  await expectDelta(e2e, () => e2e.send(privateText(String(CHANGED_PRICE))), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {price: CHANGED_PRICE}),
      },
      conversations: {removed: 1},
    },
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /set to 123 sats/},
      {method: 'sendMessage', to: USER_A, text: /Price: <b>123 sats/},
    ],
  })

  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('editMessageText')).toHaveLength(0)
  expectNoErrors(e2e.logs)
})

for (const price of [0, -5]) {
  test(`price ${price} is rejected without changing the chat`, async () => {
    await enterChangingPrice()

    await expectDelta(e2e, () => e2e.send(privateText(String(price))), {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageReplyMarkup', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/},
        {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      ],
    })

    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('a nonnumeric price cancels the conversation and falls through to the wallet', async () => {
  await enterChangingPrice()

  await expectDelta(e2e, () => e2e.send(privateText('abc')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

// --- Custom join message ---

const customScreenCases = [
  {
    label: 'without a custom message',
    customMessages: {},
    expectedCallbacks: [
      chatEditCustomMessageRoute.build({chatId: CHAT_GROUP}),
      chatRoute.build({chatId: CHAT_GROUP}),
    ],
  },
  {
    label: 'with a custom message',
    customMessages: {
      customMessageRu: 'Особое приветствие',
      customMessageEn: 'A special welcome',
    },
    expectedCallbacks: [
      chatEditCustomMessageRoute.build({chatId: CHAT_GROUP}),
      chatRemoveCustomMessageRoute.build({chatId: CHAT_GROUP}),
      chatRoute.build({chatId: CHAT_GROUP}),
    ],
  },
] as const

for (const screenCase of customScreenCases) {
  test(`the custom-message screen ${screenCase.label} exposes only valid actions`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      ...screenCase.customMessages,
    })

    await expectDelta(
      e2e,
      () => e2e.send(privateCallback(chatCustomMessageRoute.build({chatId: CHAT_GROUP}))),
      {telegram: [{method: 'editMessageText', to: USER_A, text: /Current message/}]},
    )

    expectEditedNotSent(e2e.tg)
    expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual([
      ...screenCase.expectedCallbacks,
    ])
    expectNoErrors(e2e.logs)
  })
}

test('the custom-message conversation stores both language variants', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatEditCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Enter a custom message in Russian/},
      ],
    },
  )
  e2e.tg.reset()

  await expectDelta(e2e, () => e2e.send(privateText('Особое приветствие')), {
    db: {conversations: {changed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Enter a custom message in English/},
    ],
  })
  e2e.tg.reset()

  await expectDelta(e2e, () => e2e.send(privateText('A special welcome')), {
    db: {
      chats: {
        changed: 1,
        match: rows =>
          expectOnlyChatChanges(rows, {
            customMessageRu: 'Особое приветствие',
            customMessageEn: 'A special welcome',
          }),
      },
      conversations: {removed: 1},
    },
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Custom message has been updated/},
      {method: 'sendMessage', to: USER_A, text: /E2E paid chat/},
    ],
  })

  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

for (const customJoin of [
  {locale: 'en', selected: /A special welcome/, other: 'Особое приветствие'},
  {locale: 'ru', selected: /Особое приветствие/, other: 'A special welcome'},
] as const) {
  test(`an exact ${customJoin.locale} locale receives its custom join message`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedUser(e2e, {
      id: USER_B,
      username: 'user_b',
      firstName: 'User B',
      languageCode: customJoin.locale,
    })
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      customMessageRu: 'Особое приветствие',
      customMessageEn: 'A special welcome',
    })

    const beforeJoin = await snapshot(e2e)
    await expectDelta(
      e2e,
      () =>
        e2e.send(
          chatJoinRequest('supergroup', {
            from: {
              id: USER_B,
              username: 'user_b',
              first_name: 'User B',
              language_code: customJoin.locale,
            },
          }),
        ),
      {
        db: {
          subscriptionPayments: {
            added: 1,
            match: rows => {
              expect(rows[0]?.after).toMatchObject({
                userId: USER_B,
                chatId: CHAT_GROUP,
                price: CHAT_PRICE,
                subscriptionType: 'one_time',
                kind: 'join',
              })
            },
          },
        },
        lnbits: {payments: [{out: false, sats: CHAT_PRICE, times: 1}]},
        telegram: [{method: 'sendMessage', to: USER_B, text: customJoin.selected}],
      },
    )

    const notification = String(e2e.tg.last('sendMessage')?.text)
    expect(notification).not.toContain(customJoin.other)
    expect(notification).not.toContain('Access to private community')
    expectLedgerBalanced(beforeJoin, await snapshot(e2e))
    expectNoErrors(e2e.logs)
  })
}

test('removing a custom message restores the default join copy', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {
    id: USER_B,
    username: 'user_b',
    firstName: 'User B',
    languageCode: 'en',
  })
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    customMessageRu: 'Старое приветствие',
    customMessageEn: 'Old custom welcome',
  })

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatRemoveCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {
        chats: {
          changed: 1,
          match: rows =>
            expectOnlyChatChanges(rows, {customMessageRu: null, customMessageEn: null}),
        },
      },
      telegram: [{method: 'editMessageText', to: USER_A, text: /E2E paid chat/}],
    },
  )
  expectEditedNotSent(e2e.tg)
  e2e.tg.reset()

  const beforeJoin = await snapshot(e2e)
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        chatJoinRequest('supergroup', {
          from: {id: USER_B, username: 'user_b', first_name: 'User B', language_code: 'en'},
        }),
      ),
    {
      db: {subscriptionPayments: {added: 1}},
      lnbits: {payments: [{out: false, sats: CHAT_PRICE, times: 1}]},
      telegram: [
        {method: 'sendMessage', to: USER_B, text: /Access to private community "E2E paid chat"/},
      ],
    },
  )

  expect(String(e2e.tg.last('sendMessage')?.text)).not.toContain('Old custom welcome')
  expectLedgerBalanced(beforeJoin, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

// --- Pagination ---

test('/chats with one accessible chat has no page controls', async () => {
  const chats = await seedOwnedChats(1)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  expect(chatCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([
    chatRoute.build({chatId: requiredChat(chats, 0).id}),
  ])
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('/chats with exactly ten accessible chats has no next page', async () => {
  const chats = await seedOwnedChats(10)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  const callbacks = chatCallbacksOf(e2e.tg.last('sendMessage'))
  expect(callbacks).toHaveLength(10)
  expect(new Set(callbacks)).toEqual(new Set(chats.map(chat => chatRoute.build({chatId: chat.id}))))
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('/chats with eleven accessible chats exposes a second page after ten rows', async () => {
  const chats = await seedOwnedChats(11)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  const firstPageChats = chatCallbacksOf(e2e.tg.last('sendMessage'))
  expect(firstPageChats).toHaveLength(10)
  expect(new Set(firstPageChats)).toEqual(
    new Set(chats.slice(0, 10).map(chat => chatRoute.build({chatId: chat.id}))),
  )
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([chatsPageRoute.build({page: 2})])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('the last page edits the list with one row and a previous-page button', async () => {
  const chats = await seedOwnedChats(11)

  await expectDelta(e2e, () => e2e.send(privateCallback(chatsPageRoute.build({page: 2}))), {
    telegram: [{method: 'editMessageText', to: USER_A, text: /Your chats with the ability/}],
  })

  expectEditedNotSent(e2e.tg)
  expect(chatCallbacksOf(e2e.tg.last('editMessageText'))).toEqual([
    chatRoute.build({chatId: requiredChat(chats, 10).id}),
  ])
  expect(pageCallbacksOf(e2e.tg.last('editMessageText'))).toEqual([chatsPageRoute.build({page: 1})])
  expectAddChatButton(e2e.tg.last('editMessageText'))
  expectNoErrors(e2e.logs)
})

// --- Setup and payload helpers ---

async function seedOwner(): Promise<void> {
  await seedUser(e2e, {
    id: OWNER,
    username: 'chat_owner',
    firstName: 'Chat Owner',
    languageCode: 'en',
  })
}

function queueChatOwner(): void {
  e2e.tg.reply('getChatAdministrators', [
    {status: 'creator', user: OWNER_PROFILE, is_anonymous: false},
  ])
}

async function enterChangingPrice(): Promise<void> {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    price: CHAT_PRICE,
  })
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatChangePriceRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Changing the price of paid access/},
        {method: 'sendMessage', to: USER_A, text: /Enter the amount of sats/},
      ],
    },
  )
  e2e.tg.reset()
}

async function seedOwnedChats(count: number): Promise<Chat[]> {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedOwner()

  const chats: Chat[] = []
  const newest = Date.UTC(2026, 0, 1)
  for (let index = 0; index < count; index++) {
    chats.push(
      await seedChat(e2e, {
        id: CHAT_GROUP - index * 10,
        ownerId: USER_A,
        title: `Owned chat ${index + 1}`,
        status: 'inactive',
        createdAt: new Date(newest - index * 60_000),
      }),
    )
  }

  // Neither a foreign owner's chat nor an inaccessible owned chat may affect a page boundary.
  await seedChat(e2e, {
    id: CHAT_GROUP - 20_000,
    ownerId: OWNER,
    title: 'Foreign chat',
    status: 'active',
    createdAt: new Date(newest + 60_000),
  })
  await seedChat(e2e, {
    id: CHAT_GROUP - 10_000,
    ownerId: USER_A,
    title: 'Inaccessible chat',
    status: 'no_access',
    createdAt: new Date(newest + 120_000),
  })
  return chats
}

function expectOnlyChatChanges(
  rows: {before?: unknown; after?: unknown}[],
  changes: Partial<Chat>,
): void {
  expect(rows).toHaveLength(1)
  const before = asRecord(rows[0]?.before)
  const after = asRecord(rows[0]?.after)
  expect(after).toEqual({...before, ...changes})
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  return buttonsOf(payload).flatMap(button =>
    typeof button.callback_data === 'string' ? [button.callback_data] : [],
  )
}

function chatCallbacksOf(payload: Record<string, unknown> | undefined): string[] {
  return callbackDataOf(payload).filter(data => data.startsWith('chat:'))
}

function pageCallbacksOf(payload: Record<string, unknown> | undefined): string[] {
  return callbackDataOf(payload).filter(data => data.startsWith('chats:'))
}

function urlsOf(payload: Record<string, unknown> | undefined): string[] {
  return buttonsOf(payload).flatMap(button => (typeof button.url === 'string' ? [button.url] : []))
}

function buttonsOf(payload: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const markup = payload?.reply_markup as
    | {inline_keyboard?: Record<string, unknown>[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat()
}

function expectAddChatButton(payload: Record<string, unknown> | undefined): void {
  expect(urlsOf(payload)).toContain('https://t.me/zap_gram_bot?startgroup=true')
}

function requiredChat(chats: Chat[], index: number): Chat {
  const chat = chats[index]
  if (!chat) throw new Error(`Expected chat fixture at index ${index}`)
  return chat
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${String(value)}`)
  }
  return value as Record<string, unknown>
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
