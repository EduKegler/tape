/**
 * Stands in for `@reown/appkit/core`, the WalletConnect QR modal, which pulls in payment SDKs.
 * Tape turns the modal off and draws the pairing QR itself.
 */
export function createAppKit(): never {
  throw new Error('Tape draws its own WalletConnect QR')
}
