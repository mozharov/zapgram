import type {BotContext} from '@telegram/context.js'
import type {Middleware} from 'grammy'
import {getRuntime} from '../../runtime.js'
import {
  buildUpdateProperties,
  dbUserFromContext,
  isBotRelevantUpdate,
  mergePersonProperties,
  personPropertiesFromDb,
  personPropertiesFromTelegram,
  telegramChatGroups,
  telegramUserDistinctId,
} from '../analytics.js'

/**
 * PostHog context + one `telegram_update` per bot-relevant update.
 * Person profile fields go on the event as `$set` / `$set_once` (no separate identify).
 * Chat group entities are updated only in chat mutation handlers via setTelegramChatGroup.
 */
export const posthogMiddleware: Middleware<BotContext> = (ctx, next) => {
  const {posthog} = getRuntime()
  if (!posthog || !isBotRelevantUpdate(ctx)) return next()

  const from = ctx.from && !ctx.from.is_bot ? ctx.from : undefined
  const distinctId = from ? telegramUserDistinctId(from.id) : undefined

  return posthog.withContext(distinctId ? {distinctId} : {}, async () => {
    try {
      return await next()
    } catch (error) {
      posthog.captureException(error)
      throw error
    } finally {
      // After next(): attachUser may have filled ctx.user for private / tip paths.
      const dbUser = dbUserFromContext(ctx)
      posthog.capture({
        event: 'telegram_update',
        distinctId: distinctId ?? `chat:${ctx.chat?.id ?? 'unknown'}`,
        properties: {
          ...buildUpdateProperties(ctx),
          // Later patches win. Telegram `from` overwrites DB: attachUser refreshes the row
          // from Telegram, so stale DB snapshot must not clobber live profile fields.
          ...mergePersonProperties(
            dbUser ? personPropertiesFromDb(dbUser) : undefined,
            from ? personPropertiesFromTelegram(from) : undefined,
          ),
          ...(!from ? {$process_person_profile: false} : {}),
        },
        groups:
          ctx.chat && ctx.chat.type !== 'private' ? telegramChatGroups(ctx.chat.id) : undefined,
      })
    }
  })
}
