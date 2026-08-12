import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import type {Composer} from 'grammy'
import {sendToUserCallback} from './telegram/send-to-user-callback.js'
import {tipCommand, tipInvalidCommand, tipText} from './telegram/tip.js'
import {matchTipRequest} from './telegram/tip-match.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  // createConversation(sendingToUser) lives in telegram/composition.ts.
  privateChat.callbackQuery(staticCallback.sendToUser, sendToUserCallback)

  // The trigger cannot be a static regex: clients send `/tip@this_bot` in any chat with more than
  // one bot, so the addressee is matched against `ctx.me` per update (see tip-match.ts).
  const groupMessage = composer.chatType(['group', 'supergroup']).on([':text', ':caption'])
  const tipRequest = (ctx: Parameters<typeof tipText>[0]) =>
    matchTipRequest(tipText(ctx), ctx.me.username)

  groupMessage
    .filter(ctx => {
      const request = tipRequest(ctx)
      return request !== null && request !== 'invalid'
    })
    .use(attachUser)
    .use(lnbitsWallet)
    .use(tipCommand)
  groupMessage.filter(ctx => tipRequest(ctx) === 'invalid').use(tipInvalidCommand)
}
