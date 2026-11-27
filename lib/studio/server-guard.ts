export function isLocalRequest(request: Request): boolean {
  const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!loopbackHosts.includes(url.hostname) || !host) return false;
  let browserUrl: URL;
  try {
    // Next.js may normalize the request URL to localhost. Host retains the
    // browser's actual destination, including its port.
    browserUrl = new URL(`${url.protocol}//${host}`);
    if (!loopbackHosts.includes(browserUrl.hostname) || browserUrl.host !== host ||
        browserUrl.username || browserUrl.password || browserUrl.pathname !== "/" ||
        browserUrl.search || browserUrl.hash) return false;
  } catch { return false; }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin || origin === browserUrl.origin) return true;
  try {
    const source = new URL(origin);
    // Observed local Chrome requests omit the Origin port while retaining
    // Sec-Fetch-Site: same-origin. Only accept that specific normalization.
    // Cross-port browser requests are same-site, never same-origin; explicit
    // mismatched ports and clients without this browser evidence stay denied.
    return site === "same-origin" && source.origin === origin && !source.port &&
      source.protocol === browserUrl.protocol && source.hostname === browserUrl.hostname;
  } catch { return false; }
}
