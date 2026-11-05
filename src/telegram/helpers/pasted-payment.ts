import {createHash} from 'node:crypto'
import {type PaymentRequest, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {isVanishedTelegramMessageError} from '../errors/vanished-message.js'
import {disabledLinkPreview} from './conversation-host.js'
import {type ActivePrompt, cancelledPromptState, deactivatePrompt} from './conversation-prompt.js'

/** Which pasted payment requests a step should intercept. Free text uses `none`. */
export type PaymentIntercept = 'bolt11' | 'all' | 'none'

const TOKEN_HEX = 16

/**
 * Same-process dedupe of Pay clicks that overlap inside one handler. This does not
 * store the invoice and does not stick after the handler returns: a later paste of
 * the same bolt11 can pay again. While one click is inside the handler, a second
 * tap loses the race instead of opening another payment.
 */
const payStarting = new Set<string>()

function payKey(userId: number, token: string): string {
  return `${userId}:${token}`
}

/** True for the click that may open payment. Synchronous: call before any await. */
export function reservePastedPay(userId: number, token: string): boolean {
  const key = payKey(userId, token)
  if (payStarting.has(key)) return false
  payStarting.add(key)
  return true
}

export function releasePastedPay(userId: number, token: string): void {
  payStarting.delete(payKey(userId, token))
}

/**
 * Bound to the user and the canonical request, and stable across a conversation
 * replay: the same paste always rebuilds the same callback_data. Nothing about
 * the invoice is kept in process memory — after a restart the button reads it
 * back from the message it replies to.
 */
export function pastedPaymentToken(userId: number, value: string): string {
  return createHash('sha256').update(`${userId}\n${value}`).digest('hex').slice(0, TOKEN_HEX)
}

/**
 * The bolt11 the Pay button was built for, or undefined when the replied message
 * is missing, is not that invoice, or belongs to another user.
 */
export function bolt11MatchingToken(
  userId: number | undefined,
  token: string,
  text: string | undefined,
): string | undefined {
  if (userId === undefined || text === undefined) return undefined
  const request = recognizePaymentRequest(text)
  if (request?.kind !== 'bolt11') return undefined
  if (pastedPaymentToken(userId, request.value) !== token) return undefined
  return request.value
}

function bolt11Keyboard(ctx: ConversationContext, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('button.pay-pasted'), payPastedRoute.build({token}))
    .row()
    .text(ctx.t('button.pasted-payment-back'), payPastedBackRoute.build({token}))
}

function backKeyboard(ctx: ConversationContext, token: string): InlineKeyboard {
  return new InlineKeyboard().text(
    ctx.t('button.pasted-payment-back'),
    payPastedBackRoute.build({token}),
  )
}

/**
 * Outside a wizard there is no step to return to. Address and LNURL have no pay
 * button: paying them is a later task.
 */
export async function replyWithUnsupportedPayment(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.t('pasted-payment-unsupported'), {...disabledLinkPreview})
}

/**
 * `conversation.wait()`, then a notice when the text is a payment request this step intercepts.
 *
 * `intercept: 'none'` returns the text unchanged and makes no extra API call, so a
 * free-text field (memo, feature text, custom message, broadcast source) accepts an
 * email, an address, an LNURL, or a bolt11 as ordinary input and replays like before.
 * `all` notices every recognized request. `bolt11` notices only an invoice.
 *
 * A bolt11 gets Pay and Back, sent as a reply to the paste so the invoice can be read
 * back from that reply after a restart. Pay never returns: the step is marked
 * cancelled, the conversation halts, and the button falls through to the existing
 * pay-invoice flow. An address or LNURL gets the unsupported note and Back only.
 * Back returns undefined so the caller waits again on the same step.
 *
 * A Pay or Back click on an offer this step is not showing gets a toast and is
 * ignored, so it cannot fall through and start a second payment.
 *
 * A step that already expects a payment request (the invoice field) must keep
 * calling `conversation.wait()` directly.
 */
export async function waitForStepInput(
  conversation: BotConversation,
  prompt: ActivePrompt,
  opts: {intercept: PaymentIntercept},
): Promise<ConversationContext | undefined> {
  let current = await conversation.wait()
  for (;;) {
    if (isOfferButton(current)) {
      await current.answerCallbackQuery({text: current.t('callback-answer.pasted-payment-stale')})
      current = await conversation.wait()
      continue
    }

    const userId = current.from?.id
    const request =
      userId === undefined ? null : recognizePaymentRequest(current.message?.text ?? '')
    if (!request || userId === undefined || !intercepts(opts.intercept, request)) return current

    const token = pastedPaymentToken(userId, request.value)
    const sourceId = current.message?.message_id
    const offer = await current.reply(noticeHtml(current, request), {
      ...(sourceId === undefined
        ? {}
        : {
            reply_parameters: {message_id: sourceId, allow_sending_without_reply: true},
          }),
      reply_markup:
        request.kind === 'bolt11' ? bolt11Keyboard(current, token) : backKeyboard(current, token),
      ...disabledLinkPreview,
    })
    const choice = await conversation.wait()
    const data = choice.callbackQuery?.data
    const fromOffer = callbackFromMessage(choice, offer.chat.id, offer.message_id)

    if (
      fromOffer &&
      request.kind === 'bolt11' &&
      data === payPastedRoute.build({token}) &&
      bolt11MatchingToken(userId, token, repliedText(choice)) === request.value
    ) {
      // Same cleanup as leaving the step: cancelled mark and no live buttons. The helper
      // halts, so the caller never reaches its own cancel path.
      await deactivatePrompt(conversation, prompt, cancelledPromptState(choice, prompt))
      return conversation.halt({next: true})
    }
    if (fromOffer && data === payPastedRoute.build({token})) {
      await choice.answerCallbackQuery({text: choice.t('callback-answer.pasted-payment-missing')})
      await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
      return undefined
    }
    if (fromOffer && data === payPastedBackRoute.build({token})) {
      await choice.answerCallbackQuery()
      await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
      return undefined
    }

    await current.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
    current = choice
  }
}

function intercepts(mode: PaymentIntercept, request: PaymentRequest): boolean {
  if (mode === 'none') return false
  if (mode === 'bolt11') return request.kind === 'bolt11'
  return true
}

function noticeHtml(ctx: Pick<ConversationContext, 't'>, request: PaymentRequest): string {
  if (request.kind === 'bolt11') return ctx.t('pasted-payment')
  return ctx.t('pasted-payment-unsupported')
}

function isOfferButton(ctx: ConversationContext): boolean {
  const data = ctx.callbackQuery?.data
  if (!data) return false
  return payPastedRoute.pattern.test(data) || payPastedBackRoute.pattern.test(data)
}

function callbackFromMessage(ctx: ConversationContext, chatId: number, messageId: number): boolean {
  const message = ctx.callbackQuery?.message
  return (
    message !== undefined &&
    'message_id' in message &&
    message.message_id === messageId &&
    message.chat.id === chatId
  )
}

export function repliedText(ctx: {
  callbackQuery?: {message?: {reply_to_message?: {text?: string}}}
}): string | undefined {
  const replied = ctx.callbackQuery?.message?.reply_to_message
  return typeof replied?.text === 'string' ? replied.text : undefined
}

/**
 * Deletes the offer. The first delete wins across processes: Telegram answers the
 * second with "message to delete not found". The in-memory set is only a fast path.
 */
export async function claimPastedOffer(ctx: BotContext): Promise<boolean> {
  const message = ctx.callbackQuery?.message
  if (!message || !('message_id' in message) || ctx.chat?.id === undefined) return false
  try {
    await ctx.api.deleteMessage(ctx.chat.id, message.message_id)
    return true
  } catch (error) {
    if (isVanishedTelegramMessageError(error)) return false
    throw error
  }
}
