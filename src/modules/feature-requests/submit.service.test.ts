import {describe, expect, mock, test} from 'bun:test'
import {donationPayHarness} from '../donations/pay.test-support.js'
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

    expect(result).toEqual({
      fundStatus: 'skipped',
      amountPaidSats: 0,
      adminNotified: 2,
      sendPaused: false,
    })
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

test('pending funding submits with explicit waiting status and no failed/free claim', async () => {
  const notify = mock(async () => true)
  const warn = mock(() => {})
  const payDonation = mock(async () => ({
    status: 'pending' as const,
    paymentHash: 'pending-feature',
    expiresAt: new Date(),
    error: new Error('timeout'),
  }))
  const capture = mock(() => {})
  const service = createFeatureRequestService({
    payDonation,
    notify,
    copyMessage: async () => true,
    adminTelegramIds: [7],
    formatAdminMeta: formatFeatureRequestAdminMeta,
    log: {info: () => {}, warn, error: () => {}, debug: () => {}} as never,
    posthog: {capture, captureException: () => {}} as never,
  })
  const result = await service.submit({userId: 1, source, amountSats: 21})
  expect(result).toMatchObject({fundStatus: 'pending', amountPaidSats: 0, sendPaused: false})
  expect(payDonation).toHaveBeenCalledWith(
    expect.objectContaining({kind: 'one_shot', pendingKind: 'feature_request'}),
  )
  expect(notify).toHaveBeenCalledWith(7, expect.stringContaining('awaiting payment confirmation'))
  expect(notify).not.toHaveBeenCalledWith(7, expect.stringMatching(/failed|still free|Fund: none/))
  expect(warn).not.toHaveBeenCalled()
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'feature_requested',
      properties: expect.objectContaining({fund_status: 'pending'}),
    }),
  )
})

for (const cronFirst of [false, true]) {
  test(`request B cannot consume paid funding of A (cron already closed A: ${cronFirst})`, async () => {
    const h = donationPayHarness()
    h.uncertain()
    const payDonation = mock(h.service.payDonation)
    const submit = createFeatureRequestService({
      payDonation,
      notify: async () => true,
      copyMessage: async () => true,
      adminTelegramIds: [],
      formatAdminMeta: formatFeatureRequestAdminMeta,
      log: h.log,
    }).submit
    const input = {userId: 1, source, amountSats: 50, nwc: {payInvoice: h.payInvoice} as never}
    expect(await submit(input)).toMatchObject({fundStatus: 'pending', amountPaidSats: 0})
    const paymentA = payDonation.mock.calls[0]?.[0]
    if (!paymentA) throw new Error('Missing payment attempt A')
    const attemptA = paymentA.attemptId
    expect(attemptA).toEqual(expect.any(String))
    expect(h.rows.get('new-1')?.attemptId).toBe(attemptA)
    h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
    if (cronFirst) await h.pending.reconcileAll()
    // B has no spendable funds. A's paid hash must never turn B into a funded request.
    h.insufficient()
    h.deps.getUserWallet = async () => ({balance: 0, payInvoice: h.payInvoice})
    expect(
      await submit({...input, source: {...source, messageId: source.messageId + 1}}),
    ).toMatchObject({fundStatus: 'pay_failed', amountPaidSats: 0})
    const attemptB = payDonation.mock.calls[1]?.[0].attemptId
    expect(attemptB).toEqual(expect.any(String))
    expect(attemptB).not.toBe(attemptA)
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    expect(h.payInvoice).toHaveBeenCalledTimes(2)
    await h.pending.reconcileAll()
    await h.pending.reconcileAll()
    expect([...h.ledger.keys()]).toEqual(['new-1'])
    // The original attempt remains recoverable after cron removed its pending row.
    expect(await h.service.payDonation(paymentA)).toMatchObject({
      status: 'paid',
      rail: 'recovered',
      paymentHash: 'new-1',
    })
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    expect(h.ledger.size).toBe(1)
  })
}

test('the same feature attempt reuses its pending hash while a different attempt can pay independently', async () => {
  const h = donationPayHarness()
  h.uncertain()
  const input = {
    userId: 1,
    amountSats: 50,
    kind: 'one_shot' as const,
    pendingKind: 'feature_request' as const,
    attemptId: 'a',
    rail: 'nwc' as const,
    nwc: {payInvoice: h.payInvoice} as never,
  }
  const first = await h.service.payDonation(input)
  expect(first).toMatchObject({status: 'pending', paymentHash: 'new-1'})
  expect(await h.service.payDonation(input)).toMatchObject({
    status: 'pending',
    paymentHash: 'new-1',
  })
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  h.payInvoice.mockResolvedValue({})
  expect(await h.service.payDonation({...input, attemptId: 'b'})).toMatchObject({
    status: 'paid',
    paymentHash: 'new-2',
  })
  expect(h.rows.get('new-1')?.attemptId).toBe('a')
  expect(h.ledger.get('new-2')?.attemptId).toBe('b')
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
})

test('double submit of the same source shares funding, admin delivery and result', async () => {
  const h = donationPayHarness()
  const payDonation = mock(h.service.payDonation)
  const notify = mock(async () => true)
  const copyMessage = mock(async () => true)
  const service = createFeatureRequestService({
    payDonation,
    notify,
    copyMessage,
    adminTelegramIds: [7],
    formatAdminMeta: formatFeatureRequestAdminMeta,
    log: h.log,
  })
  const input = {userId: 1, source, amountSats: 50}
  const first = service.submit(input)
  const second = service.submit(input)
  expect(first).toBe(second)
  expect(await first).toBe(await second)
  expect(payDonation).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(copyMessage).toHaveBeenCalledTimes(1)
})

test('a later feature request does not inherit recovered funding from a previous attempt', async () => {
  const h = donationPayHarness()
  h.uncertain()
  const sourceA = {chatId: 1, messageId: 10, text: 'Idea A'}
  const sourceB = {chatId: 1, messageId: 11, text: 'Idea B'}
  const service = createFeatureRequestService({
    payDonation: h.service.payDonation,
    notify: async () => true,
    copyMessage: async () => true,
    adminTelegramIds: [7],
    formatAdminMeta: formatFeatureRequestAdminMeta,
    log: h.log,
  })
  expect(await service.submit({userId: 1, source: sourceA, amountSats: 50})).toMatchObject({
    fundStatus: 'pending',
    amountPaidSats: 0,
  })
  const [row] = [...h.rows.values()]
  if (!row) throw new Error('Missing pending funding for A')
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  expect(
    await h.service.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'one_shot',
      pendingKind: 'feature_request',
      attemptId: row.attemptId ?? undefined,
    }),
  ).toMatchObject({status: 'paid', rail: 'recovered', paymentHash: row.paymentHash})
  h.payInvoice.mockResolvedValue({})
  const second = await service.submit({userId: 1, source: sourceB, amountSats: 21})
  expect(second).toMatchObject({fundStatus: 'paid', amountPaidSats: 21})
  expect(second).not.toMatchObject({amountPaidSats: 50})
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
  expect([...h.ledger.values()].map(row => row.amountSats).sort((a, b) => a - b)).toEqual([21, 50])
  expect(h.ledger.get(row.paymentHash)?.attemptId).toBe(row.attemptId)
})
