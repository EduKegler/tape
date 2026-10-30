import type { VenueId } from '@tape/core/ids'

export const CONTROL = 'tape-replay'

export interface Probe {
  http: string
  socket: string
}

export interface ProbeResult {
  fetched: boolean
  opened: boolean
}

export interface Playback {
  sockets: number
  playing: number
}

export interface Command {
  probe?: Probe
  playback?: true
  loop?: boolean
  drop?: VenueId
  restore?: VenueId
}
