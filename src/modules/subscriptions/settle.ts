import {getRuntime} from '../../runtime.js'
import type {CompleteSubscriptionPaymentResult} from './settle.service.js'

/** Leaf-handler / job convenience — uses the bootstrap runtime. */
export function completeSubscriptionPayment(
  payment: Parameters<ReturnType<typeof getRuntime>['settleService']['complete']>[0],
): Promise<CompleteSubscriptionPaymentResult> {
  return getRuntime().settleService.complete(payment)
}

export type {CompleteSubscriptionPaymentResult}
