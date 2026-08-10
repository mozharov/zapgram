import {FEATURE_FUND_PRESETS_SATS} from '@core/money/feature-request.js'
import {formatPresetSatsLabel} from '@modules/donations/telegram/keyboards/donate.js'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

/**
 * Optional funding after the user described a feature:
 * [Skip] [21] [100]
 * [1k] [10k] [100k] [✏️]
 * [Cancel]
 */
export function buildFeatureFundKeyboard(t: BotContext['t']) {
  const keyboard = new InlineKeyboard()
  keyboard.text(t('button.feature-fund-skip'), staticCallback.featureFundSkip)
  for (const amount of FEATURE_FUND_PRESETS_SATS.slice(0, 2)) {
    keyboard.text(formatPresetSatsLabel(amount), featureFundAmountRoute.build({amountSats: amount}))
  }
  keyboard.row()
  for (const amount of FEATURE_FUND_PRESETS_SATS.slice(2)) {
    keyboard.text(formatPresetSatsLabel(amount), featureFundAmountRoute.build({amountSats: amount}))
  }
  keyboard.text(t('button.feature-fund-custom-short'), staticCallback.featureFundCustom)
  keyboard.row({
    callback_data: staticCallback.cancel,
    text: t('button.cancel'),
  })
  return keyboard
}
