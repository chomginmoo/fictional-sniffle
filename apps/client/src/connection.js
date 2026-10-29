// connection.js — login, WebSocket lifecycle, auto-reconnect, send().
// The password is held only in memory for the life of the page (for silent
// reconnect); a page refresh clears it and forces re-login.

let ws = null;
let password = ""; // memory only, never stored
let handlers = {};
let reconnectDelay = 500;
let manualClose = false;

export function setHandlers(h) {
  handlers = h;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

async function getTicket() {
  const r = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || "login failed");
  }
  const { ticket } = await r.json();
  return ticket;
}

async function open() {
  let ticket;
  try {
    ticket = await getTicket();
  } catch (e) {
    handlers.onAuthError?.(e.message);
    return;
  }
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    reconnectDelay = 500;
    ws.send(JSON.stringify({ t: "auth", ticket }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      handlers.onMessage?.(m);
    } else {
      handlers.onBinary?.(ev.data);
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    handlers.onClose?.(ev.code, ev.reason);
    if (manualClose) return;
    // 4001-4004 are auth failures: don't hammer, surface to user.
    if (ev.code >= 4001 && ev.code <= 4004) {
      handlers.onAuthError?.(ev.reason || "인증 실패");
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose handles it */
  };
}

function scheduleReconnect() {
  handlers.onReconnecting?.();
  setTimeout(() => {
    if (!manualClose) open();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

export async function connect(pw) {
  password = pw;
  manualClose = false;
  await open();
}

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

export function close() {
  manualClose = true;
  password = "";
  if (ws) ws.close(1000, "client-close");
}

export function isOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
