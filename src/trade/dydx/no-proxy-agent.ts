/**
 * Stands in for `https-proxy-agent`, which the dYdX client imports for Node proxies and which
 * extends Node's http.Agent, absent in the browser. Tape never configures a proxy.
 */
export class HttpsProxyAgent {
  constructor() {
    throw new Error('Tape does not proxy dYdX requests')
  }
}
