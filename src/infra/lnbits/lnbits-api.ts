import Bottleneck from 'bottleneck'
import got, {HTTPError, type OptionsOfJSONResponseBody} from 'got'
import type {ZodType} from 'zod'
import type {AppLogger} from '../logger.js'
import {validateData} from '../validate.js'

/** Pause reads (status and fee quote). A hung funding source must not hold a send for 15s. */
export const GUARD_UPSTREAM_TIMEOUT_MS = 3_000

/** Shared 30 rps budget against LNbits. Exported so tests can lift it; do not change in prod. */
export const limiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 30,
  minTime: 5,
})

export class LNBitsAPI {
  protected readonly url: string
  protected readonly headers: Record<string, string>
  protected readonly log?: AppLogger

  constructor({baseUrl, adminKey, log}: LNBitsAPIConfig) {
    this.url = baseUrl
    this.log = log
    this.headers = {
      'Content-type': 'application/json',
      Accept: 'application/json',
    }
    if (adminKey) this.headers['X-Api-Key'] = adminKey
  }

  protected async fetch(
    path: string,
    init?: OptionsOfJSONResponseBody,
    options?: {logHttpError?: boolean; quietStatuses?: number[]},
  ) {
    const logHttpError = options?.logHttpError ?? true
    const quietStatuses = options?.quietStatuses ?? []
    const headers = omitEmptyHeaders({...this.headers, ...init?.headers})
    return limiter.schedule(() =>
      got(`${this.url}${path}`, {
        ...init,
        headers,
        responseType: 'json',
        timeout: {request: 15_000, ...init?.timeout},
      }).catch((error: unknown) => {
        if (
          logHttpError &&
          error instanceof HTTPError &&
          !quietStatuses.includes(error.response.statusCode)
        )
          this.log?.error(
            {
              body: error.response.body as unknown,
              statusCode: error.response.statusCode,
              statusMessage: error.response.statusMessage,
            },
            `${error.options.method} ${path}: HTTP error`,
          )
        throw error
      }),
    )
  }

  protected async fetchWithSchema<T>(
    path: string,
    schema: ZodType<T>,
    init?: OptionsOfJSONResponseBody,
    options?: {logHttpError?: boolean; quietStatuses?: number[]},
  ) {
    const response = await this.fetch(path, init, options)
    this.log?.debug(
      {statusCode: response.statusCode, bodyLength: bodyLength(response.body)},
      `${init?.method ?? 'GET'} ${path}: response`,
    )
    return validateData(response.body, schema)
  }
}

function bodyLength(body: unknown): number {
  if (typeof body === 'string') return body.length
  try {
    return JSON.stringify(body).length
  } catch {
    return 0
  }
}

function omitEmptyHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) kept[name] = value
  }
  return kept
}

interface LNBitsAPIConfig {
  baseUrl: string
  adminKey?: string
  log?: AppLogger
}
