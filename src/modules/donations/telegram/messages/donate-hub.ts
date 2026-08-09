import type {User} from '@infra/db/types.js'
import type {PlatformDonationStats, UserDonationStats} from '@modules/donations/repository.js'
import type {BotContext} from '@telegram/context.js'

export function formatDonateHubText(
  t: BotContext['t'],
  user: User,
  stats: UserDonationStats,
  platform: PlatformDonationStats,
): string {
  const monthlyStatus =
    user.monthlyDonationSats > 0
      ? t('donate.monthly-status-on', {sats: user.monthlyDonationSats})
      : t('donate.monthly-status-off')

  const last =
    stats.lastAt != null
      ? t('donate.stats-last', {date: stats.lastAt.toISOString().slice(0, 10)})
      : t('donate.stats-last-none')

  return t('donate.hub', {
    totalSats: stats.totalSats,
    count: stats.count,
    last,
    monthlyStatus,
    platformTotalSats: platform.totalSats,
    platformLastMonthSats: platform.lastMonthSats,
  })
}

export function formatDonationSettingsText(t: BotContext['t'], user: User): string {
  const percentLabel =
    user.donationPercent === 0
      ? t('settings-donation.off')
      : t('settings-donation.percent', {percent: user.donationPercent})
  const scopeLabel =
    user.donationScope === 'tips'
      ? t('settings-donation.scope-tips')
      : t('settings-donation.scope-all')
  return t('settings-donation', {status: percentLabel, scope: scopeLabel})
}
