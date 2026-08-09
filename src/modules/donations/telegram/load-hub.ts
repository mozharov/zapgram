import type {PlatformDonationStats, UserDonationStats} from '@modules/donations/repository.js'
import {getRuntime} from '../../../runtime.js'

/** User + platform stats for the /donate hub (parallel reads). */
export async function loadDonateHubStats(
  userId: number,
): Promise<{user: UserDonationStats; platform: PlatformDonationStats}> {
  const {donations} = getRuntime()
  const [user, platform] = await Promise.all([
    donations.getUserStats(userId),
    donations.getPlatformStats(),
  ])
  return {user, platform}
}
