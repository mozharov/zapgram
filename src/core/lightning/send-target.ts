import {type PaymentRequest, recognizePaymentRequest} from './payment-request.js'

/** Telegram @username. A leading @ is never a Lightning address. */
const USERNAME = /^@([a-zA-Z0-9_]+)$/

export type SendTarget<T> =
  | PaymentRequest
  | {kind: 'user'; user: T}
  | {kind: 'self'}
  | {kind: 'unknown'}
  | {kind: 'invalid'}

/**
 * One classifier for the send wizard and the private transfer.
 * A Lightning invoice, address, or LNURL is recognized by `recognizePaymentRequest`.
 * `@username` is a ZapGram user only when `findUser` already has them and Telegram still
 * reports that username. Nothing here creates a wallet. Sending to yourself is `self`.
 */
export async function classifySendTarget<T extends {id: number; username: string | null}>(
  text: string,
  deps: {
    selfUsername: string | null | undefined
    findUser: (username: string) => Promise<T | null | undefined>
    telegramUsername: (userId: number) => Promise<string | null | undefined>
  },
): Promise<SendTarget<T>> {
  const payment = recognizePaymentRequest(text)
  if (payment) return payment

  const username = USERNAME.exec(text.trim())?.[1]?.toLowerCase()
  if (!username) return {kind: 'invalid'}
  if (username === deps.selfUsername?.toLowerCase()) return {kind: 'self'}

  const user = await deps.findUser(username)
  if (!user?.id) return {kind: 'unknown'}
  const telegramName = (await deps.telegramUsername(user.id))?.toLowerCase()
  if (telegramName !== username) return {kind: 'unknown'}
  return {kind: 'user', user}
}
