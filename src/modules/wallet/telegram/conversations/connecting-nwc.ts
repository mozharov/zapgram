import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {updateUser} from '@modules/users/repository.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

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
  const {posthog} = getRuntime()
  posthog?.capture({
    event: 'wallet_connected',
    properties: {
      $set: {nwc_connected: true},
    },
  })
  await ctx.reply(ctx.t('nwc.connected'))

  ctx.user.nwcUrl = nwcUrl
  ctx.user.nwc = new NostrWallet(nwcUrl)
  await replyWithWallet(ctx)
}

async function replyWithWaitForUrl(ctx: BotContext) {
  return ctx.reply(ctx.t('nwc.wait-url'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
}
