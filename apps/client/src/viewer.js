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

// WebCodecs (video mode): decode H.264 straight to the canvas. No <video> /
// blob: URL — some managed Chrome policies reject those media loads with a
// "URL safety check", but the canvas path (same as JPEG mode) is allowed.
let decoder = null;
let nalBuffer = new Uint8Array(0);
let gotKey = false;
let videoTs = 0;
const VIDEO_FRAME_US = 1000000 / 30;
let videoBytes = 0;
let statusCb = null;

export function setStatusHandler(fn) {
  statusCb = fn;
}
function status(msg) {
  try {
    statusCb && statusCb(msg);
  } catch {
    /* ignore */
  }
}

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

// ---- video mode: WebCodecs H.264 -> canvas (VIDEO-ONLY, no media element) ----
export function initVideo({ width, height, codec }) {
  mode = "video";
  viewportW = width;
  viewportH = height;
  surfaceEl = canvas; // video draws into the SAME canvas as JPEG mode
  videoBytes = 0;
  gotKey = false;
  nalBuffer = new Uint8Array(0);
  videoTs = 0;
  videoEl?.classList.add("hidden");
  canvas.classList.remove("hidden");

  if (!("VideoDecoder" in window)) {
    status("이 브라우저는 WebCodecs(영상 디코딩)를 지원하지 않습니다");
    return;
  }
  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        drawVideoFrame(frame);
        frame.close();
      },
      error: (e) => status("영상 디코더 오류: " + (e.message || e)),
    });
    decoder.configure({ codec, optimizeForLatency: true });
  } catch (e) {
    status("영상 디코더 초기화 실패: " + (e.message || e));
    return;
  }

  // Diagnostics: if no bytes arrive, the problem is server-side (ffmpeg/Xvfb).
  setTimeout(() => {
    if (mode === "video" && videoBytes === 0) {
      status("영상 데이터가 오지 않습니다 — 서버 ffmpeg/Xvfb를 확인하세요");
    }
  }, 5000);
}

function drawVideoFrame(frame) {
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  try {
    ctx.drawImage(frame, 0, 0);
  } catch {
    /* ignore */
  }
}

export function onVideoChunk(payload) {
  videoBytes += payload.byteLength;
  if (!decoder || decoder.state !== "configured") return;

  // accumulate and split into access units at AUD (NAL type 9) boundaries
  const chunk = new Uint8Array(payload);
  const merged = new Uint8Array(nalBuffer.length + chunk.length);
  merged.set(nalBuffer, 0);
  merged.set(chunk, nalBuffer.length);
  nalBuffer = merged;

  const auds = findAuds(nalBuffer);
  if (auds.length < 2) return; // need at least one complete access unit
  for (let i = 0; i < auds.length - 1; i++) {
    feedAccessUnit(nalBuffer.subarray(auds[i], auds[i + 1]));
  }
  nalBuffer = nalBuffer.slice(auds[auds.length - 1]); // keep trailing partial AU
}

// Byte offsets of AUD NAL units (start code + NAL type 9).
function findAuds(b) {
  const pos = [];
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue;
    let sc = 0;
    if (b[i + 2] === 1) sc = 3;
    else if (b[i + 2] === 0 && b[i + 3] === 1) sc = 4;
    if (sc && (b[i + sc] & 0x1f) === 9) pos.push(i);
  }
  return pos;
}

function hasNalType(b, t) {
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue;
    let sc = 0;
    if (b[i + 2] === 1) sc = 3;
    else if (b[i + 2] === 0 && b[i + 3] === 1) sc = 4;
    if (sc && (b[i + sc] & 0x1f) === t) return true;
  }
  return false;
}

function feedAccessUnit(au) {
  const isKey = hasNalType(au, 5) || hasNalType(au, 7); // IDR or SPS
  // Under overload, drop non-key frames and resync at the next keyframe so
  // latency can't snowball on a weak device.
  if (decoder.decodeQueueSize > 40 && !isKey) {
    gotKey = false;
    return;
  }
  if (!gotKey) {
    if (!isKey) return; // decoding must start on a keyframe
    gotKey = true;
  }
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: videoTs,
        data: au.slice(), // copy out of the shared buffer
      }),
    );
    videoTs += VIDEO_FRAME_US;
  } catch (e) {
    status("디코드 실패: " + (e.message || e));
    gotKey = false; // resync at next keyframe
  }
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
  if (mode === "video") {
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      /* ignore */
    }
    decoder = null;
    nalBuffer = new Uint8Array(0);
    gotKey = false;
  }
}
