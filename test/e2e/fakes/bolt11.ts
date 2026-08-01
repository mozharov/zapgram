import {randomBytes} from 'node:crypto'
import {encode, sign} from 'bolt11'

const TEST_PRIVKEY = '11'.repeat(32)
const DEFAULT_EXPIRY_SEC = 60 * 60

export type MintedInvoice = {
  bolt11: string
  paymentHash: string
  sats: number
  description: string
}

/** Настоящий подписанный bolt11: сумма/описание/expiry реально декодируются. */
export function mintInvoice({
  sats,
  description = '',
  expirySec = DEFAULT_EXPIRY_SEC,
}: {
  sats: number
  description?: string
  expirySec?: number
}): MintedInvoice {
  const paymentHash = randomBytes(32).toString('hex')
  const encoded = encode({
    satoshis: sats,
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      {tagName: 'payment_hash', data: paymentHash},
      {tagName: 'description', data: description},
      {tagName: 'expire_time', data: expirySec},
      {tagName: 'min_final_cltv_expiry', data: 18},
    ],
  })
  const bolt11 = sign(encoded, TEST_PRIVKEY).paymentRequest

  if (!bolt11) throw new Error('bolt11 did not produce a payment request')

  return {bolt11, paymentHash, sats, description}
}
