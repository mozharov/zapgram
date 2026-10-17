import {getRuntime} from '../../../runtime.js'

export async function probeSatspay(): Promise<void> {
  await getRuntime().satspayGate.tick()
}
