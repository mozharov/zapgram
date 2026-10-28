import {describe, expect, mock, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {createDonationCollectService} from './collect.service.js'

function makeCollect(
  overrides: {
    user?: {
      donationPercent: number
      donationScope: 'tips' | 'all'
      languageCode: string
      nwcUrl: string | null
    }
    payResult?: Awaited<
      ReturnType<ReturnType<typeof createDonationCollectService> extends never ? never : never>
    >
    payToFeeCollection?: ReturnType<typeof mock>
  } = {},
) {
  const user = overrides.user ?? {
    donationPercent: 5,
    donationScope: 'all' as const,
    languageCode: 'en',
    nwcUrl: null,
  }
  const payToFeeCollection =
    overrides.payToFeeCollection ??
    mock(async () => ({
      status: 'paid' as const,
      paymentHash: 'h',
      rail: 'internal' as const,
    }))
  const insertDonation = mock(async () => ({}))
  const notifyDonationFailed = mock(async () => undefined)
  const capture = mock(() => undefined)
  const captureException = mock(() => undefined)
  const service = createDonationCollectService({
    payService: {payToFeeCollection},
    insertDonation,
    getUser: mock(async () => user as never),
    notifyDonationFailed,
    log: {error: mock(() => {}), info: mock(() => {})} as never,
    posthog: {capture, captureException} as never,
  })
  return {
    service,
    payToFeeCollection,
    insertDonation,
    notifyDonationFailed,
    capture,
    captureException,
    user,
  }
}

describe('tryCollect', () => {
  test('skips when percent is 0', async () => {
    const {service, payToFeeCollection} = makeCollect({
      user: {donationPercent: 0, donationScope: 'all', languageCode: 'en', nwcUrl: null},
    })
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result).toEqual({status: 'skipped', reason: 'off'})
    expect(payToFeeCollection).not.toHaveBeenCalled()
  })

  test('skips invoice when scope is tips', async () => {
    const {service, payToFeeCollection} = makeCollect({
      user: {donationPercent: 5, donationScope: 'tips', languageCode: 'en', nwcUrl: null},
    })
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'invoice',
      preferredRail: 'internal',
    })
    expect(result).toEqual({status: 'skipped', reason: 'scope'})
    expect(payToFeeCollection).not.toHaveBeenCalled()
  })

  test('collects 5% of tip and inserts ledger silently', async () => {
    const {service, insertDonation, notifyDonationFailed} = makeCollect()
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result.status).toBe('collected')
    if (result.status === 'collected') expect(result.amountSats).toBe(5)
    expect(insertDonation).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'percent', amountSats: 5}),
    )
    expect(notifyDonationFailed).not.toHaveBeenCalled()
  })

  test('no_funds keeps donation_failed and skips exception and user notice', async () => {
    const payToFeeCollection = mock(async () => ({
      status: 'failed' as const,
      error: new Error('insufficient funds'),
      reason: 'no_funds' as const,
    }))
    const {service, notifyDonationFailed, insertDonation, capture, captureException} = makeCollect({
      payToFeeCollection,
    })
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result.status).toBe('failed')
    expect(notifyDonationFailed).not.toHaveBeenCalled()
    expect(insertDonation).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'donation_failed',
        distinctId: '1',
        properties: expect.objectContaining({reason: 'no_funds', status: 'failed'}),
      }),
    )
  })

  test('insufficient-funds error is not an exception even if the rail said pay_failed', async () => {
    const payToFeeCollection = mock(async () => ({
      status: 'failed' as const,
      error: new InsufficientFundsError(),
      reason: 'pay_failed' as const,
    }))
    const {service, notifyDonationFailed, captureException, capture} = makeCollect({
      payToFeeCollection,
    })
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 20,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result.status).toBe('failed')
    expect(notifyDonationFailed).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'donation_failed',
        properties: expect.objectContaining({reason: 'pay_failed', status: 'failed'}),
      }),
    )
  })

  test('other pay failures notify the user and capture an exception', async () => {
    const error = new Error('lnbits down')
    const payToFeeCollection = mock(async () => ({
      status: 'failed' as const,
      error,
      reason: 'pay_failed' as const,
    }))
    const {service, notifyDonationFailed, insertDonation, captureException} = makeCollect({
      payToFeeCollection,
    })
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result.status).toBe('failed')
    expect(notifyDonationFailed).toHaveBeenCalledWith(1, 5, 'en')
    expect(insertDonation).not.toHaveBeenCalled()
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      error,
      '1',
      expect.objectContaining({stage: 'try_collect_pay', expected: false}),
    )
  })
})
