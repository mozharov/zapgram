import {FEATURE_FUND_PRESETS_SATS} from '@core/money/feature-request.js'
import {formatPresetSatsLabel} from '@modules/donations/telegram/keyboards/donate.js'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

/**
 * Optional funding after the user described a feature:
 * [Skip] [21] [100]
 * [1k] [10k] [100k]
 * [Cancel]
 *
 * There is no custom-amount button: any other amount is typed straight into the chat and the fund
 * step accepts it, so the board never has to hand the flow over to a separate prompt.
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
  keyboard.row({
    callback_data: staticCallback.cancel,
    text: t('button.cancel'),
  })
  return keyboard
}
