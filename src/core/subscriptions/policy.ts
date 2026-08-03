/** 30 days in ms. */
export const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000

export type SubscriptionPaymentType = 'one_time' | 'monthly'

/** New endsAt after a successful subscription payment. */
export function computeSubscriptionEndsAt(args: {
  subscriptionType: SubscriptionPaymentType
  existingEndsAt: Date | null | undefined
  now: Date
}): Date | null {
  if (args.subscriptionType === 'one_time') return null

  if (args.existingEndsAt && args.existingEndsAt > args.now) {
    return new Date(args.existingEndsAt.getTime() + ONE_MONTH_IN_MS)
  }
  return new Date(args.now.getTime() + ONE_MONTH_IN_MS)
}
