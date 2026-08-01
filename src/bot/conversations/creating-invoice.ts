import {config} from '@config'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {satsToMsats} from '@core/money/sats.js'
import {createPendingInvoice} from '@modules/invoices/repository.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InputFile} from 'grammy'
import QRCode from 'qrcode'
import {waitForMemo} from '../helpers/conversations/wait-for-memo.js'
import {waitForSats} from '../helpers/conversations/wait-for-sats.js'
import {waitForWallet} from '../helpers/conversations/wait-for-wallet.js'
import {replyWithWallet} from '../helpers/messages/wallet.js'

export async function creatingInvoice(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('creating-invoice'))
  const wallet = await waitForWallet(conversation, ctx)
  const sats = await waitForSats(conversation, ctx)
  const memo = await waitForMemo(conversation, ctx)
  await ctx.replyWithChatAction('typing')
  const paymentRequest = await createInvoice(ctx, wallet, sats, memo)
  await replyWithQRCode(ctx, paymentRequest)
  await replyWithWallet(ctx)
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

async function replyWithQRCode(ctx: BotContext, paymentRequest: string): Promise<void> {
  const invoice = decodeInvoice(paymentRequest)
  const expiresAt = invoice.expiryDate ?? 0
  const buffer = await QRCode.toBuffer(invoice.paymentRequest)
  const inputFile = new InputFile(buffer)

  const memo = sanitizeMemo(invoice.description ?? '', config.memoFooter)
  await ctx.replyWithPhoto(inputFile, {
    caption: ctx.t('creating-invoice.created', {
      amount: invoice.satoshi,
      hasDescription: (!!memo).toString(),
      description: memo,
      expiresAt,
      invoice: paymentRequest,
    }),
  })
}
