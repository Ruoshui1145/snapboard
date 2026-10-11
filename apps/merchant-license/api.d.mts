import type { IncomingMessage, ServerResponse } from 'node:http'
export function merchantLicensingApi(): {
  name: string
  configureServer(server: { middlewares: { use(route: string, handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => unknown): unknown } }): void
}
export function authorizeMerchantRequest(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>
export function startDiyDelivery(request: IncomingMessage, target: string, expectedBytes: number | null): Promise<void>
export function finishDiyDelivery(request: IncomingMessage): Promise<void>
