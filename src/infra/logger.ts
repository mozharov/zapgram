import type {AppConfig} from '@config'
import {config} from '@config'
import pino from 'pino'
import {serializeError} from 'serialize-error'

export type AppLogger = Pick<pino.Logger, 'info' | 'error' | 'warn' | 'debug'>

export function createLogger(cfg: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'> = config): pino.Logger {
  const options: pino.LoggerOptions = {
    level: cfg.LOG_LEVEL,
    formatters: {
      level: (label: string) => ({level: label}),
      bindings: () => ({}),
      log: (object: Record<string, unknown>) => {
        const result = {...object}
        if (result.error instanceof Error) result.error = serializeError(result.error)
        return result
      },
    },
    timestamp: false,
  }

  if (cfg.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        singleLine: true,
      },
    }
  }

  return pino(options)
}

/** Legacy singleton — removed in step 11 when bootstrap owns composition. */
export const logger = createLogger(config)
