import {InputFile, type ChatJoinRequest} from 'grammy/types'
import type {BotContext} from '../context.js'
import {type ChatTypeContext} from 'grammy'
import {getChat} from '../../models/chat.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {createSubscriptionPayment} from '../../models/subscription-payment.js'
import QRCode from 'qrcode'
import {msatsToSats} from '../../utils/sats.js'
import {getSubscriptionByUserAndChat} from '../../models/subscriptions.js'
import {buildSubscriptionPaymentKeyboard} from '../helpers/keyboards/subscription-payment.js'
import type {Chat} from '../../lib/database/types.js'

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
  if (subscription) return ctx.approveChatJoinRequest(ctx.user.id)
  return replyWithSubscriptionInvoice(ctx, chat)
}

async function replyWithSubscriptionInvoice(ctx: BotContext, chat: Chat) {
  const invoice = await lnbitsMasterWallet.createInvoice(chat.price, EXPIRY)
  const subscriptionPayment = await createSubscriptionPayment({
    chatId: chat.id,
    userId: ctx.user.id,
    paymentHash: invoice.payment_hash,
    paymentRequest: invoice.bolt11,
    subscriptionType: chat.paymentType,
    price: chat.price,
  })
  const walletSats = msatsToSats(ctx.user.wallet.balance)
  const nwcSats = msatsToSats((await ctx.user.nwc?.getBalance()) ?? 0)
  // TODO: add callback handlers for payment buttons. If payment fails, show an error in answerCallbackQuery
  const keyboard = buildSubscriptionPaymentKeyboard(ctx.t, {
    payNWC: nwcSats >= chat.price,
    payWallet: walletSats >= chat.price,
    paymentId: subscriptionPayment.id,
  })

  const buffer = await QRCode.toBuffer(invoice.bolt11)
  const inputFile = new InputFile(buffer)
  await ctx.api
    .sendPhoto(ctx.user.id, inputFile, {
      caption: ctx.t('subscription-invoice.created', {
        amount: invoice.amount,
        invoice: invoice.bolt11,
        type: chat.paymentType,
        title: chat.title,
        price: chat.price,
      }),
      show_caption_above_media: true,
      reply_markup: keyboard,
    })
    .catch((error: unknown) => {
      ctx.log.error({error}, 'Error while sending message to user about chat join request')
    })
}
