// index.js — HTTP (static client + /login) and WebSocket (/ws) entry point.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  login,
  consumeTicket,
  originAllowed,
  tooManyAttempts,
  noteFailedAttempt,
  clearAttempts,
  passwordConfigured,
  sweepTickets,
} from "./auth.js";
import { parseClientMessage } from "./protocol.js";
import { Session } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, "../../client");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

if (!passwordConfigured()) {
  console.error(
    "[fatal] APP_PASSWORD is not set. Refusing to start an open proxy.\n" +
      "        Set APP_PASSWORD to a strong secret and restart.",
  );
  process.exit(1);
}

// --- security headers (privacy + XSS/clickjacking/SSRF-surface reduction) ---
function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "connect-src 'self'", // same-origin ws/wss is covered by 'self'
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  );
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Cache-Control", "no-store");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function clientIp(req) {
  return (req.socket.remoteAddress || "unknown").toString();
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // prevent path traversal
  const full = path.normalize(path.join(CLIENT_DIR, urlPath));
  if (!full.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(full, (err, data) => {
    securityHeaders(res);
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.setHeader("Content-Type", MIME[path.extname(full)] || "application/octet-stream");
    res.writeHead(200);
    res.end(data);
  });
}

function handleLogin(req, res) {
  const ip = clientIp(req);
  if (tooManyAttempts(ip)) {
    securityHeaders(res);
    res.writeHead(429, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "too many attempts" }));
  }
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > 4096) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    securityHeaders(res);
    if (tooBig) {
      res.writeHead(413);
      return res.end();
    }
    let pw = "";
    try {
      pw = JSON.parse(body).password;
    } catch {
      /* ignore */
    }
    const ticket = login(pw);
    if (!ticket) {
      noteFailedAttempt(ip);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid" }));
    }
    clearAttempts(ip); // success resets the counter
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ticket }));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/login") return handleLogin(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  securityHeaders(res);
  res.writeHead(405);
  res.end();
});

// ---------------------------- WebSocket ----------------------------
let currentSession = null;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let authed = false;
  let session = null;

  // must authenticate within 5s
  const authTimer = setTimeout(() => {
    if (!authed) ws.close(4001, "auth timeout");
  }, 5000);

  // crude per-connection message rate limit
  let msgCount = 0;
  const rlTimer = setInterval(() => {
    msgCount = 0;
  }, 1000);

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return; // client never sends binary
    if (++msgCount > 600) return; // drop floods
    let m;
    try {
      m = parseClientMessage(data.toString());
    } catch {
      ws.close(4002, "bad message");
      return;
    }

    if (!authed) {
      if (m.t !== "auth") {
        ws.close(4003, "not authed");
        return;
      }
      if (!consumeTicket(m.ticket)) {
        ws.close(4004, "bad ticket");
        return;
      }
      authed = true;
      clearTimeout(authTimer);

      // replace any existing session (single user). Tell the old client it was
      // replaced so it stops (instead of auto-reconnecting into a ping-pong).
      if (currentSession) {
        const old = currentSession;
        currentSession = null;
        old.send({ t: "bye", reason: "replaced" });
        old.burn("replaced").catch(() => {});
      }
      session = new Session();
      session.onDead = (reason) => {
        if (currentSession === session) currentSession = null;
        try {
          ws.close(1000, reason);
        } catch {
          /* ignore */
        }
      };
      currentSession = session;
      session.bindSocket(ws);
      try {
        await session.start(); // start() sends its own hello (with stream mode)
      } catch (e) {
        // Log the REAL reason to the server terminal/log (was swallowed before)
        console.error("[render-server] browser start failed:", e?.message || e);
        const reason = String(e?.message || e).split("\n")[0].slice(0, 180);
        session.send({ t: "err", message: "브라우저 시작 실패: " + reason });
        // Send bye so the client stops auto-reconnecting into a failure loop.
        session.send({ t: "bye", reason: "start-failed" });
        session.burn("start-failed").catch(() => {});
      }
      return;
    }

    if (session) {
      try {
        await session.handle(m);
      } catch {
        /* keep the connection alive on per-message errors */
      }
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(rlTimer);
    if (session) session.unbindSocket(ws);
  });
  ws.on("error", () => {
    /* close handler does cleanup */
  });
});

setInterval(sweepTickets, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[render-server] listening on http://${HOST}:${PORT}`);
  console.log(`[render-server] headless=${process.env.HEADLESS !== "false"}`);
});
