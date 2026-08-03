import {randomBytes} from 'node:crypto'
import {decode, encode, sign} from 'bolt11'

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
  timestampSec = Math.floor(Date.now() / 1000),
}: {
  sats: number
  description?: string
  expirySec?: number
  /** Issue time. Backdate it past `expirySec` to mint an invoice that is already expired. */
  timestampSec?: number
}): MintedInvoice {
  const paymentHash = randomBytes(32).toString('hex')
  const encoded = encode({
    satoshis: sats,
    timestamp: timestampSec,
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

export type DecodedInvoice = {paymentHash: string; amountMsat: number; description: string}

/**
 * Разбор произвольного bolt11 — в том числе выпущенного не фейком. Настоящий LNbits тоже умеет
 * работать с чужими инвойсами: он декодирует строку, а не ищет её у себя в реестре.
 */
export function decodeMintedInvoice(paymentRequest: string): DecodedInvoice | undefined {
  try {
    const decoded = decode(paymentRequest)
    const paymentHash = decoded.tags.find(tag => tag.tagName === 'payment_hash')?.data
    if (typeof paymentHash !== 'string' || decoded.millisatoshis === null) return undefined

    const description = decoded.tags.find(tag => tag.tagName === 'description')?.data
    return {
      paymentHash,
      amountMsat: Number(decoded.millisatoshis),
      description: typeof description === 'string' ? description : '',
    }
  } catch {
    return undefined
  }
}
