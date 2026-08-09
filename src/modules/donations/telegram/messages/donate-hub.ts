import type {User} from '@infra/db/types.js'
import type {PlatformDonationStats, UserDonationStats} from '@modules/donations/repository.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'

export async function formatDonateHubText(
  t: BotContext['t'],
  user: User,
  stats: UserDonationStats,
  platform: PlatformDonationStats,
): Promise<string> {
  const [
    totalUsdSuffix = '',
    platformTotalUsdSuffix = '',
    platformLastMonthUsdSuffix = '',
    monthlyUsdSuffix = '',
  ] = await usdSuffixesForSats([
    stats.totalSats,
    platform.totalSats,
    platform.lastMonthSats,
    user.monthlyDonationSats,
  ])

  const monthlyStatus =
    user.monthlyDonationSats > 0
      ? t('donate.monthly-status-on', {
          sats: user.monthlyDonationSats,
          usdSuffix: monthlyUsdSuffix,
        })
      : t('donate.monthly-status-off')

  const last =
    stats.lastAt != null
      ? t('donate.stats-last', {date: stats.lastAt.toISOString().slice(0, 10)})
      : t('donate.stats-last-none')

  const autoPercent =
    user.donationPercent === 0
      ? t('donate.auto-off')
      : t('donate.auto-on', {percent: user.donationPercent})
  const autoScope =
    user.donationScope === 'tips' ? t('donate.auto-scope-tips') : t('donate.auto-scope-all')

  return t('donate.hub', {
    totalSats: stats.totalSats,
    totalUsdSuffix,
    count: stats.count,
    last,
    monthlyStatus,
    platformTotalSats: platform.totalSats,
    platformTotalUsdSuffix,
    platformLastMonthSats: platform.lastMonthSats,
    platformLastMonthUsdSuffix,
    autoPercent,
    autoScope,
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
