import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {updateUser} from '@modules/users/repository.js'
import {replyWithSettings} from '@modules/wallet/telegram/messages/settings.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {mergePersonProperties, personPropertiesFromTelegram} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function connectingNWC(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('nwc.connecting'))
  const html = ctx.t('nwc.wait-url')
  const message = await replyWithWaitForUrl(ctx, html)
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.connect-nwc'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let urlContext: ConversationContext
  let nwcUrl: string
  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithSettings(ctx)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    const match = /^(nostr\+walletconnect:.*)$/.exec(next.message?.text?.trim() ?? '')
    if (!match?.[1]) {
      await next.reply(next.t('nwc.invalid-url'))
      continue
    }

    urlContext = next
    nwcUrl = match[1]
    break
  }

  await deleteMessageSafely(urlContext)
  await clearPromptControls(conversation, prompt)
  await ctx.replyWithChatAction('typing')
  await new NostrWallet(nwcUrl).getBalance().catch((error: unknown) => {
    ctx.log.error({error}, 'Error while validating NWC connection')
    throw new NWCConnectionError()
  })
  await updateUser(ctx.user.id, {nwcUrl})
  // The NWC URL itself is a wallet credential — never log it.
  ctx.log.info('NWC wallet connected')
  const {posthog} = getRuntime()
  // Merge with Telegram person fields so a local $set does not drop name / $name.
  posthog?.capture({
    event: 'wallet_connected',
    properties: {
      ...mergePersonProperties(ctx.from ? personPropertiesFromTelegram(ctx.from) : undefined, {
        $set: {nwc_connected: true},
      }),
    },
  })
  await ctx.reply(ctx.t('nwc.connected'))

  ctx.user.nwcUrl = nwcUrl
  ctx.user.nwc = new NostrWallet(nwcUrl)
  await replyWithWallet(ctx)
}

async function replyWithWaitForUrl(ctx: BotContext, html: string) {
  return ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
}
