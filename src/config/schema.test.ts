import {describe, expect, test} from 'bun:test'
import {createConfig} from './index.js'
import {interpretBackendLiquidityGuard} from './schema.js'

describe('interpretBackendLiquidityGuard', () => {
  test('accepts on and off spellings without regard to case', () => {
    for (const value of ['on', 'ON', 'true', 'TRUE', '1', 'yes', 'YES']) {
      expect(interpretBackendLiquidityGuard(value)).toEqual({mode: 'on'})
    }
    for (const value of ['off', 'OFF', 'false', 'FALSE', '0', 'no', 'NO']) {
      expect(interpretBackendLiquidityGuard(value)).toEqual({mode: 'off'})
    }
    expect(interpretBackendLiquidityGuard(undefined)).toEqual({mode: 'on'})
    expect(interpretBackendLiquidityGuard('')).toEqual({mode: 'on'})
  })

  test('an unrecognized value stays on and is reported', () => {
    expect(interpretBackendLiquidityGuard('maybe')).toEqual({
      mode: 'on',
      unrecognized: 'maybe',
    })
    expect(interpretBackendLiquidityGuard(1)).toEqual({mode: 'on', unrecognized: 'invalid'})
  })
})

test('createConfig accepts false and does not throw on an unknown guard value', () => {
  expect(
    createConfig({...process.env, BACKEND_LIQUIDITY_GUARD: 'false'}).BACKEND_LIQUIDITY_GUARD,
  ).toBe('off')
  expect(
    createConfig({...process.env, BACKEND_LIQUIDITY_GUARD: 'no'}).BACKEND_LIQUIDITY_GUARD,
  ).toBe('off')
  const config = createConfig({...process.env, BACKEND_LIQUIDITY_GUARD: 'maybe'})
  expect(config.BACKEND_LIQUIDITY_GUARD).toBe('on')
  expect(config.backendLiquidityGuardUnrecognized).toBe('maybe')
})
