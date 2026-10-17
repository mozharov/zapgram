import {describe, expect, test} from 'bun:test'
import {Writable} from 'node:stream'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import got from 'got'
import {createLogger} from './logger.js'
import {captureUserException, errorProperties} from './posthog.js'

const apiKey = 'lnbits-key-9f3a2c'
const bearer = 'bearer-9f3a2c'
const webhookSecret = 'whsec-9f3a2c'
const querySecret = 'qsec-9f3a2c'
const responseDetail = 'wallet-create-failed-9f3a'

async function failedLnbitsRequest(): Promise<unknown> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({detail: responseDetail}, {status: 500})
    },
  })
  try {
    await got(
      `http://127.0.0.1:${server.port}/satspay/webhook/${webhookSecret}?token=${querySecret}`,
      {
        method: 'POST',
        retry: {limit: 0},
        responseType: 'json',
        headers: {
          'X-Api-Key': apiKey,
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          webhook: `https://bot.example/lnbits/webhook/${webhookSecret}`,
          amount: 21,
        }),
      },
    )
    throw new Error('expected LNbits request to fail')
  } catch (error) {
    if (error instanceof Error && error.message === 'expected LNbits request to fail') throw error
    return error
  } finally {
    server.stop(true)
  }
}

function captureLog(write: (line: string) => void) {
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk))
      callback()
    },
  })
  return createLogger({LOG_LEVEL: 'info', NODE_ENV: 'test'}, destination)
}

function assertSafePayload(payload: string) {
  expect(payload).not.toContain(apiKey)
  expect(payload).not.toContain(bearer)
  expect(payload).not.toContain(webhookSecret)
  expect(payload).not.toContain(querySecret)
  expect(payload).toContain('POST')
  expect(payload).toContain('/satspay/webhook/[REDACTED]')
  expect(payload).toContain('token=[REDACTED]')
  expect(payload).toContain('500')
  expect(payload).toContain(responseDetail)
}

describe('failed LNbits HTTP errors', () => {
  test('log and PostHog payload keep method, url, status, and response body only', async () => {
    const error = await failedLnbitsRequest()
    const lines: string[] = []
    const log = captureLog(line => lines.push(line))
    log.error({error}, 'Failed to create on-chain join payment')

    let captured: {error: unknown; props?: Record<string, unknown>} | undefined
    captureUserException(
      {
        capture: () => undefined,
        captureException: (
          err: unknown,
          _distinctId: string | undefined,
          props?: Record<string, unknown>,
        ) => {
          captured = {error: err, props}
        },
      } as never,
      error,
      7,
    )

    const logged = lines.join('\n')
    const posthog = JSON.stringify({error: captured?.error, props: captured?.props})
    assertSafePayload(logged)
    assertSafePayload(posthog)
    const line = JSON.parse(lines[0] ?? '{}') as {error?: Record<string, unknown>}
    expect(line.error).toMatchObject({
      method: 'POST',
      statusCode: 500,
      responseBody: {detail: responseDetail},
    })
    expect(line.error).not.toHaveProperty('options')
    expect(errorProperties(error).error).toMatchObject({
      method: 'POST',
      statusCode: 500,
      responseBody: {detail: responseDetail},
    })
    expect(errorProperties(error).error).not.toHaveProperty('options')
  })

  test('wrapped invoice errors do not leak the cause request', async () => {
    const error = new InvoiceGenerationError({cause: await failedLnbitsRequest()})
    const lines: string[] = []
    const log = captureLog(line => lines.push(line))
    log.error({error}, 'Error creating invoice')
    const payload = `${lines.join('\n')}\n${JSON.stringify(errorProperties(error))}`
    assertSafePayload(payload)
  })
})
