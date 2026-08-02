import {expect} from 'bun:test'
import type {AppDatabase} from '@infra/db/client.js'
import {conversationsTable} from '@infra/db/schema.js'
import type {FakeLnbits} from './fakes/lnbits-server.js'
import type {FakeTelegram} from './fakes/telegram-server.js'
import type {LogRecord} from './harness.js'
import type {WorldState} from './state.js'

export function expectMessageTo(tg: FakeTelegram, userId: number, text: RegExp): void {
  const matching = tg.calls.filter(call => {
    if (call.method !== 'sendMessage' && call.method !== 'sendPhoto') return false
    const payloadText = String(call.payload.text ?? call.payload.caption ?? '')
    text.lastIndex = 0
    return Number(call.payload.chat_id) === userId && text.test(payloadText)
  })
  expect(matching, `Expected a message to ${userId} matching ${text}`).not.toHaveLength(0)
}

export function expectEditedNotSent(tg: FakeTelegram): void {
  expect(tg.of('editMessageText')).not.toHaveLength(0)
  expect(tg.of('sendMessage')).toHaveLength(0)
}

export function expectNoErrors(logs: LogRecord[]): void {
  expect(logs.filter(log => log.level === 'error' || log.level === 50)).toEqual([])
}

export async function expectNoConversations(db: AppDatabase): Promise<void> {
  expect(await db.select().from(conversationsTable)).toEqual([])
}

export function expectPayoutsExactly(
  ln: FakeLnbits,
  expected: {toWallet: string | {id: string}; sats: number; times: number},
): void {
  const walletId =
    typeof expected.toWallet === 'string'
      ? ln.state.wallets.find(
          wallet =>
            wallet.id === expected.toWallet ||
            wallet.name === expected.toWallet ||
            wallet.username === expected.toWallet,
        )?.id
      : expected.toWallet.id
  if (!walletId) throw new Error(`Fake LNbits wallet ${String(expected.toWallet)} not found`)
  const payouts = ln.state.payments.filter(
    payment => !payment.out && payment.paid && payment.walletId === walletId,
  )
  expect(payouts).toHaveLength(expected.times)
  expect(payouts.every(payment => payment.amountMsat === expected.sats * 1000)).toBe(true)
}

export function expectWorldUnchanged(before: WorldState, after: WorldState): void {
  expect(after).toEqual(before)
}
