// videoStream.js — "video" streaming mode (experimental).
//
// Instead of per-frame JPEG (CDP screencast), we run a HEADFUL Chromium on a
// virtual X display (Xvfb) and capture it with ffmpeg as a low-latency
// fragmented-MP4 H.264 (+ Opus/AAC audio) stream, which the browser plays via
// MediaSource. This gives smooth video and sound, at the cost of more server
// CPU. Enabled with STREAM_MODE=video.
//
// Needs: Xvfb, ffmpeg (with libx264), and optionally pulseaudio for audio.
import { spawn, spawnSync } from "node:child_process";

export const VIDEO_W = Number(process.env.VIDEO_W || 1280);
export const VIDEO_H = Number(process.env.VIDEO_H || 720);
const DISPLAY = process.env.VIDEO_DISPLAY || ":99";
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || "2500k";

let xvfb = null;
let audioMonitor = null;
let envReady = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const have = (bin) => {
  try {
    return spawnSync("which", [bin]).status === 0;
  } catch {
    return false;
  }
};

// Start Xvfb + (best-effort) a PulseAudio null sink. Idempotent.
export async function ensureEnv() {
  if (envReady) return { display: DISPLAY, width: VIDEO_W, height: VIDEO_H, audioMonitor };

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

  // Audio: optional. If pulseaudio is present, create a null sink and capture
  // its monitor. If not, we stream video only.
  audioMonitor = null;
  if (have("pulseaudio") && have("pactl")) {
    try {
      spawnSync("pulseaudio", ["-D", "--exit-idle-time=-1"], { stdio: "ignore" });
      await delay(500);
      spawnSync("pactl", ["load-module", "module-null-sink", "sink_name=rbi",
        "sink_properties=device.description=rbi"], { stdio: "ignore" });
      spawnSync("pactl", ["set-default-sink", "rbi"], { stdio: "ignore" });
      audioMonitor = "rbi.monitor";
    } catch {
      audioMonitor = null;
    }
  }

  envReady = true;
  return { display: DISPLAY, width: VIDEO_W, height: VIDEO_H, audioMonitor };
}

// MSE codec string matching our ffmpeg output.
export function codecString(hasAudio) {
  // H.264 Constrained Baseline 3.1 + AAC-LC
  return hasAudio ? 'avc1.42E01F,mp4a.40.2' : "avc1.42E01F";
}

// Spawn ffmpeg capturing the display (+audio) -> fragmented MP4 on stdout.
// onChunk(Buffer) is called with each output chunk (in order); onClose(code) on exit.
export function startFfmpeg({ display, width, height, audioMonitor, fps = 30, onChunk, onClose }) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps),
    "-video_size", `${width}x${height}`, "-i", display,
  ];
  if (audioMonitor) args.push("-f", "pulse", "-i", audioMonitor);

  args.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    "-g", String(fps * 2), "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "1M",
  );
  if (audioMonitor) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");

  args.push(
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "100000", // ~100ms fragments for low latency
    "-f", "mp4", "pipe:1",
  );

  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  ff.stdout.on("data", onChunk);
  ff.on("close", (code) => onClose && onClose(code));
  ff.stderr.on("data", () => {}); // swallow (don't log URLs/anything)
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
