// urlPolicy.js — turn an address-bar string into a navigation target, and
// block dangerous schemes / obvious internal hosts.
//
// NOTE: hostname string checks here are a first layer only. They do NOT stop
// DNS rebinding (a public name that resolves to a private IP). The real SSRF
// defense is the egress firewall in deploy/firewall.nft, which blocks private
// ranges and the cloud metadata IP (169.254.169.254) at the packet level.
// Keep both.

const SEARCH_URL = process.env.SEARCH_URL || "https://duckduckgo.com/?q=";

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local + cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 unique local
  /\.local$/i,
  /\.internal$/i,
];

function hostBlocked(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname) || re.test(h));
}

// Returns { url } to navigate, or { blocked: reason }.
export function resolveAddress(input) {
  const raw = String(input).trim();
  if (!raw) return { blocked: "empty" };

  // Looks like a URL? (has scheme, or host.tld[/...] with no spaces)
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const looksLikeHost =
    !/\s/.test(raw) && /^[^\s]+\.[^\s]{2,}/.test(raw) && !/^[^:]+\s/.test(raw);

  let candidate = null;
  if (hasScheme) {
    candidate = raw;
  } else if (looksLikeHost) {
    candidate = "https://" + raw;
  }

  if (candidate) {
    let u;
    try {
      u = new URL(candidate);
    } catch {
      return { url: SEARCH_URL + encodeURIComponent(raw) };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { blocked: "scheme not allowed: " + u.protocol };
    }
    if (hostBlocked(u.hostname)) {
      return { blocked: "internal host blocked" };
    }
    return { url: u.toString() };
  }

  // Otherwise: treat as a search query.
  return { url: SEARCH_URL + encodeURIComponent(raw) };
}

// Guard used on every committed navigation (covers redirects too).
export function navigationAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (hostBlocked(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export const startPage = process.env.START_URL || "https://duckduckgo.com/";
