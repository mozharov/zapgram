import type {Chat} from '@infra/db/types.js'
import {SatspayExtensionDisabledError, type SatspayProbe} from '@infra/lnbits/satspay.js'
import type {AppLogger} from '@infra/logger.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {chatAllowsOnchain} from './complete.service.js'

const UP_FRESH_MS = 6 * 60 * 60 * 1000
const DOWN_FRESH_MS = 10 * 60 * 1000
const CHARGE_REMIND_MS = 60 * 60 * 1000

const DOWN_TEXT = 'SatsPay в LNbits перестал отвечать'
const BACK_TEXT = 'SatsPay снова работает'

type UpSlot = {
  phase: 'up'
  freshUntilMs: number
  probeAfterMs: number
} & ({debt: 'none'; noticeToken: null} | {debt: 'back'; noticeToken: number})

type DownSlot = {
  phase: 'down'
  freshUntilMs: number
  probeAfterMs: number
  toldDownAtMs: number | null
} & ({debt: 'none'; noticeToken: null} | {debt: 'down'; noticeToken: number})

type SatspaySlot = {phase: 'cold'; probeAfterMs: number} | UpSlot | DownSlot

type SatspayEvent =
  | {kind: 'probe'; reading: 'up' | 'down'; token: number}
  | {kind: 'charge-disabled'; token: number}
  | {kind: 'inconclusive'}
  | {kind: 'ack'; token: number}

type Notice = 'down' | 'back'

export type SatspayGateDeps = {
  probe: () => Promise<SatspayProbe>
  notifier: Pick<Notifier, 'send'>
  adminTelegramIds: readonly number[]
  log: AppLogger
  now?: () => number
}

export type SatspayGate = {
  onchainOffered(chat: Pick<Chat, 'onchainEnabled' | 'watchonlyWalletId'>): Promise<boolean>
  beforeCharge(): Promise<'proceed' | 'extension-down'>
  chargeFailed(error: unknown): Promise<'extension-down' | 'other'>
  tick(): Promise<void>
}

export function createSatspayGate(deps: SatspayGateDeps): SatspayGate {
  const now = deps.now ?? (() => Date.now())
  let slot: SatspaySlot = {phase: 'cold', probeAfterMs: 0}
  let epoch = 0
  let tokens = 0
  let chain: Promise<unknown> = Promise.resolve()
  let inflight: Promise<SatspayProbe> | null = null
  let deliveringToken: number | null = null
  let deliveryPromise: Promise<void> | null = null

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function nextToken(): number {
    tokens += 1
    return tokens
  }

  function apply(event: SatspayEvent): void {
    const from = slot.phase
    slot = fold(slot, event, now())
    if (slot.phase !== from) deps.log.info({from, to: slot.phase}, 'SatsPay availability changed')
  }

  function probeShared(): Promise<SatspayProbe> {
    if (!inflight) {
      inflight = deps
        .probe()
        .catch((error: unknown) => {
          deps.log.error({error}, 'SatsPay probe failed')
          return 'inconclusive' as const
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }

  function planDelivery(): Promise<void> | null {
    const armed = armedNotice(slot)
    if (!armed) return null
    if (deliveringToken === armed.token) return deliveryPromise
    if (deps.adminTelegramIds.length === 0) {
      slot = fold(slot, {kind: 'ack', token: armed.token}, now())
      deps.log.info({notice: armed.notice, delivered: false}, 'SatsPay availability notice skipped')
      return null
    }
    const text = armed.notice === 'down' ? DOWN_TEXT : BACK_TEXT
    deliveringToken = armed.token
    const promise = runDelivery(armed.token, armed.notice, text).finally(() => {
      if (deliveringToken === armed.token) {
        deliveringToken = null
        deliveryPromise = null
      }
    })
    deliveryPromise = promise
    return promise
  }

  async function runDelivery(token: number, notice: Notice, text: string): Promise<void> {
    let delivered = false
    for (const id of deps.adminTelegramIds) {
      if (!noticeStill(token)) return
      try {
        const ok = await deps.notifier.send(id, text, undefined, {withoutMenu: true})
        delivered = delivered || ok
      } catch (error) {
        deps.log.error({error}, 'SatsPay availability notice failed')
      }
    }
    if (!delivered || !noticeStill(token)) return
    await exclusive(async () => {
      const next = fold(slot, {kind: 'ack', token}, now())
      if (next === slot) return
      slot = next
      deps.log.info({notice, delivered: true}, 'SatsPay availability notice sent')
    })
  }

  function noticeStill(token: number): boolean {
    return armedNotice(slot)?.token === token
  }

  async function refreshIfDue(): Promise<void> {
    const seen = await exclusive(async () => {
      const nowMs = now()
      if (isFresh(slot, nowMs)) return null
      if (nowMs < slot.probeAfterMs) return null
      return epoch
    })
    if (seen === null) return
    const reading = await probeShared()
    const held = await commit(reading, seen)
    if (held.delivery) void held.delivery
  }

  function commit(reading: SatspayProbe, seenEpoch: number): Promise<DetachedSend> {
    return exclusive(async () => {
      if (reading === 'inconclusive') {
        apply({kind: 'inconclusive'})
        return detach(null)
      }
      if (reading === 'up' && seenEpoch !== epoch) return detach(null)
      apply({kind: 'probe', reading, token: nextToken()})
      epoch += 1
      return detach(planDelivery())
    })
  }

  return {
    async onchainOffered(chat) {
      if (!chatAllowsOnchain(chat)) return false
      await refreshIfDue()
      const current = slot
      return current.phase === 'up' && now() < current.freshUntilMs
    },
    async beforeCharge() {
      await refreshIfDue()
      const current = slot
      if (current.phase === 'down' && now() < current.freshUntilMs) return 'extension-down'
      return 'proceed'
    },
    async chargeFailed(error) {
      if (!(error instanceof SatspayExtensionDisabledError)) return 'other'
      const held = await exclusive(async () => {
        apply({kind: 'charge-disabled', token: nextToken()})
        epoch += 1
        return detach(planDelivery())
      })
      if (held.delivery) void held.delivery
      return 'extension-down'
    },
    async tick() {
      const leftover = await exclusive(async () => detach(planDelivery()))
      if (leftover.delivery) await leftover.delivery
      const seen = await exclusive(async () => epoch)
      const reading = await probeShared()
      const held = await commit(reading, seen)
      if (held.delivery) await held.delivery
    },
  }
}

type DetachedSend = {delivery: Promise<void> | null}

// An async function adopts a returned promise. Boxing the send keeps it outside the lock:
// the ack takes that lock again, and the join toast must not wait on Telegram.
function detach(delivery: Promise<void> | null): DetachedSend {
  return {delivery}
}

function armedNotice(current: SatspaySlot): {token: number; notice: Notice} | null {
  if (current.phase === 'up' && current.debt === 'back') {
    return {token: current.noticeToken, notice: 'back'}
  }
  if (current.phase === 'down' && current.debt === 'down') {
    return {token: current.noticeToken, notice: 'down'}
  }
  return null
}

function isFresh(current: SatspaySlot, nowMs: number): boolean {
  return current.phase !== 'cold' && nowMs < current.freshUntilMs
}

function upClocks(nowMs: number): {freshUntilMs: number; probeAfterMs: number} {
  return {freshUntilMs: nowMs + UP_FRESH_MS, probeAfterMs: nowMs + UP_FRESH_MS}
}

function downClocks(nowMs: number): {freshUntilMs: number; probeAfterMs: number} {
  return {freshUntilMs: nowMs + DOWN_FRESH_MS, probeAfterMs: nowMs + DOWN_FRESH_MS}
}

function fold(slot: SatspaySlot, event: SatspayEvent, nowMs: number): SatspaySlot {
  switch (event.kind) {
    case 'ack':
      return foldAck(slot, event.token, nowMs)
    case 'inconclusive':
      return {...slot, probeAfterMs: nowMs + DOWN_FRESH_MS}
    case 'probe':
      return event.reading === 'up'
        ? foldProbeUp(slot, event.token, nowMs)
        : foldProbeDown(slot, event.token, nowMs)
    case 'charge-disabled':
      return foldChargeDisabled(slot, event.token, nowMs)
    default: {
      const unreachable: never = event
      return unreachable
    }
  }
}

function foldAck(slot: SatspaySlot, token: number, nowMs: number): SatspaySlot {
  if (slot.phase === 'up' && slot.debt === 'back' && slot.noticeToken === token) {
    return {...slot, debt: 'none', noticeToken: null}
  }
  if (slot.phase === 'down' && slot.debt === 'down' && slot.noticeToken === token) {
    return {...slot, debt: 'none', noticeToken: null, toldDownAtMs: nowMs}
  }
  return slot
}

function foldProbeUp(slot: SatspaySlot, token: number, nowMs: number): SatspaySlot {
  const clocks = upClocks(nowMs)
  if (slot.phase === 'cold') return {phase: 'up', ...clocks, debt: 'none', noticeToken: null}
  if (slot.phase === 'up') return {...slot, ...clocks}
  if (slot.toldDownAtMs !== null) return {phase: 'up', ...clocks, debt: 'back', noticeToken: token}
  return {phase: 'up', ...clocks, debt: 'none', noticeToken: null}
}

function foldProbeDown(slot: SatspaySlot, token: number, nowMs: number): SatspaySlot {
  const clocks = downClocks(nowMs)
  if (slot.phase === 'down') return {...slot, ...clocks}
  return {phase: 'down', ...clocks, debt: 'down', noticeToken: token, toldDownAtMs: null}
}

function foldChargeDisabled(slot: SatspaySlot, token: number, nowMs: number): SatspaySlot {
  const clocks = downClocks(nowMs)
  if (slot.phase === 'down' && slot.debt === 'down') return {...slot, ...clocks}
  if (slot.phase === 'down') {
    const due = slot.toldDownAtMs === null || nowMs - slot.toldDownAtMs >= CHARGE_REMIND_MS
    if (!due) return {...slot, ...clocks}
    return {...slot, ...clocks, debt: 'down', noticeToken: token}
  }
  return {phase: 'down', ...clocks, debt: 'down', noticeToken: token, toldDownAtMs: null}
}
