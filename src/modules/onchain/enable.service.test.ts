import {describe, expect, test} from 'bun:test'
import {classifyWatchOnlyError} from './enable.service.js'

function httpErrorWithDetail(detail: string) {
  return Object.assign(new Error('HTTP 400'), {
    name: 'HTTPError',
    response: {body: {detail}, statusCode: 400},
  })
}

describe('classifyWatchOnlyError', () => {
  test('maps non-standard depth detail', () => {
    const result = classifyWatchOnlyError(
      httpErrorWithDetail(
        'Non-standard depth. Only bip44, bip49 and bip84 are supported with bare xpubs.',
      ),
    )
    expect(result).toMatchObject({status: 'watchonly_error', reason: 'nonstandard_depth'})
  })

  test('maps network account error', () => {
    const result = classifyWatchOnlyError(
      httpErrorWithDetail("Account network error.  This account is for 'Mainnet'"),
    )
    expect(result).toMatchObject({status: 'watchonly_error', reason: 'network_mismatch'})
  })

  test('falls back to unknown', () => {
    const result = classifyWatchOnlyError(httpErrorWithDetail('something else'))
    expect(result).toMatchObject({status: 'watchonly_error', reason: 'unknown'})
  })
})
