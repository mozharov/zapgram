import type {AppContainer} from '@bootstrap/container.js'

/**
 * Process-wide handle set by bootstrap after createContainer().
 * Leaf handlers and jobs that cannot take constructor DI read from here.
 * Not a DI framework — just the composition root's published handle.
 */
let container: AppContainer | undefined

export function setRuntime(next: AppContainer): void {
  container = next
}

export function getRuntime(): AppContainer {
  if (!container) {
    throw new Error('Runtime is not initialized. Call createContainer() / setRuntime() first.')
  }
  return container
}

/** @internal test helper */
export function clearRuntime(): void {
  container = undefined
}
