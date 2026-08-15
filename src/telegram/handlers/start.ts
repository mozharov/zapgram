import {buildStartKeyboard} from '@modules/wallet/telegram/keyboards/start.js'
import {
  mergePersonProperties,
  parseLandingStartPayload,
  personPropertiesFromDb,
  personPropertiesFromTelegram,
  telegramUserDistinctId,
} from '@telegram/analytics.js'
import type {BaseContext, BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {getRuntime} from '../../runtime.js'

/**
 * Telegram auto-sends `/start@botusername` into a group when it's added via the "Add to Group"
 * menu button. There is nothing for the bot to do with it — just remove the noise. Registered
 * with `is_ephemeral: true` (configure-bot.ts) so it's invisible to the rest of the group even
 * before this delete lands.
 */
export async function startGroupCommand(ctx: BaseContext): Promise<void> {
  await deleteMessageSafely(ctx)
}

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

  await showLivingMenu(ctx, () =>
    ctx.replyWithRichMessage(
      {html: ctx.t('start')},
      {
        reply_markup: buildStartKeyboard(ctx.t),
      },
    ),
  )
}
