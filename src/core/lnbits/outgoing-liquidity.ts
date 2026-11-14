/**
 * Whether the LNbits funding source can cover one outgoing payment.
 * Amount and fee reserve are millisatoshis. A non-integer or negative input does not cover.
 */
export function backendCoversOutgoingPayment(input: {
  balanceMsat: number
  amountMsat: number
  feeReserveMsat: number
}): boolean {
  const {balanceMsat, amountMsat, feeReserveMsat} = input
  if (!isMsat(balanceMsat) || !isMsat(amountMsat) || !isMsat(feeReserveMsat)) return false
  if (amountMsat <= 0) return false
  const needed = amountMsat + feeReserveMsat
  if (!Number.isSafeInteger(needed)) return false
  return balanceMsat >= needed
}

function isMsat(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
