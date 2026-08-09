import {GrammyError} from 'grammy'

/** True when Telegram indicates the user blocked the bot or the account is gone. */
export function isTelegramUserUnreachableError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  if (error.error_code !== 403) return false
  const description = error.description.toLowerCase()
  return (
    description.includes('blocked') ||
    description.includes('deactivated') ||
    description.includes('user is deactivated')
  )
}

export function telegramErrorMessage(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code}: ${error.description}`.slice(0, 200)
  }
  if (error instanceof Error) return error.message.slice(0, 200)
  return 'unknown_error'
}
