import {logger} from '../logger.js'
import got, {HTTPError, OptionsOfJSONResponseBody} from 'got'
import Bottleneck from 'bottleneck'
import {validateData} from '../utils/validator.js'
import type {ZodType} from 'zod'
import {config} from '../../config.js'

const limiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 30,
  minTime: 5,
})

export class LNBitsAPI {
  protected readonly url = config.LNBITS_URL
  protected readonly headers: Record<string, string>

  constructor({adminKey}: LNBitsAPIConfig) {
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
      }).catch((error: unknown) => {
        if (error instanceof HTTPError)
          logger.error(
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
    logger.debug(
      {body: response.body as unknown},
      `${init?.method ?? 'GET'} ${path}: response body`,
    )
    return validateData(response.body, schema)
  }
}

interface LNBitsAPIConfig {
  adminKey?: string
}
