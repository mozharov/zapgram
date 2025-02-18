import {pino, type Logger} from 'pino'
import {config} from '../config.js'
import {serializeError} from 'serialize-error'

const options: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  formatters: {
    level: label => ({level: label}),
    bindings: () => ({}),
    log: (object: Record<string, unknown>) => {
      const result = {...object}
      if (result.error instanceof Error) result.error = serializeError(result.error)
      return result
    },
  },
  timestamp: false,
}

if (config.NODE_ENV === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      singleLine: true,
    },
  }
}

export const logger = pino(options)

export type AppLogger = Pick<Logger, 'info' | 'error' | 'warn' | 'debug'>
