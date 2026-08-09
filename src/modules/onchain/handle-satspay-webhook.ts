import {getRuntime} from '../../runtime.js'
import type {CompleteOnchainResult} from './complete.service.js'

/**
 * SatsPay call_webhook posts `json=charge.json()` — often a double-encoded JSON string
 * (same family of bug as core LNbits payment webhooks). Accept object or string body.
 */
export function extractSatsPayChargeFromWebhook(body: unknown): {
  id: string
  paid: boolean
  extra?: string | null
  amount?: number
} | null {
  const record = coerceJsonObject(body)
  if (!record) return null
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  const paid = record.paid === true
  return {
    id: record.id,
    paid,
    extra: typeof record.extra === 'string' ? record.extra : null,
    amount: typeof record.amount === 'number' ? record.amount : undefined,
  }
}

export async function handleSatsPayWebhook(
  body: unknown,
): Promise<CompleteOnchainResult | 'ignored'> {
  const charge = extractSatsPayChargeFromWebhook(body)
  if (!charge) return 'ignored'
  if (!charge.paid) return 'ignored'

  return getRuntime().completeOnchainJoin.completeFromCharge({
    chargeId: charge.id,
    paid: charge.paid,
    extra: charge.extra,
    amount: charge.amount,
  })
}

function coerceJsonObject(body: unknown): Record<string, unknown> | undefined {
  let value: unknown = body
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    try {
      value = JSON.parse(trimmed) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
