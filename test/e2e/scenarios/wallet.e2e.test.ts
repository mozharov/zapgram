import {afterEach, beforeEach, expect, test} from 'bun:test'
import {expectNoErrors} from '../asserts.js'
import {USER_A} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {privateCallback, privateCommand} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.wallet

/**
 * The wallet and settings screens, for a user with no NWC wallet connected.
 *
 * Two things are worth proving beyond "a message came back": which LNbits endpoints a screen
 * actually touches — the balance on the wallet screen is a live read, not a cached number — and
 * which buttons it offers, since every other scenario reaches its handler through one of them.
 *
 * Everything that needs a live NWC connection lives elsewhere; here `users.nwc_url` is always null.
 */

const BALANCE_SATS = 1234

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
})

afterEach(async () => {
  await e2e.dispose()
})

// --- The wallet screen ---

test('/wallet reads the balance from LNbits and shows it', async () => {
  credit(BALANCE_SATS)
  const mark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [
      {
        method: 'sendMessage',
        to: USER_A,
        // Default fake rate 100_000 → 1234 sats ≈ $1.23
        text: /<b>Balance:<\/b> 1\D?234 sats \(~\$1\.23\)/,
      },
    ],
  })

  // The middleware resolves the user's wallet, then the screen asks for the balance. The last one
  // is what makes this a live read: the number on screen cannot be stale. Rate is public LNbits.
  expect(lnPathsSince(mark)).toEqual([
    'GET /users/api/v1/user',
    'GET /users/api/v1/user/<id>/wallet',
    'GET /api/v1/wallet',
    'GET /api/v1/rate/USD',
  ])
  expect(String(e2e.tg.last('sendMessage')?.text)).toContain('(~$')
  expectNoErrors(e2e.logs)
})

test('the wallet button re-renders in place without asking for the balance again', async () => {
  credit(BALANCE_SATS)
  const mark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.send(privateCallback('wallet')), {
    telegram: [
      {method: 'editMessageText', to: USER_A, text: /<b>Balance:<\/b> 1\D?234 sats \(~\$1\.23\)/},
    ],
  })

  // Editing a screen reuses the balance the middleware already loaded, so no `/api/v1/wallet`.
  expect(lnPathsSince(mark)).toEqual([
    'GET /users/api/v1/user',
    'GET /users/api/v1/user/<id>/wallet',
    'GET /api/v1/rate/USD',
  ])
  expectNoErrors(e2e.logs)
})

test('without a connected NWC wallet the screen shows one balance line', async () => {
  credit(BALANCE_SATS)
  await e2e.send(privateCommand('/wallet'))

  const text = String(e2e.tg.last('sendMessage')?.text)
  expect(text).toMatch(/<b>Balance:<\/b>/)
  expect(text).not.toMatch(/NWC:/)
  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcUrl: null})
})

test('the wallet screen offers receive, send, settings, help and support', async () => {
  await e2e.send(privateCommand('/wallet'))

  expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
    'create-invoice',
    'send-menu',
    'settings',
    'help',
    'donate',
  ])
})

// --- The settings screen ---

test('/settings offers connecting a wallet and nothing that needs one', async () => {
  await expectDelta(e2e, () => e2e.send(privateCommand('/settings')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Connecting an external wallet/}],
  })

  // No disconnect and no tips toggle: both are rendered only once `nwc_url` is set.
  expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
    'connect-nwc',
    'group-settings',
    'donate',
    'wallet',
  ])
  expectNoErrors(e2e.logs)
})

test('the settings button renders the same screen in place', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback('settings')), {
    telegram: [{method: 'editMessageText', to: USER_A, text: /Connecting an external wallet/}],
  })
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual([
    'connect-nwc',
    'group-settings',
    'donate',
    'wallet',
  ])
  expectNoErrors(e2e.logs)
})

test('toggling NWC tips flips the column and says which wallet pays now', async () => {
  // The button that sends this callback is only drawn for a user with `nwc_url` set, so what is
  // pinned here is the handler and the column it writes — not a screen this user can reach.
  await expectDelta(e2e, () => e2e.send(privateCallback('toggle-nwc-tips')), {
    db: {users: {changed: 1}},
    telegram: [
      {method: 'answerCallbackQuery', text: /tips are sent from the NWC wallet/},
      {method: 'editMessageText', to: USER_A, text: /Connecting an external wallet/},
    ],
  })

  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcTips: true, nwcUrl: null})
  expectNoErrors(e2e.logs)
})

test('toggling NWC tips twice puts the column back', async () => {
  await e2e.send(privateCallback('toggle-nwc-tips'))

  await expectDelta(e2e, () => e2e.send(privateCallback('toggle-nwc-tips')), {
    db: {users: {changed: 1}},
    telegram: [
      {method: 'answerCallbackQuery', text: /tips are sent from the ZapGram wallet/},
      {method: 'editMessageText', to: USER_A},
    ],
  })

  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcTips: false})
  expectNoErrors(e2e.logs)
})

test('group settings opens the groups screen with paid chats and a way back', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback('group-settings')), {
    telegram: [{method: 'editMessageText', to: USER_A, text: /Groups and channels/}],
  })
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual(['chats:1', 'settings'])
  expectNoErrors(e2e.logs)
})

test('the send menu opens the send screen', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback('send-menu')), {
    telegram: [{method: 'editMessageText', to: USER_A, text: /Send payment/}],
  })
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual([
    'pay-invoice',
    'send-to-user',
    'wallet',
  ])
  expectNoErrors(e2e.logs)
})

// --- LNbits is unwell ---

test('a transient 500 on the balance endpoint never reaches the user', async () => {
  credit(BALANCE_SATS)
  e2e.ln.state.failNext({method: 'GET', path: '/api/v1/wallet'}, {status: 500, body: {}})
  const mark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /<b>Balance:<\/b> 1\D?234 sats/}],
  })

  // got retries a failed GET, so the second attempt is what the user's balance came from.
  expect(lnPathsSince(mark).filter(path => path === 'GET /api/v1/wallet')).toHaveLength(2)
  expectNoErrors(e2e.logs)
}, 15_000)

test('a balance endpoint that stays down leaves the user with an error and the world untouched', async () => {
  credit(BALANCE_SATS)
  e2e.ln.state.failAlways({method: 'GET', path: '/api/v1/wallet'}, {status: 500, body: {}})
  const mark = e2e.ln.requests.length

  // Command fails the live balance read; the error handler appends the wallet screen from the
  // middleware-cached balance without a second GET (which would only add got retries).
  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /Unknown error occurred/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  expect(lnPathsSince(mark).filter(path => path === 'GET /api/v1/wallet')).toHaveLength(3)
  expect(errorMessages()).toEqual(['GET /api/v1/wallet: HTTP error', 'Bot error'])
}, 15_000)

function credit(sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(USER_A))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${USER_A}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

/** LNbits user and wallet ids are generated, so only their shape is stable enough to assert. */
function lnPathsSince(mark: number): string[] {
  return e2e.ln.requests
    .slice(mark)
    .map(
      request =>
        `${request.method} ${request.path.replace(/user\/[^/]+\/wallet/, 'user/<id>/wallet')}`,
    )
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
