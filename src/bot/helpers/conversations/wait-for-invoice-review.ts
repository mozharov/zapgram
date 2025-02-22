import {InlineKeyboard} from 'grammy'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'
import type {DecodedInvoice} from '../../../lib/decoded-invoice.js'
import {msatsToSats} from '../../../utils/sats.js'
import {getPendingInvoiceBy} from '../../../models/pending-invoice.js'

export async function waitForInvoiceReview(
  conversation: BotConversation,
  ctx: ConversationContext,
  invoice: DecodedInvoice,
  isInternalWallet: boolean,
) {
  const timestamp = await conversation.external(() => new Date().getTime())
  const payCallback = `pay:${timestamp}` // avoid pay wrong invoice
  const keyboard = new InlineKeyboard()
    .add({
      callback_data: payCallback,
      text: ctx.t('button.confirm-pay-invoice'),
    })
    .add({
      callback_data: 'cancel',
      text: ctx.t('button.cancel'),
    })

  let satsFee: number | 'no' = 'no'
  if (isInternalWallet) {
    const internalInvoice = await getPendingInvoiceBy({paymentRequest: invoice.paymentRequest})
    if (internalInvoice) satsFee = 0
    else satsFee = msatsToSats(await ctx.user.wallet.getFeeReserve(invoice.paymentRequest))
  }
  const message = await ctx.reply(
    ctx.t('wait-for-invoice-review', {
      amount: invoice.satoshi,
      fee: satsFee,
      description: invoice.description ?? '',
      hasDescription: (!!invoice.description).toString(),
      createdDate: invoice.createdDate,
      expiryDate: invoice.expiryDate ?? 'no',
      hasExpired: invoice.hasExpired().toString(),
    }),
    {
      reply_markup: invoice.hasExpired() ? undefined : keyboard,
      link_preview_options: {is_disabled: true},
    },
  )

  if (invoice.hasExpired()) return conversation.halt()

  await conversation.waitForCallbackQuery(payCallback, {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })

  await conversation.external(() => removeInlineKeyboard(message))
}
