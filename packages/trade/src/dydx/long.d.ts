// long@4 ships no types. The dYdX client only needs a Long it can encode as uint64.
declare module 'long' {
  interface Long {
    readonly low: number
    readonly high: number
    readonly unsigned: boolean
  }
  const Long: { fromString: (value: string, unsigned?: boolean) => Long }
  export default Long
}
