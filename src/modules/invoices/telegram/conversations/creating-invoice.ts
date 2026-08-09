import {AppError} from '@core/errors/app-error.js'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {satsToMsats} from '@core/money/sats.js'
import {createPendingInvoice} from '@modules/invoices/repository.js'
import {waitForMemoText} from '@modules/invoices/telegram/helpers/wait-for-memo.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard, InputFile} from 'grammy'
import type {Message} from 'grammy/types'
import QRCode from 'qrcode'
import {getRuntime} from '../../../../runtime.js'

export async function creatingInvoice(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('creating-invoice'))
  const wallet = await waitForWallet(conversation, ctx, {flow: 'create_invoice'})
  const sats = await waitForSats(conversation, ctx)

  await ctx.replyWithChatAction('typing')
  // LNbits + DB must not re-run when the conversation replays after later waits.
  // Errors are returned as data: conversation.external structuredClones throws and drops AppError.
  let paymentRequest = await mintInvoiceOnce(conversation, () => createInvoice(ctx, wallet, sats))
  captureInvoiceCreated({sats, wallet, hasMemo: false, isReplacement: false})

  const qrMessage = await replyWithQRCode(ctx, paymentRequest, {offerAddMemo: true})

  const addMemoCtx = await conversation.waitForCallbackQuery(staticCallback.addInvoiceMemo, {
    otherwise: async otherwiseCtx => {
      await conversation.external(() => removeInlineKeyboard(qrMessage))
      await otherwiseCtx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await addMemoCtx.answerCallbackQuery()
  await conversation.external(() => removeInlineKeyboard(qrMessage))

  captureBotEvent(getRuntime().posthog, 'invoice_memo_add_tapped', {
    amount_sats: sats,
    wallet_type: wallet,
  })

  const memoResult = await waitForMemoText(conversation, ctx)
  if (memoResult.status !== 'ok') {
    captureBotEvent(getRuntime().posthog, 'invoice_memo_add_cancelled', {
      reason: memoResult.reason,
      amount_sats: sats,
      wallet_type: wallet,
    })
    if (memoResult.reason === 'cancel') await ctx.reply(ctx.t('canceled'))
    await replyWithWallet(ctx)
    return
  }

  await ctx.replyWithChatAction('typing')
  // Keep the no-memo pending row: the old BOLT11 stays payable until expiry.
  paymentRequest = await mintInvoiceOnce(conversation, () =>
    createInvoice(ctx, wallet, sats, memoResult.memo),
  )
  captureInvoiceCreated({sats, wallet, hasMemo: true, isReplacement: true})
  await editQRCode(ctx, qrMessage, paymentRequest)
  await replyWithWallet(ctx)
}

/**
 * Run mint/DB work once across conversation replays. Return failures as plain data so
 * AppError subclasses survive `structuredClone` inside `conversation.external`.
 */
async function mintInvoiceOnce(
  conversation: BotConversation,
  task: () => Promise<string>,
): Promise<string> {
  const result = await conversation.external(async () => {
    try {
      return {ok: true as const, paymentRequest: await task()}
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error'
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof AppError ? error.code : undefined
      return {ok: false as const, name, message, code}
    }
  })
  if (result.ok) return result.paymentRequest
  if (result.code === 'invoice_generation_failed' || result.name === InvoiceGenerationError.name) {
    throw new InvoiceGenerationError({message: result.message})
  }
  if (result.code === 'nwc_connection' || result.name === NWCConnectionError.name) {
    throw new NWCConnectionError({message: result.message})
  }
  throw new Error(result.message)
}

function captureInvoiceCreated(props: {
  sats: number
  wallet: 'internal' | 'nwc'
  hasMemo: boolean
  isReplacement: boolean
}) {
  captureBotEvent(getRuntime().posthog, 'invoice_created', {
    amount_sats: props.sats,
    wallet_type: props.wallet,
    has_memo: props.hasMemo,
    memo_path: props.hasMemo ? 'added_after' : 'none',
    is_replacement: props.isReplacement,
  })
}

async function createInvoice(
  ctx: ConversationContext,
  wallet: 'internal' | 'nwc',
  sats: number,
  memo?: string,
): Promise<string> {
  const msats = satsToMsats(sats)
  let paymentRequest: string
  if (wallet === 'internal') {
    const invoice = await ctx.user.wallet.createInvoice({sats, memo})
    await createPendingInvoice({
      userId: ctx.user.id,
      paymentRequest: invoice.bolt11,
      paymentHash: invoice.payment_hash,
      expiresAt: invoice.expiry ?? undefined,
    })
    paymentRequest = invoice.bolt11
  } else {
    if (!ctx.user.nwc) throw new NWCConnectionError()
    const invoice = await ctx.user.nwc.createInvoice(msats, memo)
    paymentRequest = invoice.invoice
  }
  return paymentRequest
}

async function replyWithQRCode(
  ctx: BotContext,
  paymentRequest: string,
  opts: {offerAddMemo: boolean},
): Promise<Message.PhotoMessage> {
  const {buffer, caption} = await buildQRPayload(ctx, paymentRequest)
  const keyboard = opts.offerAddMemo
    ? new InlineKeyboard()
        .row({
          callback_data: staticCallback.addInvoiceMemo,
          text: ctx.t('button.add-invoice-memo'),
        })
        .row({callback_data: staticCallback.cancel, text: ctx.t('button.cancel')})
    : undefined

  return ctx.replyWithPhoto(new InputFile(buffer), {
    caption,
    reply_markup: keyboard,
  })
}

async function editQRCode(
  ctx: BotContext,
  message: Message,
  paymentRequest: string,
): Promise<void> {
  const {buffer, caption} = await buildQRPayload(ctx, paymentRequest)
  await ctx.api.editMessageMedia(message.chat.id, message.message_id, {
    type: 'photo',
    media: new InputFile(buffer),
    caption,
  })
}

async function buildQRPayload(ctx: BotContext, paymentRequest: string) {
  const invoice = decodeInvoice(paymentRequest)
  const expiresAt = invoice.expiryDate ?? 0
  const buffer = await QRCode.toBuffer(invoice.paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '', getRuntime().config.memoFooter)
  const caption = ctx.t('creating-invoice.created', {
    amount: invoice.satoshi,
    hasDescription: (!!memo).toString(),
    description: memo,
    expiresAt,
    invoice: paymentRequest,
  })
  return {buffer, caption}
}
