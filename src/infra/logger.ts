import type {AppConfig} from '@config'
import pino from 'pino'
import {redactLoggedError} from './redact-http-error.js'

export type AppLogger = Pick<pino.Logger, 'info' | 'error' | 'warn' | 'debug'>

export function createLogger(
  cfg: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>,
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level: cfg.LOG_LEVEL,
    formatters: {
      level: (label: string) => ({level: label}),
      bindings: () => ({}),
      log: (object: Record<string, unknown>) => {
        const result = {...object}
        if ('error' in result) result.error = redactLoggedError(result.error)
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

  return destination ? pino(options, destination) : pino(options)
}
