import {DONATE_PRESETS_SATS, type DonationScope} from '@core/money/donation.js'
import type {User} from '@infra/db/types.js'
import {
  donateAmountRoute,
  donateMonthlyAmountRoute,
  donationPercentRoute,
  donationScopeRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

/** Compact labels so several presets fit one Telegram row. */
export function formatPresetSatsLabel(sats: number): string {
  if (sats >= 1000 && sats % 1000 === 0) return `${sats / 1000}k`
  return String(sats)
}

/**
 * Unified support hub:
 * [21] [100] [1k]
 * [10k] [100k] [✏️]
 * [📅 Monthly] [⚡️ Auto %]
 * [⬅️ Wallet]
 */
export function buildDonateHubKeyboard(t: BotContext['t'], user?: User) {
  const keyboard = new InlineKeyboard()
  const presets = DONATE_PRESETS_SATS

  // 21 · 100 · 1k
  for (const amount of presets.slice(0, 3)) {
    keyboard.text(formatPresetSatsLabel(amount), donateAmountRoute.build({amountSats: amount}))
  }
  keyboard.row()
  // 10k · 100k · custom
  for (const amount of presets.slice(3)) {
    keyboard.text(formatPresetSatsLabel(amount), donateAmountRoute.build({amountSats: amount}))
  }
  keyboard.text(t('button.donate-custom-short'), staticCallback.donateCustom)
  keyboard.row()

  const monthlyLabel =
    user && user.monthlyDonationSats > 0
      ? t('button.donate-monthly-on', {sats: user.monthlyDonationSats})
      : t('button.donate-monthly')
  keyboard
    .text(monthlyLabel, staticCallback.donateMonthlyMenu)
    .text(t('button.donation-auto-percent'), staticCallback.donationSettings)
    .row({
      callback_data: staticCallback.wallet,
      text: t('button.back'),
    })

  return keyboard
}

/**
 * Monthly amounts — compact rows, back to hub.
 */
export function buildDonateMonthlyKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()
  const presets = DONATE_PRESETS_SATS

  for (const amount of presets.slice(0, 3)) {
    keyboard.text(
      formatPresetSatsLabel(amount),
      donateMonthlyAmountRoute.build({amountSats: amount}),
    )
  }
  keyboard.row()
  for (const amount of presets.slice(3)) {
    keyboard.text(
      formatPresetSatsLabel(amount),
      donateMonthlyAmountRoute.build({amountSats: amount}),
    )
  }
  keyboard.text(t('button.donate-custom-short'), staticCallback.donateMonthlyCustom)
  keyboard.row()

  if (user.monthlyDonationSats > 0) {
    keyboard.row({
      callback_data: staticCallback.donateMonthlyDisable,
      text: t('button.donate-monthly-disable'),
    })
  }
  keyboard.row({
    callback_data: staticCallback.donate,
    text: t('button.back-to-support'),
  })
  return keyboard
}

/**
 * Auto-% on tips/invoices — nested under the support hub.
 * [0%] [1%] [5%] [10%]
 * [✏️ Custom %]
 * [Tips only] [All payments]
 * [⬅️ Support hub]
 */
export function buildDonationSettingsKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()
  for (const percent of [0, 1, 5, 10] as const) {
    const mark = user.donationPercent === percent ? '✓' : ''
    keyboard.text(`${mark}${percent}%`, donationPercentRoute.build({percent}))
  }
  keyboard.row({
    callback_data: staticCallback.donationCustomPercent,
    text: t('button.donation-custom-percent'),
  })

  const scope = user.donationScope as DonationScope
  const tipsMark = scope === 'tips' ? '✓ ' : ''
  const allMark = scope === 'all' ? '✓ ' : ''
  keyboard
    .text(
      `${tipsMark}${t('button.donation-scope-tips')}`,
      donationScopeRoute.build({scope: 'tips'}),
    )
    .text(`${allMark}${t('button.donation-scope-all')}`, donationScopeRoute.build({scope: 'all'}))
    .row({
      callback_data: staticCallback.donate,
      text: t('button.back-to-support'),
    })

  return keyboard
}
