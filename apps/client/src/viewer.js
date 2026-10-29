// viewer.js — draw incoming JPEG frames onto the canvas and report the
// viewport size to the server. Only the newest frame is ever drawn, so a slow
// link just skips intermediate frames instead of lagging behind.
import { send } from "./connection.js";

const FRAME_HEADER_BYTES = 11;

let canvas = null;
let ctx = null;
let latestBitmap = null;
let frameW = 0;
let frameH = 0;
let rafPending = false;
let resizeTimer = null;

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext("2d", { alpha: false });
  const ro = new ResizeObserver(() => scheduleResize());
  ro.observe(canvas);
  window.addEventListener("resize", scheduleResize);
}

export function sendResize() {
  if (!canvas) return;
  const w = Math.max(200, Math.round(canvas.clientWidth));
  const h = Math.max(200, Math.round(canvas.clientHeight));
  const dpr = Math.min(4, window.devicePixelRatio || 1);
  send({ t: "resize", w, h, dpr });
}

function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 150);
}

// Map a pointer event on the canvas to remote page coordinates (CSS px).
// The server renders at the viewport size we sent, so this is ~1:1, with a
// small correction if the drawn frame differs from the canvas CSS size.
export function toRemoteCoords(ev) {
  const rect = canvas.getBoundingClientRect();
  const cssX = ev.clientX - rect.left;
  const cssY = ev.clientY - rect.top;
  const sx = frameW && rect.width ? frameW / rect.width : 1;
  const sy = frameH && rect.height ? frameH / rect.height : 1;
  return { x: Math.round(cssX * sx), y: Math.round(cssY * sy) };
}

export async function onFrame(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < FRAME_HEADER_BYTES) return;
  const type = view.getUint8(0);
  if (type !== 1) return;
  const w = view.getUint16(7);
  const h = view.getUint16(9);
  const jpeg = new Blob([arrayBuffer.slice(FRAME_HEADER_BYTES)], {
    type: "image/jpeg",
  });
  let bitmap;
  try {
    bitmap = await createImageBitmap(jpeg);
  } catch {
    return;
  }
  if (latestBitmap) latestBitmap.close();
  latestBitmap = bitmap;
  frameW = w;
  frameH = h;
  requestDraw();
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
  if (latestBitmap) {
    latestBitmap.close();
    latestBitmap = null;
  }
  if (ctx) ctx.fillStyle = "#000";
  if (ctx) ctx.fillRect(0, 0, canvas.width, canvas.height);
}
