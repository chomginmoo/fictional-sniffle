// videoStream.js — "video" streaming mode (experimental), VIDEO-ONLY.
//
// Runs a HEADFUL Chromium on a virtual X display (Xvfb) and captures it with
// ffmpeg as a low-latency fragmented-MP4 H.264 stream, which the browser plays
// via MediaSource. Smooth video (no audio), at the cost of more server CPU.
// Enabled with STREAM_MODE=video. Needs: Xvfb, ffmpeg (libx264).
import { spawn, spawnSync } from "node:child_process";

export const VIDEO_W = Number(process.env.VIDEO_W || 1280);
export const VIDEO_H = Number(process.env.VIDEO_H || 720);
const DISPLAY = process.env.VIDEO_DISPLAY || ":99";
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || "2500k";
const VIDEO_FPS = Number(process.env.VIDEO_FPS || 30);

let xvfb = null;
let envReady = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const have = (bin) => {
  try {
    return spawnSync("which", [bin]).status === 0;
  } catch {
    return false;
  }
};

// Start Xvfb (idempotent). Video-only, so no audio subsystem is needed.
export async function ensureEnv() {
  if (envReady) return { display: DISPLAY, width: VIDEO_W, height: VIDEO_H };
  if (!have("Xvfb")) throw new Error("Xvfb not installed (apt-get install xvfb)");
  if (!have("ffmpeg")) throw new Error("ffmpeg not installed (apt-get install ffmpeg)");

  xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${VIDEO_W}x${VIDEO_H}x24`, "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  xvfb.on("exit", () => {
    xvfb = null;
    envReady = false;
  });
  await delay(900);
  envReady = true;
  return { display: DISPLAY, width: VIDEO_W, height: VIDEO_H };
}

// MSE codec string matching our ffmpeg output (H.264 Constrained Baseline 3.1).
export function codecString() {
  return "avc1.42E01F";
}

// Spawn ffmpeg capturing the display -> fragmented MP4 on stdout.
// onChunk(Buffer) is called per output chunk (in order); onClose(code) on exit.
export function startFfmpeg({ display, width, height, fps = VIDEO_FPS, onChunk, onClose, onError }) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps),
    "-video_size", `${width}x${height}`, "-i", display,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-profile:v", "baseline", "-level:v", "3.1", "-pix_fmt", "yuv420p",
    "-g", String(fps * 2), "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "1M",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "100000", // ~100ms fragments for low latency
    "-f", "mp4", "pipe:1",
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  ff.stdout.on("data", onChunk);
  ff.on("close", (code) => onClose && onClose(code));
  ff.on("error", (e) => onError && onError(e));
  let errbuf = "";
  ff.stderr.on("data", (d) => {
    errbuf = (errbuf + d.toString()).slice(-400);
    if (onError && /error|Error|Invalid|No such|not found/.test(d.toString())) onError(errbuf);
  });
  return ff;
}

export function shutdownEnv() {
  try {
    if (xvfb) xvfb.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  xvfb = null;
  envReady = false;
}
