import {afterEach, beforeEach, expect, test} from 'bun:test'
import {seedUser} from './fixtures/seed.js'
import {privateCommand} from './fixtures/updates.js'
import {createE2E, type E2E} from './harness.js'
import {expectDelta, expectLedgerBalanced, snapshot, type WorldState} from './state.js'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('an empty world has ten DB tables and stable normalized snapshots', async () => {
  const first = await snapshot(e2e)
  const second = await snapshot(e2e)

  expect(Object.keys(first.db)).toHaveLength(10)
  // Singleton platform-stats row is seeded by migration (zeros until first donation).
  for (const [key, rows] of Object.entries(first.db)) {
    if (key === 'donationPlatformStats') {
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({id: 1, totalSats: 0, totalCount: 0})
    } else {
      expect(rows).toHaveLength(0)
    }
  }
  expect(second).toEqual(first)
})

test('snapshot normalizes Telegram UUIDs without changing the original calls', async () => {
  const uuid = '0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f'
  e2e.tg.calls.push({method: 'testMethod', payload: {callback_data: `subscription:${uuid}`}})

  expect((await snapshot(e2e)).telegram[0]?.payload.callback_data).toBe('subscription:<uuid>')
  expect(e2e.tg.calls[0]?.payload.callback_data).toBe(`subscription:${uuid}`)
})

test('expectDelta passes for a no-op with empty expectations', async () => {
  await expectDelta(e2e, async () => {}, {})
})

test('expectDelta reports an extra row in an unmentioned table', async () => {
  await expect(
    expectDelta(
      e2e,
      async () => {
        await seedUser(e2e)
      },
      {},
    ),
  ).rejects.toThrow('Unexpected DB change in users')
})

test('expectDelta reports an extra Telegram call', async () => {
  await expect(
    expectDelta(e2e, () => e2e.send(privateCommand('/help')), {
      db: {users: {added: 1}},
      lnbits: {balances: {'100001 wallet': 0}},
    }),
  ).rejects.toThrow('Unexpected Telegram calls')
})

test('expectDelta accepts an exactly described full-world delta', async () => {
  await expectDelta(e2e, () => e2e.send(privateCommand('/help')), {
    db: {users: {added: 1}},
    lnbits: {balances: {'100001 wallet': 0}},
    telegram: [{method: 'sendMessage', to: 100001, text: /ZapGram|Lightning|wallet/i}],
  })
})

test('expectDelta rejects an expected balance for a wallet that does not exist', async () => {
  await expect(
    expectDelta(e2e, async () => {}, {lnbits: {balances: {'missing wallet': 0}}}),
  ).rejects.toThrow('missing wallet')
})

test('expectLedgerBalanced reports an artificial imbalance', async () => {
  const before = await snapshot(e2e)
  const after = structuredClone(before) as WorldState
  const wallet = after.lnbits.wallets[0]
  if (!wallet) throw new Error('Expected the fake master wallet')
  wallet.balanceMsat += 1000

  expect(() => expectLedgerBalanced(before, after)).toThrow('ledger is not balanced')
})
