import {InlineKeyboard} from 'grammy'
import type {BotContext, BotConversation, ConversationContext} from '../context.js'
import {replyWithWallet} from '../helpers/messages/wallet.js'
import {removeInlineKeyboard} from '../helpers/keyboard.js'
import {NostrWallet} from '../../lib/nostr-wallet.js'
import {updateUser} from '../../models/user.js'
import {NWCConnectionError} from '../errors/nwc-connection.js'

export async function connectingNWC(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('nwc.connecting'))
  const message = await replyWithWaitForUrl(ctx)
  const urlContext = await conversation.waitForHears(/^(nostr\+walletconnect:.*)$/, {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      if (ctx.update.message?.text) await ctx.reply(ctx.t('nwc.invalid-url'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await urlContext.deleteMessage()
  await removeInlineKeyboard(message)
  await ctx.replyWithChatAction('typing')
  const nwcUrl = urlContext.match[0]
  await new NostrWallet(nwcUrl).getBalance().catch((error: unknown) => {
    ctx.log.error({error}, 'Error while validating NWC connection')
    throw new NWCConnectionError()
  })
  await updateUser(ctx.user.id, {nwcUrl})
  await ctx.reply(ctx.t('nwc.connected'))
  await replyWithWallet(ctx)
}

async function replyWithWaitForUrl(ctx: BotContext) {
  return ctx.reply(ctx.t('nwc.wait-url'), {
    reply_markup: new InlineKeyboard([[{callback_data: 'cancel', text: ctx.t('button.cancel')}]]),
  })
}
