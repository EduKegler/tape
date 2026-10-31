import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const checkout = fileURLToPath(new URL('..', import.meta.url))

/** Playwright loads the config again in every worker, so a free port picked at startup would differ between them. */
export const port = (offset: number) =>
  Number(process.env.E2E_PORT ?? 20_000 + (createHash('sha256').update(checkout).digest().readUInt16BE(0) % 4_000) * 4)
  + offset
