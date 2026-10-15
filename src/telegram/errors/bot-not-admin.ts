import {GrammyError} from 'grammy'

/**
 * Telegram refused the call because the bot lacks admin rights in the group (ephemeral sends and
 * deleting other members' messages both need them). An expected group setup state, not a bug:
 * callers fall back to what a plain member can do and must not report it as an exception.
 */
export function isBotNotAdminError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  const description = error.description.toUpperCase()
  return description.includes('BOT_NOT_ADMIN') || description.includes('NOT ENOUGH RIGHTS')
}
