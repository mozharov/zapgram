/**
 * Commands the bot registers with Telegram and with grammY.
 * Analytics and logs may name only these. Any other slash line is `command_unknown`
 * and the typed suffix is not stored.
 */
export const botCommand = {
  start: 'start',
  help: 'help',
  wallet: 'wallet',
  donate: 'donate',
  broadcast: 'broadcast',
  tip: 'tip',
} as const

export type BotCommandName = (typeof botCommand)[keyof typeof botCommand]

export const botCommandNames: readonly BotCommandName[] = Object.values(botCommand)

/** Group commands this bot handles. A subset of `botCommand`. */
export const groupCommand = {
  tip: botCommand.tip,
} as const

const registered = new Set<string>(botCommandNames)

/** Lowercased name when the slash line is a command this bot registers. */
export function registeredCommandName(text: string): BotCommandName | undefined {
  const name = slashName(text)
  if (!name || !registered.has(name)) return undefined
  return name as BotCommandName
}

/** A slash line whose command is not one this bot registers. */
export function isUnregisteredSlash(text: string): boolean {
  const name = slashName(text)
  return name !== undefined && !registered.has(name)
}

function slashName(text: string): string | undefined {
  return text
    .match(/^\/([a-zA-Z0-9_]+)/)?.[1]
    ?.split('@')[0]
    ?.toLowerCase()
}
