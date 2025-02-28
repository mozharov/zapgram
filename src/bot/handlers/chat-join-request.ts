import {InputFile, type ChatJoinRequest} from 'grammy/types'
import type {BotContext} from '../context.js'
import {InlineKeyboard, type ChatTypeContext} from 'grammy'
import {getChat} from '../../models/chat.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {createSubscriptionPayment} from '../../models/subscription-payment.js'
import {decodeInvoice} from '../../lib/decoded-invoice.js'
import QRCode from 'qrcode'
import {msatsToSats} from '../../utils/sats.js'
import {getSubscriptionByUserAndChat} from '../../models/subscriptions.js'

type Context = ChatTypeContext<BotContext, 'supergroup' | 'channel'> & {
  chatJoinRequest: ChatJoinRequest
}

const EXPIRY = 60 * 60 * 24 * 1 // 1 day

export const chatJoinRequestHandler = async (ctx: Context) => {
  const {chat: tgChat} = ctx.chatJoinRequest
  ctx.log.debug({tgChat, user: ctx.user})
  const chat = await getChat({id: tgChat.id})
  if (!chat || chat.status !== 'active') return

  const subscription = await getSubscriptionByUserAndChat(ctx.user.id, chat.id)
  if (subscription) {
    await ctx.approveChatJoinRequest(ctx.user.id)
    return
  }

  const invoice = await lnbitsMasterWallet.createInvoice(chat.price, EXPIRY)
  const subscriptionPayment = await createSubscriptionPayment({
    chatId: chat.id,
    userId: ctx.user.id,
    paymentHash: invoice.payment_hash,
    paymentRequest: invoice.bolt11,
    subscriptionType: chat.paymentType,
  })

  const walletSats = msatsToSats(ctx.user.wallet.balance)
  const nwcSats = msatsToSats((await ctx.user.nwc?.getBalance()) ?? 0)

  const keyboard = new InlineKeyboard()
  if (walletSats >= chat.price) {
    keyboard.row({
      callback_data: `pay-sub:${subscriptionPayment.id}:wallet`,
      text: ctx.t('button.pay-subcription-with-wallet'),
    })
  }
  if (nwcSats >= chat.price) {
    keyboard.row({
      callback_data: `pay-sub:${subscriptionPayment.id}:nwc`,
      text: ctx.t('button.pay-subcription-with-nwc'),
    })
  }
  await replyWithQRCode(ctx, invoice.bolt11, chat.paymentType, chat.title, chat.price, keyboard)
}

async function replyWithQRCode(
  ctx: BotContext,
  paymentRequest: string,
  type: 'one_time' | 'monthly',
  chatTitle: string,
  price: number,
  keyboard: InlineKeyboard,
): Promise<void> {
  const invoice = decodeInvoice(paymentRequest)
  const buffer = await QRCode.toBuffer(invoice.paymentRequest)
  const inputFile = new InputFile(buffer)
  await ctx.api
    .sendPhoto(ctx.user.id, inputFile, {
      caption: ctx.t('subscription-invoice.created', {
        amount: invoice.satoshi,
        invoice: paymentRequest,
        type,
        title: chatTitle,
        price,
      }),
      show_caption_above_media: true,
      reply_markup: keyboard,
    })
    .catch((error: unknown) => {
      ctx.log.error({error}, 'Error while sending message to user about chat join request')
    })
}
