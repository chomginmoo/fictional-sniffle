// viewer.js — draw incoming JPEG frames onto the canvas and report the
// viewport size to the server.
//
// Weak-device key point: we decode ONLY the newest frame. If frames arrive
// faster than this Chromebook can decode, intermediate frames are dropped
// *before* decoding (the expensive step), so CPU use is bounded by what the
// device can actually display instead of piling up stale decodes.
import { send } from "./connection.js";

const FRAME_HEADER_BYTES = 11;

let canvas = null;
let ctx = null;
let latestBitmap = null;
let frameW = 0;
let frameH = 0;
let rafPending = false;
let resizeTimer = null;

// render scale from the performance mode (1 = full, <1 = fewer pixels)
let renderScale = 1;

// newest-raw-buffer decode pipeline
let pendingBuffer = null; // most recent undecoded frame
let decoding = false;

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext("2d", { alpha: false });
  const ro = new ResizeObserver(() => scheduleResize());
  ro.observe(canvas);
  window.addEventListener("resize", scheduleResize);
}

export function setScale(scale) {
  renderScale = Math.max(0.3, Math.min(1, scale));
  sendResize();
}

export function sendResize() {
  if (!canvas) return;
  const w = Math.max(200, Math.round(canvas.clientWidth * renderScale));
  const h = Math.max(200, Math.round(canvas.clientHeight * renderScale));
  send({ t: "resize", w, h, dpr: 1 });
}

function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 150);
}

// Map a pointer event on the canvas to remote page coordinates. The frame is
// rendered at renderScale, so frameW/rect.width already carries that scale.
export function toRemoteCoords(ev) {
  const rect = canvas.getBoundingClientRect();
  const cssX = ev.clientX - rect.left;
  const cssY = ev.clientY - rect.top;
  const sx = frameW && rect.width ? frameW / rect.width : 1;
  const sy = frameH && rect.height ? frameH / rect.height : 1;
  return { x: Math.round(cssX * sx), y: Math.round(cssY * sy) };
}

// Called for every incoming binary frame. We only keep the newest buffer and
// let the decode loop catch up, dropping anything older still waiting.
export function onFrame(arrayBuffer) {
  pendingBuffer = arrayBuffer;
  if (!decoding) decodeLoop();
}

async function decodeLoop() {
  decoding = true;
  while (pendingBuffer) {
    const buf = pendingBuffer;
    pendingBuffer = null; // anything arriving during decode replaces this
    const view = new DataView(buf);
    if (view.byteLength < FRAME_HEADER_BYTES) continue;
    if (view.getUint8(0) !== 1) continue;
    const w = view.getUint16(7);
    const h = view.getUint16(9);
    let bitmap;
    try {
      bitmap = await createImageBitmap(
        new Blob([buf.slice(FRAME_HEADER_BYTES)], { type: "image/jpeg" }),
      );
    } catch {
      continue;
    }
    if (latestBitmap) latestBitmap.close();
    latestBitmap = bitmap;
    frameW = w;
    frameH = h;
    requestDraw();
  }
  decoding = false;
}

function requestDraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(draw);
}

function draw() {
  rafPending = false;
  if (!latestBitmap || !ctx) return;
  if (canvas.width !== frameW || canvas.height !== frameH) {
    canvas.width = frameW;
    canvas.height = frameH;
  }
  ctx.drawImage(latestBitmap, 0, 0);
}

export function clear() {
  pendingBuffer = null;
  if (latestBitmap) {
    latestBitmap.close();
    latestBitmap = null;
  }
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}
