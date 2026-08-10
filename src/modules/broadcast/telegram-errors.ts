import {GrammyError} from 'grammy'

/**
 * True when Telegram indicates the bot cannot DM this user: blocked, deactivated,
 * no private chat (e.g. join-request-only, never /start), or cannot initiate conversation.
 * Callers should set `users.bot_blocked` so broadcasts skip until a private interaction.
 */
export function isTelegramUserUnreachableError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  const description = error.description.toLowerCase()

  if (error.error_code === 400) {
    // No dialog with the bot (common after chat_join_request without ever opening the bot).
    return description.includes('chat not found')
  }

  if (error.error_code === 403) {
    return (
      description.includes('blocked') ||
      description.includes('deactivated') ||
      description.includes('user is deactivated') ||
      description.includes("can't initiate conversation") ||
      description.includes('cannot initiate conversation')
    )
  }

  return false
}

export function telegramErrorMessage(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code}: ${error.description}`.slice(0, 200)
  }
  if (error instanceof Error) return error.message.slice(0, 200)
  return 'unknown_error'
}
