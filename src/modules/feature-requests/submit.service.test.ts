import {describe, expect, mock, test} from 'bun:test'
import {createFeatureRequestService, formatFeatureRequestAdminMeta} from './submit.service.js'

const source = {chatId: 1, messageId: 99, text: 'Built-in on-chain wallet'}

describe('formatFeatureRequestAdminMeta', () => {
  test('shows who and funding without body text', () => {
    const text = formatFeatureRequestAdminMeta({
      userId: 42,
      username: 'alice',
      firstName: 'Alice',
      amountPaidSats: 1000,
      fundStatus: 'paid',
    })
    expect(text).toContain('@alice')
    expect(text).toContain('1000')
    expect(text).toContain('42')
    expect(text).not.toContain('Want')
  })
})

describe('createFeatureRequestService', () => {
  test('submits free request: meta + copyMessage per admin', async () => {
    const notify = mock(async () => true)
    const copyMessage = mock(async () => true)
    const capture = mock(() => {})
    const payDonation = mock(async () => ({status: 'paid' as const, rail: 'internal' as const}))

    const service = createFeatureRequestService({
      payDonation,
      notify,
      copyMessage,
      adminTelegramIds: [7, 8],
      formatAdminMeta: formatFeatureRequestAdminMeta,
      log: {info: () => {}, warn: () => {}, error: () => {}, debug: () => {}} as never,
      posthog: {capture: capture, captureException: () => {}} as never,
    })

    const result = await service.submit({
      userId: 1,
      username: 'bob',
      source,
      amountSats: 0,
    })

    expect(result).toEqual({fundStatus: 'skipped', amountPaidSats: 0, adminNotified: 2})
    expect(payDonation).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(copyMessage).toHaveBeenCalledTimes(2)
    expect(copyMessage).toHaveBeenCalledWith(7, 1, 99)
    expect(copyMessage).toHaveBeenCalledWith(8, 1, 99)
    expect(capture).toHaveBeenCalled()
    const firstCall = capture.mock.calls[0] as unknown as [
      {event: string; properties: Record<string, unknown>},
    ]
    const event = firstCall[0]
    expect(event.event).toBe('feature_requested')
    expect(event.properties.funded).toBe(false)
    expect(event.properties.feature_text).toBe('Built-in on-chain wallet')
  })

  test('funds via donation then notifies with meta + copy', async () => {
    const notify = mock(async () => true)
    const copyMessage = mock(async () => true)
    const payDonation = mock(async () => ({
      status: 'paid' as const,
      paymentHash: 'h',
      rail: 'internal' as const,
    }))

    const service = createFeatureRequestService({
      payDonation,
      notify,
      copyMessage,
      adminTelegramIds: [7],
      formatAdminMeta: formatFeatureRequestAdminMeta,
      log: {info: () => {}, warn: () => {}, error: () => {}, debug: () => {}} as never,
    })

    const result = await service.submit({
      userId: 1,
      source: {...source, text: 'NWC multi-wallet'},
      amountSats: 21,
    })

    expect(result.fundStatus).toBe('paid')
    expect(result.amountPaidSats).toBe(21)
    expect(payDonation).toHaveBeenCalledWith(
      expect.objectContaining({
        amountSats: 21,
        kind: 'one_shot',
        analytics: {source: 'feature_request'},
      }),
    )
    expect(notify).toHaveBeenCalled()
    expect(copyMessage).toHaveBeenCalledWith(7, 1, 99)
  })

  test('pay failure still submits free request', async () => {
    const notify = mock(async () => true)
    const copyMessage = mock(async () => true)
    const service = createFeatureRequestService({
      payDonation: async () => ({
        status: 'failed',
        error: new Error('no funds'),
        reason: 'no_funds',
      }),
      notify,
      copyMessage,
      adminTelegramIds: [7],
      formatAdminMeta: formatFeatureRequestAdminMeta,
      log: {info: () => {}, warn: () => {}, error: () => {}, debug: () => {}} as never,
    })

    const result = await service.submit({
      userId: 1,
      source: {...source, text: 'Still send this'},
      amountSats: 100,
    })

    expect(result.fundStatus).toBe('pay_failed')
    expect(result.amountPaidSats).toBe(0)
    expect(notify).toHaveBeenCalled()
    expect(copyMessage).toHaveBeenCalled()
  })
})
