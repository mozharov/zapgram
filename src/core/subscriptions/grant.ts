import {computeSubscriptionEndsAt, type SubscriptionPaymentType} from './policy.js'

/** Minimal subscription shape used by grant logic (persistence-agnostic). */
export type GrantSubscription = {
  id: string
  userId: number
  chatId: number
  price: number
  endsAt: Date | null
  notificationSent: boolean
}

/** Minimal payment shape used by grant logic (persistence-agnostic). */
export type GrantPayment = {
  id: string
  userId: number
  chatId: number
  price: number
  paymentHash: string
  subscriptionType: SubscriptionPaymentType
  settledAt: Date | null
}

export type GrantSubscriptionAccessDeps = {
  getSubscriptionByUserAndChat: (
    userId: number,
    chatId: number,
  ) => GrantSubscription | null | undefined
  createSubscription: (data: {
    userId: number
    chatId: number
    price: number
    endsAt: Date | null
  }) => void
  updateSubscription: (
    id: string,
    data: Partial<Pick<GrantSubscription, 'price' | 'endsAt' | 'notificationSent'>>,
  ) => void
  markPaymentSettled: (paymentId: string, settledAt: Date) => void
  log: {info: (obj: unknown, msg?: string) => void}
}

/**
 * Create or extend a subscription exactly once per payment, stamping `settledAt` in the same step.
 *
 * Deliberately synchronous: bun-sqlite transactions commit as soon as the callback returns, so an
 * `await` in here would push the remaining writes outside the transaction and reopen the
 * double-extend window this guard exists to close. Callers pass tx-bound deps; tests pass fakes.
 */
export function grantSubscriptionAccessIfNeeded(
  payment: GrantPayment,
  deps: GrantSubscriptionAccessDeps,
  now: Date = new Date(),
): 'granted' | 'already_settled' {
  if (payment.settledAt) {
    deps.log.info(
      {paymentHash: payment.paymentHash},
      'Subscription access already granted for this payment; skipping grant',
    )
    return 'already_settled'
  }

  const subscription = deps.getSubscriptionByUserAndChat(payment.userId, payment.chatId)
  if (subscription) {
    const endsAt = computeSubscriptionEndsAt({
      subscriptionType: payment.subscriptionType,
      existingEndsAt: subscription.endsAt,
      now,
    })
    deps.updateSubscription(subscription.id, {
      price: payment.price,
      endsAt,
      notificationSent: false,
    })
  } else {
    deps.createSubscription({
      userId: payment.userId,
      chatId: payment.chatId,
      price: payment.price,
      endsAt: computeSubscriptionEndsAt({
        subscriptionType: payment.subscriptionType,
        existingEndsAt: null,
        now,
      }),
    })
  }

  deps.markPaymentSettled(payment.id, now)
  return 'granted'
}
