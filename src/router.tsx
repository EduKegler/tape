import { ErrorComponent, createRouter as createTanStackRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

import { getContext } from './integrations/tanstack-query/root-provider'
import { report } from './analytics/track'

export function getRouter() {
  const context = getContext()

  const router = createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    ssr: { nonce: getGlobalStartContext()?.nonce },
    // TanStack Router calls defaultOnCatch only from a route's own boundary, which exists only with an error component.
    defaultErrorComponent: ErrorComponent,
    defaultOnCatch: (error) => report(error, 'router', true),
  })

  setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
