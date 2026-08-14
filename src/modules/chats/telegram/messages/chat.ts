import type {Chat} from '@infra/db/types.js'
import type {BotContext} from '@telegram/context.js'
import {type ConversationHost, joinWizardHtml} from '@telegram/helpers/conversation-host.js'
import {editLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {buildChatKeyboard} from '../keyboards/chat.js'

export async function editMessageWithChat(ctx: BotContext, chat: Chat) {
  const text = await buildText(ctx.t, chat)
  await editLivingMenu(ctx, () =>
    ctx.editMessageText(text, {reply_markup: buildChatKeyboard(ctx.t, chat)}),
  )
}

/**
 * `prefixHtml`, when given, folds a one-off confirmation (e.g. "price updated") into the same edit
 * instead of sending it as a separate message that a later `replyWithChat` would then delete.
 */
export async function editHostWithChat(
  ctx: BotContext,
  host: ConversationHost,
  chat: Chat,
  prefixHtml?: string,
) {
  const text = joinWizardHtml(prefixHtml, await buildText(ctx.t, chat))
  await ctx.api.editMessageText(host.chatId, host.messageId, text, {
    reply_markup: buildChatKeyboard(ctx.t, chat),
  })
}

export async function replyWithChat(ctx: BotContext, chat: Chat) {
  const text = await buildText(ctx.t, chat)
  await showLivingMenu(ctx, () => ctx.reply(text, {reply_markup: buildChatKeyboard(ctx.t, chat)}))
}

async function buildText(t: BotContext['t'], chat: Chat) {
  return t('chat', {
    title: chat.title,
    status: chat.status,
    price: chat.price,
    usdSuffix: await usdSuffixForSats(chat.price),
    paymentType: chat.paymentType,
    onchain: chat.onchainEnabled && chat.watchonlyWalletId ? 'on' : 'off',
    fingerprint: chat.onchainFingerprint ?? '—',
  })
}
