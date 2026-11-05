import {createHash} from 'node:crypto'
import {type PaymentRequest, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../runtime.js'
import {disabledLinkPreview} from './conversation-host.js'
import {removeInlineKeyboardById} from './keyboard.js'

type StepPrompt = {chatId: number; messageId: number}

const TOKEN_HEX = 16

/**
 * Same-process dedupe of Pay clicks. This does not store the invoice: the bolt11
 * still comes from the replied message, so a restart can pay. The sets only stop
 * two overlapping clicks — the active-conversation check is after an await, so
 * without this both would pass it and open two payments.
 */
const payStarting = new Set<string>()
const payStarted = new Set<string>()

function payKey(userId: number, token: string): string {
  return `${userId}:${token}`
}

/** True for the single click that may open payment. Synchronous: call before any await. */
export function reservePastedPay(userId: number, token: string): boolean {
  const key = payKey(userId, token)
  if (payStarted.has(key) || payStarting.has(key)) return false
  payStarting.add(key)
  return true
}

export function commitPastedPay(userId: number, token: string): void {
  const key = payKey(userId, token)
  payStarting.delete(key)
  payStarted.add(key)
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
 * `conversation.wait()`, then a notice when the text is a BOLT11, Lightning address, or LNURL.
 *
 * A bolt11 gets Pay and Back, sent as a reply to the paste so the invoice can be read
 * back from that reply after a restart. Pay never returns: the conversation halts and
 * the button falls through to the existing pay-invoice flow. An address or LNURL gets
 * the unsupported note and Back only.
 * Back returns undefined so the caller waits again on the same step. Any other update
 * is returned as-is.
 *
 * A repeated Pay click on an offer this step is not showing is answered and ignored,
 * so it cannot fall through and start a second payment.
 *
 * A step that already expects a payment request (the invoice field) must keep
 * calling `conversation.wait()` directly. Normal input makes no extra API call,
 * so an in-progress wizard replays the same way it did before this check existed.
 */
export async function waitForStepInput(
  conversation: BotConversation,
  prompt: StepPrompt,
): Promise<ConversationContext | undefined> {
  let current = await conversation.wait()
  for (;;) {
    if (isOfferButton(current)) {
      await current.answerCallbackQuery()
      current = await conversation.wait()
      continue
    }

    const userId = current.from?.id
    const request =
      userId === undefined ? null : recognizePaymentRequest(current.message?.text ?? '')
    if (!request || userId === undefined) return current

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
      // Drop the step's buttons before the wizard ends. Pay can still fail inside the
      // existing flow (bad bolt11, not enough balance) before that flow has a screen of
      // its own. The step must not stay tappable with no conversation behind it.
      await conversation.external(() => clearPromptKeyboard(prompt))
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

/** Clears the step keyboard only. The message stays until a later screen replaces it. */
async function clearPromptKeyboard(prompt: StepPrompt): Promise<void> {
  await removeInlineKeyboardById(prompt.chatId, prompt.messageId).catch((error: unknown) => {
    getRuntime().log.warn(
      {error, chatId: prompt.chatId, messageId: prompt.messageId},
      'Failed to clear wizard prompt before pay',
    )
  })
}
