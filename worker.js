// worker.js - Advanced Universal CORS Proxy
// Handles HLS/m3u8, chunked streams, binary, JSON, HTML, and more

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.",   // link-local
  "10.",
  "192.168.",
  "172.16.",
];

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

// Headers to strip from upstream responses (security / correctness)
const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "x-content-type-options",
  "strict-transport-security",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "set-cookie",  // avoid leaking cookies to caller
]);

// Headers to strip from the incoming proxy request before forwarding
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-ray",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

function errorResponse(message, status = 400, origin = "*") {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function isBlockedHost(hostname) {
  return BLOCKED_HOSTS.some((blocked) => hostname.startsWith(blocked) || hostname === blocked);
}

/**
 * Rewrite m3u8 playlists so that relative segment URLs are
 * converted to absolute proxy URLs, keeping the stream playable.
 */
function rewriteM3U8(text, targetBase, proxyBase) {
  const base = new URL(targetBase);
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) {
        // Rewrite URI="..." inside EXT-X tags
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = toAbsolute(uri, base);
          return `URI="${proxyBase}?url=${encodeURIComponent(abs)}"`;
        });
      }
      // Segment lines (relative or absolute URLs)
      const abs = toAbsolute(trimmed, base);
      return `${proxyBase}?url=${encodeURIComponent(abs)}`;
    })
    .join("\n");
}

function toAbsolute(url, base) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return base.protocol + url;
  if (url.startsWith("/")) return base.origin + url;
  // relative path
  const dir = base.href.substring(0, base.href.lastIndexOf("/") + 1);
  return dir + url;
}

/**
 * Build the forwarded request, merging caller-supplied headers with defaults.
 */
function buildUpstreamRequest(request, targetURL, extraHeaders = {}) {
  const upstreamHeaders = new Headers(DEFAULT_HEADERS);

  // Forward safe headers from the original request
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (lower === "origin" || lower === "referer") continue; // we set these ourselves
    upstreamHeaders.set(key, value);
  }

  // Apply caller overrides from x-proxy-* headers
  for (const [key, value] of request.headers.entries()) {
    if (key.toLowerCase().startsWith("x-proxy-header-")) {
      const real = key.slice("x-proxy-header-".length);
      upstreamHeaders.set(real, value);
    }
  }

  // Smart Referer / Origin spoofing
  const referer = request.headers.get("x-proxy-referer") || `${targetURL.origin}/`;
  const origin  = request.headers.get("x-proxy-origin")  || targetURL.origin;
  upstreamHeaders.set("Referer", referer);
  upstreamHeaders.set("Origin",  origin);

  // Merge extra headers
  for (const [k, v] of Object.entries(extraHeaders)) {
    upstreamHeaders.set(k, v);
  }

  const init = {
    method:  request.method,
    headers: upstreamHeaders,
    redirect: "follow",
  };

  // Forward body for non-GET/HEAD
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    init.body = request.body;
  }

  return new Request(targetURL.href, init);
}

/**
 * Build the proxied response, stripping bad headers and injecting CORS.
 */
async function buildProxyResponse(upstreamRes, targetURL, proxyBase, requestOrigin) {
  const responseHeaders = new Headers();

  for (const [key, value] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // Inject CORS
  const co = corsHeaders(requestOrigin || "*");
  for (const [k, v] of Object.entries(co)) {
    responseHeaders.set(k, v);
  }

  const contentType = (upstreamRes.headers.get("content-type") || "").toLowerCase();
  const isM3U8 =
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegurl") ||
    targetURL.pathname.endsWith(".m3u8") ||
    targetURL.pathname.endsWith(".m3u");

  if (isM3U8) {
    const text = await upstreamRes.text();
    const rewritten = rewriteM3U8(text, targetURL.href, proxyBase);
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    responseHeaders.delete("content-length"); // length changed after rewrite
    return new Response(rewritten, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  // Stream everything else directly (binary-safe)
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request, env) {
    const incomingURL  = new URL(request.url);
    const requestOrigin = request.headers.get("origin") || "*";

    // ── Preflight ────────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(requestOrigin),
      });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (incomingURL.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", ts: Date.now() }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(requestOrigin) },
      });
    }

    // ── Resolve target URL ────────────────────────────────────────────────────
    // Support both  ?url=...  and  /<encoded-url>  path style
    let rawTarget =
      incomingURL.searchParams.get("url") ||
      decodeURIComponent(incomingURL.pathname.replace(/^\//, ""));

    if (!rawTarget) {
      return errorResponse(
        'Missing target URL. Use ?url=https://example.com or pass it as the path.',
        400,
        requestOrigin
      );
    }

    // Auto-prefix protocol if missing
    if (!/^https?:\/\//i.test(rawTarget)) {
      rawTarget = "https://" + rawTarget;
    }

    let targetURL;
    try {
      targetURL = new URL(rawTarget);
    } catch {
      return errorResponse("Invalid target URL: " + rawTarget, 400, requestOrigin);
    }

    // ── SSRF guard ────────────────────────────────────────────────────────────
    if (isBlockedHost(targetURL.hostname)) {
      return errorResponse("Target host is not allowed.", 403, requestOrigin);
    }

    // ── Forward query params (excluding 'url') ────────────────────────────────
    for (const [key, value] of incomingURL.searchParams.entries()) {
      if (key === "url") continue;
      targetURL.searchParams.set(key, value);
    }

    // ── Proxy base (for m3u8 rewriting) ──────────────────────────────────────
    const proxyBase = `${incomingURL.origin}/`;

    // ── Fetch upstream ────────────────────────────────────────────────────────
    try {
      const upstreamReq = buildUpstreamRequest(request, targetURL);
      const upstreamRes = await fetch(upstreamReq);
      return await buildProxyResponse(upstreamRes, targetURL, proxyBase, requestOrigin);
    } catch (err) {
      return errorResponse("Upstream fetch failed: " + err.message, 502, requestOrigin);
    }
  },
};
