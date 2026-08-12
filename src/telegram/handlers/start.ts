import {buildStartKeyboard} from '@modules/wallet/telegram/keyboards/start.js'
import {
  mergePersonProperties,
  parseLandingStartPayload,
  personPropertiesFromDb,
  personPropertiesFromTelegram,
  telegramUserDistinctId,
} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'

export async function startCommand(ctx: BotContext) {
  const {posthog} = getRuntime()
  const startPayload = typeof ctx.match === 'string' && ctx.match.length > 0 ? ctx.match : undefined
  const {fromLanding, landingDistinctId} = parseLandingStartPayload(startPayload)

  if (posthog && ctx.from) {
    const distinctId = telegramUserDistinctId(ctx.from.id)

    // Merge anonymous landing person into the Telegram user when CTA carried lp_<id>.
    if (landingDistinctId && landingDistinctId !== distinctId) {
      posthog.alias({distinctId, alias: landingDistinctId})
    }

    posthog.capture({
      event: 'bot_started',
      distinctId,
      properties: {
        start_param: startPayload ?? null,
        from_landing: fromLanding,
        ...mergePersonProperties(
          personPropertiesFromDb(ctx.user),
          personPropertiesFromTelegram(ctx.from),
          fromLanding
            ? {
                $set: {acquisition_source: 'landing'},
                $set_once: {initial_acquisition_source: 'landing'},
              }
            : undefined,
        ),
      },
    })
  }

  await ctx.reply(ctx.t('start'), {
    reply_markup: buildStartKeyboard(ctx.t),
    link_preview_options: {is_disabled: true},
  })
}
