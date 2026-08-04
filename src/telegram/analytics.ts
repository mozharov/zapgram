import type {Chat as DbChat, User as DbUser} from '@infra/db/types.js'
import {
  captureUserEvent,
  type CaptureClient as PostHogCaptureClient,
  TELEGRAM_CHAT_GROUP_TYPE,
  telegramChatGroupKey,
  telegramChatGroups,
  telegramUserDistinctId,
} from '@infra/posthog.js'
import type {Context} from 'grammy'
import type {User as TgUser} from 'grammy/types'
import type {PostHog} from 'posthog-node'

export {TELEGRAM_CHAT_GROUP_TYPE, telegramChatGroups, telegramUserDistinctId}

/** Telegram /start payload prefix for landing → bot attribution (`lp_<web_distinct_id>`). */
export const LANDING_START_PREFIX = 'lp_' as const

type CaptureClient = Pick<PostHog, 'capture' | 'groupIdentify' | 'alias'> & PostHogCaptureClient

type PersonPropertyPatch = {
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
}

/**
 * Group / channel updates that affect the bot.
 * Unrelated group chatter is dropped even if Telegram delivers it (privacy off).
 */
export function isBotRelevantUpdate(ctx: Context): boolean {
  if (ctx.from?.is_bot) return false

  const chatType = ctx.chat?.type
  if (!chatType || chatType === 'private') return Boolean(ctx.from)

  if (ctx.myChatMember) return true
  if (ctx.chatJoinRequest) return true
  if (ctx.callbackQuery) return true
  if (ctx.message?.new_chat_title !== undefined) return true

  const text = ctx.message?.text ?? ctx.message?.caption
  if (text) {
    if (text.startsWith('/')) return true
    const botUsername = ctx.me?.username
    if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true
  }

  if (ctx.message?.reply_to_message?.from?.id === ctx.me.id) return true

  return false
}

/**
 * Person fields from Telegram `from` — apply via event `$set` / `$set_once`, not identify().
 * `name` and `$name` are both set: PostHog person display name checks either, and we want
 * a stable human label ahead of distinct_id (Telegram user id) for every event on that person.
 */
export function personPropertiesFromTelegram(from: TgUser): PersonPropertyPatch {
  const name =
    [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id)

  return {
    $set: {
      // Display name (project default person display props include both).
      name,
      $name: name,
      telegram_id: from.id,
      username: from.username ?? null,
      first_name: from.first_name,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
      is_premium: from.is_premium ?? false,
      added_to_attachment_menu: from.added_to_attachment_menu ?? false,
    },
    $set_once: {
      initial_telegram_id: from.id,
      initial_username: from.username ?? null,
      initial_language_code: from.language_code ?? null,
      initial_first_name: from.first_name,
    },
  }
}

/** Person fields from DB row — apply on the next capture after attachUser. */
export function personPropertiesFromDb(user: DbUser): PersonPropertyPatch {
  return {
    $set: {
      telegram_id: user.id,
      username: user.username ?? null,
      first_name: user.firstName ?? null,
      language_code: user.languageCode,
      nwc_connected: Boolean(user.nwcUrl),
      nwc_tips_enabled: user.nwcTips,
    },
    $set_once: {
      first_seen_at:
        user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt),
    },
  }
}

/** Later patches override earlier ones on key collision (`Object.assign` order). */
export function mergePersonProperties(
  ...patches: Array<PersonPropertyPatch | undefined>
): PersonPropertyPatch {
  const $set: Record<string, unknown> = {}
  const $set_once: Record<string, unknown> = {}
  for (const patch of patches) {
    if (patch?.$set) Object.assign($set, patch.$set)
    if (patch?.$set_once) Object.assign($set_once, patch.$set_once)
  }
  return {
    ...(Object.keys($set).length > 0 ? {$set} : {}),
    ...(Object.keys($set_once).length > 0 ? {$set_once} : {}),
  }
}

/**
 * Build a Telegram deep-link start payload from a landing PostHog distinct_id.
 * Telegram allows A-Za-z0-9_- only, max 64 chars.
 */
export function landingStartPayload(distinctId: string): string {
  const safe = distinctId.replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) return 'landing'
  return `${LANDING_START_PREFIX}${safe}`.slice(0, 64)
}

/**
 * Extract web distinct_id from `/start lp_<id>`.
 * Bare `landing` means attribution without identity merge.
 */
export function parseLandingStartPayload(payload: string | undefined): {
  fromLanding: boolean
  landingDistinctId?: string
} {
  if (!payload) return {fromLanding: false}
  if (payload === 'landing') return {fromLanding: true}
  if (!payload.startsWith(LANDING_START_PREFIX)) return {fromLanding: false}
  const id = payload.slice(LANDING_START_PREFIX.length)
  if (!id) return {fromLanding: true}
  return {fromLanding: true, landingDistinctId: id}
}

/**
 * Update telegram_chat group entity properties.
 * Call only when chat fields change — each call is a separate `$groupidentify` event.
 * Linking events to a chat uses `groups` on capture, not this.
 */
export function setTelegramChatGroup(
  posthog: CaptureClient,
  chat: DbChat,
  distinctId?: string,
): void {
  posthog.groupIdentify({
    groupType: TELEGRAM_CHAT_GROUP_TYPE,
    groupKey: telegramChatGroupKey(chat.id),
    distinctId,
    properties: {
      name: chat.title,
      telegram_chat_id: chat.id,
      chat_type: chat.type,
      price_sats: chat.price,
      paid_access_status: chat.status,
      payment_type: chat.paymentType,
      owner_id: chat.ownerId,
      has_custom_message_en: Boolean(chat.customMessageEn),
      has_custom_message_ru: Boolean(chat.customMessageRu),
      created_at:
        chat.createdAt instanceof Date ? chat.createdAt.toISOString() : String(chat.createdAt),
    },
  })
}

export function buildUpdateProperties(ctx: Context): Record<string, unknown> {
  const updateType = Object.keys(ctx.update).find(key => key !== 'update_id')
  const props: Record<string, unknown> = {
    update_type: updateType,
    chat_type: ctx.chat?.type,
    chat_id: ctx.chat?.id,
  }

  if (ctx.chat && 'title' in ctx.chat) props.chat_title = ctx.chat.title
  if (ctx.chat && 'username' in ctx.chat) props.chat_username = ctx.chat.username ?? null

  if (ctx.from) {
    props.from_id = ctx.from.id
    props.from_username = ctx.from.username ?? null
    props.from_language_code = ctx.from.language_code ?? null
    props.from_is_premium = ctx.from.is_premium ?? false
  }

  const text = ctx.message?.text ?? ctx.message?.caption
  if (text !== undefined) {
    props.text_length = text.length
    const command = text.match(/^\/([a-zA-Z0-9_]+)/)?.[1]
    if (command) props.command = command.split('@')[0]
  }

  if (ctx.callbackQuery?.data !== undefined) {
    props.callback_data = ctx.callbackQuery.data
    props.callback_prefix = ctx.callbackQuery.data.split(':')[0]
  }

  if (ctx.myChatMember) {
    props.member_status_old = ctx.myChatMember.old_chat_member.status
    props.member_status_new = ctx.myChatMember.new_chat_member.status
  }

  if (ctx.chatJoinRequest) {
    props.has_join_request = true
  }

  if (ctx.message?.new_chat_title !== undefined) {
    props.new_chat_title = ctx.message.new_chat_title
  }

  return props
}

export function captureBotEvent(
  posthog: CaptureClient | undefined,
  event: string,
  properties?: Record<string, unknown>,
  options?: {chatId?: number; distinctId?: string},
): void {
  if (!posthog) return
  // Explicit distinctId (jobs / cross-user) uses the shared helper; otherwise inherit
  // posthog.withContext from the Telegram middleware.
  if (options?.distinctId !== undefined) {
    captureUserEvent(posthog, event, options.distinctId, properties, {chatId: options.chatId})
    return
  }
  posthog.capture({
    event,
    properties,
    groups: options?.chatId !== undefined ? telegramChatGroups(options.chatId) : undefined,
  })
}

/** ctx.user after attachUser; absent on paths that never load the DB user. */
export function dbUserFromContext(ctx: Context): DbUser | undefined {
  if (!('user' in ctx)) return undefined
  const user = (ctx as Context & {user?: DbUser}).user
  return user && typeof user.id === 'number' ? user : undefined
}
