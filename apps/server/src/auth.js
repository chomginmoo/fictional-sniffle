// auth.js — single-user password login, one-time WebSocket tickets,
// login rate limiting, and WebSocket Origin checking (CSWSH defense).
import crypto from "node:crypto";

const PASSWORD = process.env.APP_PASSWORD || "";
// Comma-separated list of allowed origins, e.g.
//   ALLOWED_ORIGINS=https://my.duckdns.org
// In dev we also allow the Codespaces/localhost origin the request arrives on.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TICKET_TTL_MS = 30_000;
const tickets = new Map(); // ticket -> expiresAt

// per-IP login throttle. Only FAILED attempts count, and a success clears the
// counter, so normal logins and reconnects never trip it — only repeated wrong
// passwords do.
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 20;
const attempts = new Map(); // ip -> { count, resetAt }

export function passwordConfigured() {
  return PASSWORD.length > 0;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // still compare to avoid trivial length timing leak
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() > a.resetAt) return false;
  return a.count >= MAX_ATTEMPTS;
}

export function noteFailedAttempt(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now > a.resetAt) {
    a = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, a);
  }
  a.count += 1;
}

export function clearAttempts(ip) {
  attempts.delete(ip);
}

// Returns a fresh one-time ticket string on success, or null on bad password.
export function login(password) {
  if (!PASSWORD) return null;
  if (typeof password !== "string") return null;
  if (!constantTimeEqual(password, PASSWORD)) return null;
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, Date.now() + TICKET_TTL_MS);
  return ticket;
}

// Consumes a ticket. Returns true exactly once per valid, unexpired ticket.
export function consumeTicket(ticket) {
  const exp = tickets.get(ticket);
  if (exp === undefined) return false;
  tickets.delete(ticket);
  return Date.now() <= exp;
}

export function sweepTickets() {
  const now = Date.now();
  for (const [t, exp] of tickets) if (now > exp) tickets.delete(t);
}

// WebSocket upgrade Origin check. Browsers always send Origin for ws; a
// missing Origin (non-browser client) is rejected.
export function originAllowed(origin, host) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);
  // Dev fallback: accept same-host origin over http/https.
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch {
    return false;
  }
}
