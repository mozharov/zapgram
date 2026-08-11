import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'
import {removeInlineKeyboardById} from './keyboard.js'

type PromptMessage = {
  chat: {id: number}
  message_id: number
}

type CallbackContext = {
  callbackQuery?: {
    data?: string
    message?: PromptMessage
  }
  message?: {
    entities?: {type: string; offset: number}[]
  }
}

export type ActivePrompt = {
  kind: 'text' | 'caption'
  chatId: number
  messageId: number
  html: string
  actionLabel: string
}

export type PromptEndState = {
  kind: 'cancelled' | 'inactive'
  statusHtml: string
  fallbackText: string
}

export type PromptUpdateKind = 'cancel' | 'interrupt' | 'input'

export function createActivePrompt(
  message: PromptMessage,
  options: Pick<ActivePrompt, 'kind' | 'html' | 'actionLabel'>,
): ActivePrompt {
  return {
    ...options,
    chatId: message.chat.id,
    messageId: message.message_id,
  }
}

export function isCallbackFromPrompt(ctx: CallbackContext, prompt: ActivePrompt): boolean {
  const message = ctx.callbackQuery?.message
  return message?.chat.id === prompt.chatId && message.message_id === prompt.messageId
}

export function classifyPromptUpdate(
  ctx: CallbackContext,
  prompt: ActivePrompt,
  cancelData: string,
): PromptUpdateKind {
  if (ctx.callbackQuery) {
    return ctx.callbackQuery.data === cancelData && isCallbackFromPrompt(ctx, prompt)
      ? 'cancel'
      : 'interrupt'
  }

  const isCommand = ctx.message?.entities?.some(
    entity => entity.type === 'bot_command' && entity.offset === 0,
  )
  if (isCommand || !ctx.message) return 'interrupt'
  return 'input'
}

export function cancelledPromptState(
  ctx: Pick<ConversationContext, 't'>,
  prompt: ActivePrompt,
): PromptEndState {
  return {
    kind: 'cancelled',
    statusHtml: ctx.t('conversation-state.cancelled'),
    fallbackText: ctx.t('conversation-state.interrupted-fallback', {
      action: prompt.actionLabel,
    }),
  }
}

export function renderPromptEndState(html: string, statusHtml: string): string {
  const prompt = html.trimEnd()
  const status = statusHtml.trim()
  if (prompt.endsWith(status)) return html
  return `${prompt}\n\n${status}`
}

function isMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes('message is not modified')
}

async function deactivatePromptOnce(prompt: ActivePrompt, state: PromptEndState): Promise<void> {
  const {bot, log} = getRuntime()
  const html = renderPromptEndState(prompt.html, state.statusHtml)

  try {
    if (prompt.kind === 'text') {
      await bot.api.editMessageText(prompt.chatId, prompt.messageId, html, {
        reply_markup: {inline_keyboard: []},
      })
    } else {
      await bot.api.editMessageCaption(prompt.chatId, prompt.messageId, {
        caption: html,
        reply_markup: {inline_keyboard: []},
      })
    }
    return
  } catch (error) {
    if (isMessageNotModified(error)) return
    log.warn(
      {error, chatId: prompt.chatId, messageId: prompt.messageId, state: state.kind},
      'Failed to deactivate conversation prompt',
    )
  }

  try {
    await removeInlineKeyboardById(prompt.chatId, prompt.messageId)
  } catch (error) {
    log.warn(
      {error, chatId: prompt.chatId, messageId: prompt.messageId},
      'Failed to remove keyboard from conversation prompt',
    )
  }

  try {
    await bot.api.sendMessage(prompt.chatId, state.fallbackText)
  } catch (error) {
    log.warn(
      {error, chatId: prompt.chatId, messageId: prompt.messageId},
      'Failed to send conversation interruption fallback',
    )
  }
}

export async function deactivatePrompt(
  conversation: BotConversation,
  prompt: ActivePrompt,
  state: PromptEndState,
): Promise<void> {
  await conversation.external(() => deactivatePromptOnce(prompt, state))
}

export async function clearPromptControls(
  conversation: BotConversation,
  prompt: ActivePrompt,
): Promise<void> {
  await conversation.external(async () => {
    try {
      await removeInlineKeyboardById(prompt.chatId, prompt.messageId)
    } catch (error) {
      getRuntime().log.warn(
        {error, chatId: prompt.chatId, messageId: prompt.messageId},
        'Failed to clear conversation prompt controls',
      )
    }
  })
}

export async function interruptConversation(
  conversation: BotConversation,
  prompt: ActivePrompt,
  state: PromptEndState,
): Promise<never> {
  await deactivatePrompt(conversation, prompt, state)
  return conversation.halt({next: true})
}
