import {createHash} from 'node:crypto'
import {type PaymentRequest, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {disabledLinkPreview} from './conversation-host.js'

const TOKEN_HEX = 16

type Pending = {userId: number; request: PaymentRequest}

const byToken = new Map<string, Pending>()
const tokenByUser = new Map<number, string>()

/**
 * Stable for a user and a request, so a conversation replay rebuilds the same
 * callback_data the offer was sent with. A random token would miss the replay log.
 */
function tokenFor(userId: number, value: string): string {
  return createHash('sha256').update(`${userId}\n${value}`).digest('hex').slice(0, TOKEN_HEX)
}

export function rememberPastedPayment(userId: number, request: PaymentRequest): string {
  const token = tokenFor(userId, request.value)
  const previous = tokenByUser.get(userId)
  if (previous && previous !== token) byToken.delete(previous)
  byToken.set(token, {userId, request})
  tokenByUser.set(userId, token)
  return token
}

export function takePastedPayment(userId: number, token: string): PaymentRequest | undefined {
  const pending = byToken.get(token)
  if (!pending || pending.userId !== userId) return undefined
  byToken.delete(token)
  if (tokenByUser.get(userId) === token) tokenByUser.delete(userId)
  return pending.request
}

function forgetPastedPayment(userId: number, token: string): void {
  const pending = byToken.get(token)
  if (!pending || pending.userId !== userId) return
  byToken.delete(token)
  if (tokenByUser.get(userId) === token) tokenByUser.delete(userId)
}

function offerKeyboard(ctx: ConversationContext, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('button.pay-pasted'), payPastedRoute.build({token}))
    .row()
    .text(ctx.t('button.pasted-payment-back'), payPastedBackRoute.build({token}))
}

function offerHtml(ctx: Pick<ConversationContext, 't'>, request: PaymentRequest): string {
  return ctx.t('pasted-payment', {kind: request.kind})
}

/** Outside any wizard: the offer is an extra message, not a new living menu. */
export async function replyWithPastedPaymentOffer(
  ctx: BotContext,
  request: PaymentRequest,
): Promise<void> {
  const userId = ctx.from?.id
  if (userId === undefined) return
  const token = rememberPastedPayment(userId, request)
  await ctx.reply(offerHtml(ctx, request), {
    reply_markup: offerKeyboard(ctx, token),
    ...disabledLinkPreview,
  })
}

/**
 * `conversation.wait()`, then the pasted-payment offer when the text is a BOLT11,
 * Lightning address, or LNURL.
 *
 * Returns undefined when the user chose Back: the step is unchanged and the caller
 * waits again. Pay never returns — the conversation halts and the button falls
 * through to the existing pay-invoice flow. Any other update is returned as-is.
 *
 * A step that already expects a payment request (the invoice field) must keep
 * calling `conversation.wait()` directly. Normal input makes no extra API call,
 * so an in-progress wizard replays the same way it did before this check existed.
 */
export async function waitForStepInput(
  conversation: BotConversation,
): Promise<ConversationContext | undefined> {
  let current = await conversation.wait()
  for (;;) {
    const userId = current.from?.id
    const request =
      userId === undefined ? null : recognizePaymentRequest(current.message?.text ?? '')
    if (!request || userId === undefined) return current

    const token = rememberPastedPayment(userId, request)
    const offer = await current.reply(offerHtml(current, request), {
      reply_markup: offerKeyboard(current, token),
      ...disabledLinkPreview,
    })
    const choice = await conversation.wait()
    const data = choice.callbackQuery?.data
    const message = choice.callbackQuery?.message
    const fromOffer =
      message !== undefined &&
      'message_id' in message &&
      message.message_id === offer.message_id &&
      message.chat.id === offer.chat.id

    if (fromOffer && data === payPastedRoute.build({token})) {
      return conversation.halt({next: true})
    }
    if (fromOffer && data === payPastedBackRoute.build({token})) {
      await choice.answerCallbackQuery()
      await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
      forgetPastedPayment(userId, token)
      return undefined
    }

    await current.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
    forgetPastedPayment(userId, token)
    current = choice
  }
}
