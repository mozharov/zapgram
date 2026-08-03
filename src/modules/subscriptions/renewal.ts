import {getRuntime} from '../../runtime.js'

export const renewalService = {
  attemptAutoRenewal: (
    ...args: Parameters<ReturnType<typeof getRuntime>['renewalService']['attemptAutoRenewal']>
  ) => getRuntime().renewalService.attemptAutoRenewal(...args),
  createAndSendRenewalInvoice: (
    ...args: Parameters<
      ReturnType<typeof getRuntime>['renewalService']['createAndSendRenewalInvoice']
    >
  ) => getRuntime().renewalService.createAndSendRenewalInvoice(...args),
}

export type {RenewalOutcome} from './renewal.service.js'
