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

export function buildDonateHubKeyboard(t: BotContext['t']) {
  const keyboard = new InlineKeyboard()
  for (const amount of DONATE_PRESETS_SATS) {
    keyboard.row({
      callback_data: donateAmountRoute.build({amountSats: amount}),
      text: t('button.donate-amount', {sats: amount}),
    })
  }
  keyboard
    .row({
      callback_data: staticCallback.donateCustom,
      text: t('button.donate-custom'),
    })
    .row({
      callback_data: staticCallback.donateMonthlyMenu,
      text: t('button.donate-monthly'),
    })
    .row({
      callback_data: staticCallback.wallet,
      text: t('button.back'),
    })
  return keyboard
}

export function buildDonateMonthlyKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()
  for (const amount of DONATE_PRESETS_SATS) {
    keyboard.row({
      callback_data: donateMonthlyAmountRoute.build({amountSats: amount}),
      text: t('button.donate-amount', {sats: amount}),
    })
  }
  keyboard.row({
    callback_data: staticCallback.donateMonthlyCustom,
    text: t('button.donate-custom'),
  })
  if (user.monthlyDonationSats > 0) {
    keyboard.row({
      callback_data: staticCallback.donateMonthlyDisable,
      text: t('button.donate-monthly-disable'),
    })
  }
  keyboard.row({
    callback_data: staticCallback.donate,
    text: t('button.back'),
  })
  return keyboard
}

export function buildDonationSettingsKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()
  for (const percent of [0, 1, 5, 10] as const) {
    const mark = user.donationPercent === percent ? '✓ ' : ''
    keyboard.row({
      callback_data: donationPercentRoute.build({percent}),
      text: `${mark}${t('button.donation-percent', {percent})}`,
    })
  }
  keyboard.row({
    callback_data: staticCallback.donationCustomPercent,
    text: t('button.donation-custom-percent'),
  })

  const scope = user.donationScope as DonationScope
  const tipsMark = scope === 'tips' ? '✓ ' : ''
  const allMark = scope === 'all' ? '✓ ' : ''
  keyboard
    .row({
      callback_data: donationScopeRoute.build({scope: 'tips'}),
      text: `${tipsMark}${t('button.donation-scope-tips')}`,
    })
    .row({
      callback_data: donationScopeRoute.build({scope: 'all'}),
      text: `${allMark}${t('button.donation-scope-all')}`,
    })
    .row({
      callback_data: staticCallback.settings,
      text: t('button.back'),
    })

  return keyboard
}
