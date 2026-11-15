const CAMPAIGN_TAGS = ['utm_source', 'utm_medium', 'utm_campaign'] as const
const MAX_TAG = 100

export type Campaign = Partial<Record<(typeof CAMPAIGN_TAGS)[number], string>>

/** The UTM tags of a search string, the only search params that leave the page. */
export function campaign(search: string): Campaign {
  const params = new URLSearchParams(search)
  return Object.fromEntries(
    CAMPAIGN_TAGS.flatMap((tag) => {
      const value = params.get(tag)?.trim().slice(0, MAX_TAG)
      return value ? [[tag, value]] : []
    }),
  )
}
