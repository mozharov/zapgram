import Bottleneck from 'bottleneck'
import got, {HTTPError, type OptionsOfJSONResponseBody} from 'got'
import type {ZodType} from 'zod'
import type {AppLogger} from '../logger.js'
import {validateData} from '../validate.js'

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

  protected async fetch(path: string, init?: OptionsOfJSONResponseBody) {
    const headers = {...this.headers, ...init?.headers}
    return limiter.schedule(() =>
      got(`${this.url}${path}`, {
        ...init,
        headers,
        responseType: 'json',
        timeout: {request: 15000},
      }).catch((error: unknown) => {
        if (error instanceof HTTPError)
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
  ) {
    const response = await this.fetch(path, init)
    this.log?.debug(
      {body: response.body as unknown},
      `${init?.method ?? 'GET'} ${path}: response body`,
    )
    return validateData(response.body, schema)
  }
}

interface LNBitsAPIConfig {
  baseUrl: string
  adminKey?: string
  log?: AppLogger
}
