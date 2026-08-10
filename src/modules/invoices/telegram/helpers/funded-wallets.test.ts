import {describe, expect, test} from 'bun:test'
import {fundedWalletsForAmount} from './funded-wallets.js'

describe('fundedWalletsForAmount', () => {
  test('marks wallets funded when balance covers the amount in msats', () => {
    expect(
      fundedWalletsForAmount({internalMsats: 21_000, nwcMsats: 20_000, nwcBalanceError: false}, 21),
    ).toEqual({internal: true, nwc: false, nwcBalanceError: false})
  })

  test('treats null NWC balance as not funded', () => {
    expect(
      fundedWalletsForAmount({internalMsats: 0, nwcMsats: null, nwcBalanceError: true}, 1),
    ).toEqual({internal: false, nwc: false, nwcBalanceError: true})
  })

  test('both funded when both cover required sats', () => {
    expect(
      fundedWalletsForAmount(
        {internalMsats: 100_000, nwcMsats: 100_000, nwcBalanceError: false},
        50,
      ),
    ).toEqual({internal: true, nwc: true, nwcBalanceError: false})
  })
})
