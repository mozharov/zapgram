import {describe, expect, test} from 'bun:test'
import {backendCoversOutgoingPayment} from './outgoing-liquidity.js'

describe('backendCoversOutgoingPayment', () => {
  test('a zero backend does not cover a positive payment', () => {
    expect(
      backendCoversOutgoingPayment({balanceMsat: 0, amountMsat: 21_000, feeReserveMsat: 2_000}),
    ).toBe(false)
  })

  test('balance equal to amount plus fee reserve covers the payment', () => {
    expect(
      backendCoversOutgoingPayment({
        balanceMsat: 23_000,
        amountMsat: 21_000,
        feeReserveMsat: 2_000,
      }),
    ).toBe(true)
  })

  test('one millisatoshi short does not cover the payment', () => {
    expect(
      backendCoversOutgoingPayment({
        balanceMsat: 22_999,
        amountMsat: 21_000,
        feeReserveMsat: 2_000,
      }),
    ).toBe(false)
  })

  test('a zero fee reserve still requires the invoice amount', () => {
    expect(
      backendCoversOutgoingPayment({balanceMsat: 21_000, amountMsat: 21_000, feeReserveMsat: 0}),
    ).toBe(true)
    expect(
      backendCoversOutgoingPayment({balanceMsat: 20_999, amountMsat: 21_000, feeReserveMsat: 0}),
    ).toBe(false)
  })

  test('non-integers and a non-positive amount do not cover', () => {
    expect(
      backendCoversOutgoingPayment({balanceMsat: 10, amountMsat: 1.5, feeReserveMsat: 0}),
    ).toBe(false)
    expect(backendCoversOutgoingPayment({balanceMsat: -1, amountMsat: 1, feeReserveMsat: 0})).toBe(
      false,
    )
    expect(backendCoversOutgoingPayment({balanceMsat: 10, amountMsat: 0, feeReserveMsat: 0})).toBe(
      false,
    )
  })
})
