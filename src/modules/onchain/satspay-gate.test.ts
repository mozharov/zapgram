import {describe, expect, mock, test} from 'bun:test'
import type {SatspayProbe} from '@infra/lnbits/satspay.js'
import {SatspayExtensionDisabledError} from '@infra/lnbits/satspay.js'
import type {AppLogger} from '@infra/logger.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {createSatspayGate} from './satspay-gate.js'

const DOWN = 'SatsPay в LNbits перестал отвечать'
const BACK = 'SatsPay снова работает'
const TEN_MINUTES = 10 * 60 * 1000
const SIX_HOURS = 6 * 60 * 60 * 1000
const ONE_HOUR = 60 * 60 * 1000

const enabled = {onchainEnabled: true, watchonlyWalletId: 'wo-1'}
const rowOff = {onchainEnabled: false, watchonlyWalletId: 'wo-1'}
const noWallet = {onchainEnabled: true, watchonlyWalletId: null}

const silentLog = {info() {}, error() {}, warn() {}, debug() {}} as AppLogger

function createGate(opts?: {
  admins?: readonly number[]
  probe?: () => Promise<SatspayProbe>
  send?: Notifier['send']
}) {
  let nowMs = 1_700_000_000_000
  const queued: SatspayProbe[] = []
  const probe = mock(
    opts?.probe ??
      (async () => {
        const next = queued.shift()
        if (next === undefined) throw new Error('probe called with no queued reading')
        return next
      }),
  )
  const send = mock(opts?.send ?? (async () => true))
  const gate = createSatspayGate({
    probe,
    notifier: {send},
    adminTelegramIds: opts?.admins ?? [42],
    log: silentLog,
    now: () => nowMs,
  })
  return {
    gate,
    probe,
    send,
    queue(...readings: SatspayProbe[]) {
      queued.push(...readings)
    },
    advance(ms: number) {
      nowMs += ms
    },
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  const result = await Promise.race([
    promise.then(value => ({ready: true as const, value})),
    Bun.sleep(300).then(() => ({ready: false as const})),
  ])
  if (!result.ready) throw new Error('timed out waiting for the gate')
  return result.value
}

describe('satspay gate', () => {
  test('a chat row that disallows on-chain does not probe', async () => {
    const {gate, probe} = createGate()
    expect(await gate.onchainOffered(rowOff)).toBe(false)
    expect(await gate.onchainOffered(noWallet)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })

  test('a cold slot probes up once and shows the button without telling admins', async () => {
    const {gate, probe, send, queue} = createGate()
    queue('up')
    expect(await gate.onchainOffered(enabled)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(await gate.onchainOffered(enabled)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('probe down hides the button and tells admins once', async () => {
    const {gate, probe, send, queue} = createGate()
    queue('down', 'down')
    await gate.tick()
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(await gate.beforeCharge()).toBe('extension-down')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(send.mock.calls).toEqual([[42, DOWN, undefined, {withoutMenu: true}]])
    await gate.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await gate.onchainOffered(enabled)).toBe(false)
  })

  test('a down that expires probes again and a restore is sent once', async () => {
    const {gate, send, queue, advance} = createGate()
    queue('down', 'up', 'up')
    await gate.tick()
    advance(TEN_MINUTES)
    expect(await gate.onchainOffered(enabled)).toBe(true)
    expect(send.mock.calls.map(call => call[1])).toEqual([DOWN, BACK])
    expect(send.mock.calls[1]?.[3]).toEqual({withoutMenu: true})
    await gate.tick()
    expect(send.mock.calls.map(call => call[1])).toEqual([DOWN, BACK])
  })

  test('a stale up stays hidden when the probe is inconclusive', async () => {
    const {gate, probe, send, queue, advance} = createGate()
    queue('up', 'inconclusive')
    expect(await gate.onchainOffered(enabled)).toBe(true)
    advance(SIX_HOURS)
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test('chargeFailed returns before a deferred admin send resolves', async () => {
    let releaseSend: (() => void) | undefined
    const sendFinished = new Promise<void>(resolve => {
      releaseSend = resolve
    })
    let finished: () => void = () => {}
    const didFinish = new Promise<void>(resolve => {
      finished = resolve
    })
    const {gate, probe, send} = createGate({
      send: async () => {
        await sendFinished
        finished()
        return true
      },
    })
    const result = await within(gate.chargeFailed(new SatspayExtensionDisabledError()))
    expect(result).toBe('extension-down')
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([42, DOWN, undefined, {withoutMenu: true}])
    releaseSend?.()
    await didFinish
  })

  test('a second disabled charge inside the hour does not tell admins again', async () => {
    const {gate, send, advance} = createGate()
    expect(await gate.chargeFailed(new Error('create failed'))).toBe('other')
    expect(await gate.chargeFailed(new SatspayExtensionDisabledError())).toBe('extension-down')
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(await gate.chargeFailed(new SatspayExtensionDisabledError())).toBe('extension-down')
    expect(send).toHaveBeenCalledTimes(1)
    advance(ONE_HOUR)
    expect(await gate.chargeFailed(new SatspayExtensionDisabledError())).toBe('extension-down')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(call => call[1] === DOWN)).toBe(true)
  })

  test('a failed down notice is retried on the next tick', async () => {
    let accept = false
    const {gate, send, queue} = createGate({
      send: async () => accept,
    })
    queue('down', 'down')
    await gate.tick()
    expect(send).toHaveBeenCalledTimes(1)
    accept = true
    await gate.tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(call => call[1] === DOWN)).toBe(true)
  })

  test('a down that was never delivered does not send a restore', async () => {
    const {gate, send, queue, advance} = createGate({
      send: async () => false,
    })
    queue('down', 'up')
    await gate.tick()
    advance(TEN_MINUTES)
    expect(await gate.onchainOffered(enabled)).toBe(true)
    expect(send.mock.calls.map(call => call[1])).toEqual([DOWN])
  })

  test('an in-flight up probe cannot undo a disabled charge', async () => {
    let resolveProbe: (reading: SatspayProbe) => void = () => {}
    let markStarted: () => void = () => {}
    const probeStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const {gate, send} = createGate({
      probe: () =>
        new Promise(resolve => {
          resolveProbe = resolve
          markStarted()
        }),
    })
    const pendingTick = gate.tick()
    await probeStarted
    expect(await gate.chargeFailed(new SatspayExtensionDisabledError())).toBe('extension-down')
    resolveProbe('up')
    await pendingTick
    expect(await gate.onchainOffered(enabled)).toBe(false)
    expect(send.mock.calls.map(call => call[1])).toEqual([DOWN])
  })

  test('a late restore send does not clear a newer down notice', async () => {
    const release: Record<number, (ok: boolean) => void> = {}
    let call = 0
    const {gate, send, queue, advance} = createGate({
      send: async () => {
        const n = ++call
        if (n === 2 || n === 3) {
          return new Promise<boolean>(resolve => {
            release[n] = resolve
          })
        }
        return true
      },
    })
    queue('down', 'up', 'down')
    await gate.tick()
    advance(TEN_MINUTES)
    expect(await within(gate.onchainOffered(enabled))).toBe(true)
    expect(await within(gate.chargeFailed(new SatspayExtensionDisabledError()))).toBe(
      'extension-down',
    )
    expect(send.mock.calls.map(callArgs => callArgs[1])).toEqual([DOWN, BACK, DOWN])
    release[2]?.(true)
    release[3]?.(false)
    await gate.tick()
    expect(send.mock.calls.map(callArgs => callArgs[1])).toEqual([DOWN, BACK, DOWN, DOWN])
    expect(await gate.onchainOffered(enabled)).toBe(false)
  })

  test('an empty admin list never sends', async () => {
    const {gate, send, queue} = createGate({admins: []})
    queue('down', 'down')
    await gate.tick()
    await gate.tick()
    expect(send).not.toHaveBeenCalled()
    expect(await gate.onchainOffered(enabled)).toBe(false)
  })

  test('a new gate is cold, so the following up sends nothing', async () => {
    const first = createGate()
    first.queue('down')
    await first.gate.tick()
    expect(first.send).toHaveBeenCalledTimes(1)

    const second = createGate()
    second.queue('up')
    expect(await second.gate.onchainOffered(enabled)).toBe(true)
    expect(second.send).not.toHaveBeenCalled()
  })
})
