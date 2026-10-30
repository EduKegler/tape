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
