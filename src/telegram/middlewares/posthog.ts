import {captureBotError} from '@infra/posthog.js'
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
  resolveUpdateEventName,
  telegramChatGroups,
  telegramUserDistinctId,
} from '../analytics.js'

/**
 * PostHog context + one interaction event per bot-relevant update.
 * Event name is derived from the action (command_*, callback_*, …), not a flat telegram_update.
 *
 * Person profile fields piggyback as `$set` / `$set_once` on real captures — never via
 * `setPersonProperties()` / `$set` events, which clutter Activity with "Set person properties"
 * on every update (same pattern as to-notion-bot Tracker).
 *
 * Telegram person fields also sit on withContext so mid-update handler captures inherit a
 * display name without a dedicated identify. Chat group entities are updated only in chat
 * mutation handlers via setTelegramChatGroup.
 */
export const posthogMiddleware: Middleware<BotContext> = (ctx, next) => {
  const {posthog} = getRuntime()
  if (!posthog || !isBotRelevantUpdate(ctx)) return next()

  const from = ctx.from && !ctx.from.is_bot ? ctx.from : undefined
  const distinctId = from ? telegramUserDistinctId(from.id) : undefined
  const personFromTg = from ? personPropertiesFromTelegram(from) : undefined

  return posthog.withContext(
    {
      ...(distinctId ? {distinctId} : {}),
      // Inherited by captures that do not pass their own $set (shallow merge).
      ...(personFromTg ? {properties: personFromTg} : {}),
    },
    async () => {
      try {
        return await next()
      } catch (error) {
        // AppError → product event `app_error` (expected). Real bugs → $exception.
        captureBotError(posthog, error, distinctId)
        throw error
      } finally {
        // After next(): attachUser may have filled ctx.user for private / tip paths.
        const dbUser = dbUserFromContext(ctx)
        posthog.capture({
          event: resolveUpdateEventName(ctx),
          distinctId: distinctId ?? `chat:${ctx.chat?.id ?? 'unknown'}`,
          properties: {
            ...buildUpdateProperties(ctx),
            // Later patches win. Telegram `from` overwrites DB: attachUser refreshes the row
            // from Telegram, so stale DB snapshot must not clobber live profile fields.
            ...mergePersonProperties(
              dbUser ? personPropertiesFromDb(dbUser) : undefined,
              personFromTg,
            ),
            ...(!from ? {$process_person_profile: false} : {}),
          },
          groups:
            ctx.chat && ctx.chat.type !== 'private' ? telegramChatGroups(ctx.chat.id) : undefined,
        })
      }
    },
  )
}
