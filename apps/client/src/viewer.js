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
let videoEl = null;
let surfaceEl = null; // the element currently showing content (canvas or video)
let mode = "jpeg";
let latestBitmap = null;
let frameW = 0;
let frameH = 0;
let rafPending = false;
let resizeTimer = null;

// The page viewport size we last told the server (= our CSS size). Capture
// scale is handled server-side and does NOT change this, so switching perf
// mode never resizes/reflows the page. In video mode this is the fixed display
// size the server captures.
let viewportW = 0;
let viewportH = 0;

// newest-raw-buffer decode pipeline (jpeg)
let pendingBuffer = null;
let decoding = false;

// MSE (video mode)
let mediaSource = null;
let sourceBuffer = null;
const appendQueue = [];

export function init(canvasEl, videoElement) {
  canvas = canvasEl;
  videoEl = videoElement;
  surfaceEl = canvas;
  ctx = canvas.getContext("2d", { alpha: false });
  const ro = new ResizeObserver(() => scheduleResize());
  ro.observe(canvas);
  window.addEventListener("resize", scheduleResize);
}

export function sendResize() {
  if (mode === "video" || !canvas) return; // video uses a fixed server-side size
  const w = Math.max(200, Math.round(canvas.clientWidth));
  const h = Math.max(200, Math.round(canvas.clientHeight));
  viewportW = w;
  viewportH = h;
  send({ t: "resize", w, h, dpr: 1 });
}

function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 150);
}

// Map a pointer event to remote PAGE coordinates (page viewport space).
export function toRemoteCoords(ev) {
  const rect = surfaceEl.getBoundingClientRect();
  // video is letterboxed (object-fit: contain) — map within the visible frame.
  let rx = rect.left,
    ry = rect.top,
    rw = rect.width,
    rh = rect.height;
  if (mode === "video" && viewportW && viewportH) {
    const scale = Math.min(rect.width / viewportW, rect.height / viewportH);
    const dw = viewportW * scale,
      dh = viewportH * scale;
    rx = rect.left + (rect.width - dw) / 2;
    ry = rect.top + (rect.height - dh) / 2;
    rw = dw;
    rh = dh;
  }
  const cssX = ev.clientX - rx;
  const cssY = ev.clientY - ry;
  const sx = viewportW && rw ? viewportW / rw : 1;
  const sy = viewportH && rh ? viewportH / rh : 1;
  const x = Math.max(0, Math.min(viewportW || 1e9, Math.round(cssX * sx)));
  const y = Math.max(0, Math.min(viewportH || 1e9, Math.round(cssY * sy)));
  return { x, y };
}

// ---- video mode (MediaSource) ----
export function initVideo({ width, height, codec }) {
  mode = "video";
  viewportW = width;
  viewportH = height;
  surfaceEl = videoEl;
  canvas.classList.add("hidden");
  videoEl.classList.remove("hidden");

  // Autoplay policy: a video with sound can't start without a user gesture, so
  // we start MUTED (plays immediately, picture shows) and automatically unmute
  // on the user's first interaction — no button needed. Sound is on by default
  // from the moment they click or type (which they do to use the browser).
  videoEl.muted = true;
  videoEl.playsInline = true;
  const unmute = () => {
    try {
      videoEl.muted = false;
      tryPlay();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("pointerdown", unmute, { once: true });
  window.addEventListener("keydown", unmute, { once: true });

  // once there's decodable data, make sure (muted) playback starts
  videoEl.addEventListener("canplay", () => tryPlay(), { once: true });

  mediaSource = new MediaSource();
  videoEl.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener("sourceopen", () => {
    try {
      if (!window.MediaSource || !MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)) {
        console.error("codec not supported by MSE:", codec);
      }
      sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codec}"`);
      sourceBuffer.mode = "sequence";
      sourceBuffer.addEventListener("updateend", flushVideo);
      flushVideo(); // in case chunks already queued before sourceopen
    } catch (e) {
      console.error("addSourceBuffer failed", e);
    }
  });
  tryPlay();
}

export function onVideoChunk(payload) {
  appendQueue.push(new Uint8Array(payload));
  flushVideo();
}

function flushVideo() {
  if (!sourceBuffer || sourceBuffer.updating || appendQueue.length === 0) return;
  // concatenate pending chunks into one append
  let total = 0;
  for (const c of appendQueue) total += c.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of appendQueue) {
    merged.set(c, off);
    off += c.byteLength;
  }
  appendQueue.length = 0;
  try {
    sourceBuffer.appendBuffer(merged);
  } catch (e) {
    // QuotaExceeded: trim and retry next tick
    trimBuffer(true);
  }
  keepLive();
}

function trimBuffer(force) {
  try {
    const b = videoEl.buffered;
    if (b.length && !sourceBuffer.updating) {
      const start = b.start(0);
      const cut = Math.min(videoEl.currentTime - 2, b.end(b.length - 1) - 1);
      if (cut > start + 1) sourceBuffer.remove(start, cut);
    }
  } catch {
    /* ignore */
  }
}

function keepLive() {
  try {
    const b = videoEl.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    // if we've drifted behind the live edge, jump forward
    if (end - videoEl.currentTime > 1.2) videoEl.currentTime = end - 0.25;
    trimBuffer(false);
  } catch {
    /* ignore */
  }
}

function tryPlay() {
  const p = videoEl.play?.();
  if (p && p.catch) p.catch(() => {}); // muted autoplay should succeed; ignore
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
  if (mode === "video" && videoEl) {
    try {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    } catch {
      /* ignore */
    }
    sourceBuffer = null;
    mediaSource = null;
    appendQueue.length = 0;
  }
}
