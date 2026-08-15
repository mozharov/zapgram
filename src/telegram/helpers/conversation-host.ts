import type {BotContext, ConversationContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import type {InlineKeyboard} from 'grammy'
import type {InputRichMessage} from 'grammy/types'

export type ConversationHost = {
  chatId: number
  messageId: number
}

export type PromptMessage = {
  chat: {id: number}
  message_id: number
}

/** Wizard messages often include t.me links in invoice memos; never preview them. */
export const disabledLinkPreview = {link_preview_options: {is_disabled: true}} as const

export function joinWizardHtml(...parts: Array<string | undefined>): string {
  return parts.filter(part => part !== undefined && part.trim().length > 0).join('\n\n')
}

export function hostFromCallback(ctx: ConversationContext): ConversationHost | undefined {
  const message = ctx.callbackQuery?.message
  if (!message || !('message_id' in message)) return undefined
  return {chatId: message.chat.id, messageId: message.message_id}
}

export function promptMessageFromHost(host: ConversationHost): PromptMessage {
  return {chat: {id: host.chatId}, message_id: host.messageId}
}

export async function replyAsHost(
  ctx: ConversationContext,
  html: string,
  replyMarkup?: InlineKeyboard,
): Promise<ConversationHost> {
  const message = await showLivingMenu(ctx, () =>
    ctx.reply(html, {reply_markup: replyMarkup, ...disabledLinkPreview}),
  )
  return {chatId: message.chat.id, messageId: message.message_id}
}

export async function ensureHost(
  ctx: ConversationContext,
  html: string,
  replyMarkup?: InlineKeyboard,
): Promise<ConversationHost> {
  return hostFromCallback(ctx) ?? replyAsHost(ctx, html, replyMarkup)
}

export async function editHost(
  ctx: BotContext,
  host: ConversationHost,
  html: string,
  replyMarkup?: InlineKeyboard,
): Promise<PromptMessage> {
  await ctx.api.editMessageText(host.chatId, host.messageId, html, {
    reply_markup: replyMarkup,
    ...disabledLinkPreview,
  })
  return promptMessageFromHost(host)
}

export async function editHostCaption(
  ctx: BotContext,
  host: ConversationHost,
  caption: string,
  replyMarkup?: InlineKeyboard,
): Promise<PromptMessage> {
  await ctx.api.editMessageCaption(host.chatId, host.messageId, {
    caption,
    reply_markup: replyMarkup,
  })
  return promptMessageFromHost(host)
}

export async function editHostRich(
  ctx: BotContext,
  host: ConversationHost,
  rich: InputRichMessage,
  replyMarkup?: InlineKeyboard,
): Promise<PromptMessage> {
  await ctx.api.editMessageText(host.chatId, host.messageId, rich, {
    reply_markup: replyMarkup,
    ...disabledLinkPreview,
  })
  return promptMessageFromHost(host)
}

export async function showHostOrReply(
  ctx: ConversationContext,
  html: string,
  replyMarkup?: InlineKeyboard,
  host?: ConversationHost,
): Promise<PromptMessage> {
  if (host) return editHost(ctx, host, html, replyMarkup)
  return showLivingMenu(ctx, () =>
    ctx.reply(html, {reply_markup: replyMarkup, ...disabledLinkPreview}),
  )
}
