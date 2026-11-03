# Security

Tape signs orders in the browser with keys it keeps on the trader's device. A bug here can move someone's money, so report it in private.

## Report a vulnerability

Open a private report at [Security advisories](https://github.com/EduKegler/tape/security/advisories/new). Do not open a public issue.

Include the site or build, the network, the browser and the steps that show the problem. One person maintains Tape, so there is no fixed response time. Every report gets an answer in the advisory.

## Supported versions

Tape has no releases. Only `main` and the two sites it deploys are supported: [tape.kegler.dev](https://tape.kegler.dev) and [tape.testnet.kegler.dev](https://tape.testnet.kegler.dev).

## How Tape handles keys

- No server sits between the trader and the venue. The browser signs each request and sends it to the venue's API. The site's own server only renders pages and forwards analytics from `/r1`, which carry no wallet address and no key.
- The wallet never shares its key. It signs each venue's setup and every deposit.
- Hyperliquid and Orderly keys sit in the site's `localStorage`. The Hyperliquid agent key can trade but cannot withdraw, because a withdrawal needs the wallet.
- The dYdX key derives from a wallet signature and can withdraw, so it sits only in `sessionStorage` and leaves with the tab.
- Storage goes only through `src/trade/vault.ts`, and key libraries live only in `packages/trade`. Lint enforces both.
- The server sends a Content Security Policy with a nonce per request. Scripts run only if the server rendered them, and the page connects only to the hosts in `src/csp.ts`.
- A mainnet build sends orders only on the venues named in `VITE_TRADE_MAINNET`. Every other venue sends nothing.

## In scope

- A way to read a key, or to make the page sign or send something the trader did not ask for.
- An order or deposit that differs from what the screen showed before the trader confirmed it.
- A script that runs without the nonce, or a request to a host outside `src/csp.ts`.
- A mainnet order on a venue the build does not name.
- A dependency that Tape loads and that does any of the above.

## Out of scope

- A bug in a venue, a wallet or a library that Tape uses as documented. Report it to them. Open an issue here if Tape should work around it.
- An attack that needs a compromised device, a malicious browser extension or a fake copy of the site.
- Missing headers or settings with no shown impact.
