import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { contentSecurityPolicy } from '#/csp'
import { NETWORK } from '#/site'
import { WALLETCONNECT_PROJECT_ID } from '#/wallet/config'

const csp = createMiddleware().server(async ({ next }) => {
  // Vite's dev client injects inline scripts without a nonce.
  const nonce = import.meta.env.DEV
    ? undefined
    : btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const result = await next({ context: { nonce } })
  if (nonce)
    result.response.headers.set(
      'content-security-policy',
      contentSecurityPolicy(nonce, NETWORK, Boolean(WALLETCONNECT_PROJECT_ID)),
    )
  return result
})

export const startInstance = createStart(() => ({
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' }), csp],
}))
