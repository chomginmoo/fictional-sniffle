// protocol.js — message shapes + strict validation.
// The server trusts nothing from the client: every inbound message is
// validated here before it reaches session/tab/input logic.

// Binary server->client frame layout (big-endian):
//   [0]      uint8   type   (1 = screencast frame)
//   [1..2]   uint16  tabId
//   [3..6]   uint32  frame sequence
//   [7..8]   uint16  width  (device px)
//   [9..10]  uint16  height (device px)
//   [11..]   JPEG bytes
export const FRAME_HEADER_BYTES = 11;
export const MSG_FRAME = 1;

export function encodeFrameHeader(tabId, seq, w, h) {
  const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  head.writeUInt8(MSG_FRAME, 0);
  head.writeUInt16BE(tabId & 0xffff, 1);
  head.writeUInt32BE(seq >>> 0, 3);
  head.writeUInt16BE(w & 0xffff, 7);
  head.writeUInt16BE(h & 0xffff, 9);
  return head;
}

const MAX_MSG_BYTES = 64 * 1024; // inbound JSON text cap
const MAX_TEXT = 8 * 1024; // typed/pasted text cap per message

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(v)));

// Returns a sanitized message object, or throws Error on anything invalid.
export function parseClientMessage(raw) {
  if (typeof raw !== "string") throw new Error("non-text frame");
  if (raw.length > MAX_MSG_BYTES) throw new Error("message too large");
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error("bad json");
  }
  if (!m || typeof m !== "object" || typeof m.t !== "string") {
    throw new Error("missing type");
  }

  switch (m.t) {
    case "auth":
      if (typeof m.ticket !== "string" || m.ticket.length > 128)
        throw new Error("bad ticket");
      return { t: "auth", ticket: m.ticket };

    case "resize":
      if (!isFiniteNum(m.w) || !isFiniteNum(m.h)) throw new Error("bad size");
      return {
        t: "resize",
        w: clampInt(m.w, 200, 8000),
        h: clampInt(m.h, 200, 8000),
        dpr: isFiniteNum(m.dpr) ? Math.max(1, Math.min(4, m.dpr)) : 1,
      };

    case "go":
      if (typeof m.input !== "string" || m.input.length > 4096)
        throw new Error("bad input");
      return { t: "go", input: m.input };

    case "nav": {
      const ops = ["back", "forward", "reload", "stop"];
      if (!ops.includes(m.op)) throw new Error("bad nav op");
      return { t: "nav", op: m.op };
    }

    case "mouse": {
      const ops = ["down", "up", "move"];
      if (!ops.includes(m.op)) throw new Error("bad mouse op");
      if (!isFiniteNum(m.x) || !isFiniteNum(m.y)) throw new Error("bad coords");
      const btns = ["left", "middle", "right", "none"];
      return {
        t: "mouse",
        op: m.op,
        x: clampInt(m.x, 0, 8000),
        y: clampInt(m.y, 0, 8000),
        btn: btns.includes(m.btn) ? m.btn : "left",
        clicks: isInt(m.clicks) ? clampInt(m.clicks, 1, 3) : 1,
        mods: isInt(m.mods) ? clampInt(m.mods, 0, 15) : 0,
      };
    }

    case "wheel":
      if (!isFiniteNum(m.x) || !isFiniteNum(m.y)) throw new Error("bad coords");
      return {
        t: "wheel",
        x: clampInt(m.x, 0, 8000),
        y: clampInt(m.y, 0, 8000),
        dx: isFiniteNum(m.dx) ? clampInt(m.dx, -4000, 4000) : 0,
        dy: isFiniteNum(m.dy) ? clampInt(m.dy, -4000, 4000) : 0,
        mods: isInt(m.mods) ? clampInt(m.mods, 0, 15) : 0,
      };

    case "key": {
      if (m.op !== "down" && m.op !== "up") throw new Error("bad key op");
      if (typeof m.key !== "string" || m.key.length > 32)
        throw new Error("bad key");
      return {
        t: "key",
        op: m.op,
        key: m.key,
        code: typeof m.code === "string" ? m.code.slice(0, 32) : "",
        vk: isInt(m.vk) ? clampInt(m.vk, 0, 255) : 0,
        mods: isInt(m.mods) ? clampInt(m.mods, 0, 15) : 0,
        text: typeof m.text === "string" && m.text.length <= 8 ? m.text : "",
      };
    }

    case "ime":
      if (typeof m.text !== "string" || m.text.length > 256)
        throw new Error("bad ime text");
      return { t: "ime", text: m.text };

    case "text":
      if (typeof m.text !== "string" || m.text.length > MAX_TEXT)
        throw new Error("bad text");
      return { t: "text", text: m.text };

    case "tab": {
      const ops = ["new", "close", "switch"];
      if (!ops.includes(m.op)) throw new Error("bad tab op");
      return {
        t: "tab",
        op: m.op,
        id: isInt(m.id) ? clampInt(m.id, 0, 65535) : undefined,
      };
    }

    case "dialog":
      if (!isInt(m.id)) throw new Error("bad dialog id");
      return {
        t: "dialog",
        id: clampInt(m.id, 0, 2 ** 31),
        accept: !!m.accept,
        text: typeof m.text === "string" ? m.text.slice(0, 4096) : "",
      };

    case "ack":
      return { t: "ack", frame: isInt(m.frame) ? m.frame >>> 0 : 0 };

    case "ping":
      return { t: "ping" };

    case "burn":
      return { t: "burn" };

    default:
      throw new Error("unknown type: " + m.t);
  }
}
