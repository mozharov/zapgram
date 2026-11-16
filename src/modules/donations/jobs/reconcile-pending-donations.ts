import {getRuntime} from '../../../runtime.js'

export async function reconcilePendingDonations(now = new Date()): Promise<void> {
  await getRuntime().pendingDonations.reconcileAll(now)
}
