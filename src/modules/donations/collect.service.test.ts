import {describe, expect, mock, test} from 'bun:test'
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
  const service = createDonationCollectService({
    payService: {payToFeeCollection},
    insertDonation,
    getUser: mock(async () => user as never),
    notifyDonationFailed,
    log: {error: mock(() => {}), info: mock(() => {})} as never,
  })
  return {service, payToFeeCollection, insertDonation, notifyDonationFailed, user}
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

  test('notifies on pay failure and never throws', async () => {
    const payToFeeCollection = mock(async () => ({
      status: 'failed' as const,
      error: new Error('nope'),
      reason: 'no_funds' as const,
    }))
    const {service, notifyDonationFailed, insertDonation} = makeCollect({payToFeeCollection})
    const result = await service.tryCollect({
      userId: 1,
      baseAmountSats: 100,
      kind: 'tip',
      preferredRail: 'internal',
    })
    expect(result.status).toBe('failed')
    expect(notifyDonationFailed).toHaveBeenCalledWith(1, 5, 'en')
    expect(insertDonation).not.toHaveBeenCalled()
  })
})
