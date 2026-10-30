// session.js — one logged-in user session: a Chromium browser, its context,
// a set of tabs, and the WebSocket currently attached to it.
//
// Single-user design: there is at most one active session. A new login
// replaces the old one. On socket loss the session is kept alive for a short
// grace window so a flaky connection can resume without losing tabs.
import { launchBrowser, newContext } from "./browser.js";
import { Tab } from "./tab.js";
import { navigationAllowed, startPage } from "./urlPolicy.js";
import { encodeFrameHeader } from "./protocol.js";

const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60_000);
const GRACE_MS = Number(process.env.GRACE_MS || 60_000);
// Drop frames while the socket is this far behind. Kept small so scroll frames
// don't queue up and add latency (the client only ever draws the newest frame).
const SEND_HIGH_WATER = Number(process.env.SEND_HIGH_WATER || 256 * 1024);

export class Session {
  constructor() {
    this.browser = null;
    this.context = null;
    this.tabs = new Map();
    this.activeId = null;
    this.nextTabId = 1;
    this.ws = null;
    this.dialogs = new Map();
    this.nextDialogId = 1;
    this.width = 1280;
    this.height = 720;
    // performance knobs (client can change via a "perf" message)
    this.quality = Number(process.env.JPEG_QUALITY || 60);
    this.fps = Number(process.env.MAX_FPS || 24);
    this.motionFps = Number(process.env.MOTION_FPS || 40); // more frames while moving
    // Capture-resolution scale. Applied ONLY to the screencast image size, NOT
    // the page viewport — so changing perf mode never reflows the web page.
    this.captureScale = 1;
    // Motion-adaptive quality: while scrolling/moving we drop quality so more
    // frames fit through the link (smoother motion); when it stops we restore
    // full quality and a crisp frame is sent. This is the main scroll fix.
    this.motion = false;
    this.motionQuality = Number(process.env.MOTION_QUALITY || 35);
    this.motionIdleMs = Number(process.env.MOTION_IDLE_MS || 220);
    this._motionTimer = null;
    this.idleTimer = null;
    this.graceTimer = null;
    this.dead = false;
    // video mode (experimental): headful Chromium on Xvfb captured by ffmpeg
    this.video = process.env.STREAM_MODE === "video";
    this.ffmpeg = null;
    this.audio = false;
  }

  async start() {
    if (this.video) return this._startVideo();

    this.browser = await launchBrowser();
    this.context = await newContext(this.browser, {
      width: this.width,
      height: this.height,
    });

    await this._installRouteGuard();

    const tab = await this._makeTab();
    this.activeId = tab.id;
    await tab.setViewport(this.width, this.height);
    await tab.startCast();
    await tab.navigate(startPage);
    this.resetIdle();
    this.send(this._hello());
  }

  async _startVideo() {
    const { ensureEnv, startFfmpeg, codecString, VIDEO_W, VIDEO_H } = await import(
      "./videoStream.js"
    );
    const env = await ensureEnv();
    process.env.DISPLAY = env.display;
    this.width = VIDEO_W;
    this.height = VIDEO_H;

    this.browser = await launchBrowser({ video: true, width: VIDEO_W, height: VIDEO_H });
    this.context = await newContext(this.browser, { video: true });
    await this._installRouteGuard();

    const tab = await this._makeTab();
    this.activeId = tab.id;
    await tab.navigate(startPage);

    this.audio = false; // video-only
    this._codec = codecString();
    this.ffmpeg = startFfmpeg({
      display: env.display,
      width: env.width,
      height: env.height,
      fps: this.fps,
      onChunk: (buf) => this.sendVideo(buf),
      onClose: (code) => {
        if (!this.dead) this.send({ t: "err", message: "영상 인코더 종료됨 (ffmpeg exit " + code + ")" });
      },
      onError: (info) => {
        console.error("[render-server] ffmpeg:", String(info).slice(0, 200));
      },
    });

    this.resetIdle();
    this.send(this._hello());
  }

  async _installRouteGuard() {
    // Defense-in-depth SSRF guard on every request (firewall is primary).
    await this.context.route("**/*", (route) => {
      const url = route.request().url();
      if (!navigationAllowed(url)) return route.abort("blockedbyclient");
      return route.continue();
    });
  }

  _hello() {
    return {
      t: "hello",
      mode: this.video ? "video" : "jpeg",
      width: this.width,
      height: this.height,
      audio: this.audio,
      codec: this._codec || "",
    };
  }

  // Send a fragmented-MP4 chunk to the client (video mode). The stream must stay
  // in order and contiguous, so we never drop — unlike JPEG frames.
  sendVideo(buf) {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(Buffer.concat([Buffer.from([2]), buf]), { binary: true });
    } catch {
      /* ignore */
    }
  }

  async _makeTab(page) {
    const p = page || (await this.context.newPage());
    const tab = new Tab(this.nextTabId++, p, this);
    await tab.init();
    tab.page.on("popup", (pop) => this.adoptPopup(pop));
    this.tabs.set(tab.id, tab);
    return tab;
  }

  async adoptPopup(page) {
    const tab = await this._makeTab(page);
    await this.switchTab(tab.id);
    this.emitTabs();
  }

  bindSocket(ws) {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.ws = ws;
  }

  unbindSocket(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.dead) return;
    this.graceTimer = setTimeout(() => this.burn("grace-timeout"), GRACE_MS);
  }

  send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  sendFrame(tabId, seq, w, h, bytes) {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > SEND_HIGH_WATER) return; // backpressure: drop frame
    try {
      ws.send(Buffer.concat([encodeFrameHeader(tabId, seq, w, h), bytes]), {
        binary: true,
      });
    } catch {
      /* ignore */
    }
  }

  resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.send({ t: "bye", reason: "idle" });
      this.burn("idle");
    }, IDLE_MS);
  }

  // JPEG quality to use right now (lower while moving, full when still).
  currentQuality() {
    return this.motion ? Math.min(this.quality, this.motionQuality) : this.quality;
  }

  // Called on scroll/move/typing. Enters "motion" (low quality, high fps) and,
  // after a short quiet period, returns to full quality with a crisp frame.
  noteMotion() {
    if (!this.motion) {
      this.motion = true;
      if (this.active) this.active.startCast(); // re-arm at motion quality
    }
    if (this._motionTimer) clearTimeout(this._motionTimer);
    this._motionTimer = setTimeout(() => {
      this.motion = false;
      if (this.active) this.active.startCast(); // crisp frame at full quality
    }, this.motionIdleMs);
  }

  get active() {
    return this.tabs.get(this.activeId) || null;
  }

  emitTabs() {
    const list = [];
    for (const t of this.tabs.values()) {
      list.push({ id: t.id, title: t._title || "", active: t.id === this.activeId });
    }
    this.send({ t: "tabs", list });
  }

  async setViewport(w, h) {
    if (this.video) return; // video mode uses a fixed display size
    this.width = w;
    this.height = h;
    const a = this.active;
    if (a) await a.setViewport(w, h);
  }

  async newTab() {
    const tab = await this._makeTab();
    await this.switchTab(tab.id);
    await tab.navigate(startPage);
    this.emitTabs();
  }

  async switchTab(id) {
    const next = this.tabs.get(id);
    if (!next) return;
    const prev = this.active;
    if (prev && prev.id !== id) await prev.stopCast();
    this.activeId = id;
    await next.setViewport(this.width, this.height);
    await next.startCast();
    next.emitState();
    this.emitTabs();
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    await tab.close();
    this.tabs.delete(id);
    if (this.activeId === id) {
      const first = this.tabs.keys().next().value;
      if (first) await this.switchTab(first);
      else {
        this.send({ t: "bye", reason: "no-tabs" });
        await this.burn("no-tabs");
      }
    } else {
      this.emitTabs();
    }
  }

  onTabClosed(id) {
    if (!this.tabs.has(id)) return;
    this.tabs.delete(id);
    if (this.activeId === id) {
      const first = this.tabs.keys().next().value;
      if (first) this.switchTab(first).catch(() => {});
      else this.burn("no-tabs");
    } else {
      this.emitTabs();
    }
  }

  registerDialog(dialog) {
    const id = this.nextDialogId++;
    this.dialogs.set(id, dialog);
    return id;
  }

  async respondDialog(id, accept, text) {
    const d = this.dialogs.get(id);
    if (!d) return;
    this.dialogs.delete(id);
    try {
      if (accept) await d.accept(text || undefined);
      else await d.dismiss();
    } catch {
      /* already handled */
    }
  }

  // Route a validated client message to the active tab / session actions.
  async handle(m) {
    this.resetIdle();
    switch (m.t) {
      case "resize":
        await this.setViewport(m.w, m.h);
        break;
      case "go":
        if (this.active) await this.active.navigate(m.input);
        break;
      case "nav":
        if (this.active) await this.active.nav(m.op);
        break;
      case "wheel":
        this.noteMotion(); // scrolling -> motion quality for smoothness
        if (this.active) await this.active.input(m);
        break;
      case "mouse":
        if (m.op === "move") this.noteMotion();
        if (this.active) await this.active.input(m);
        break;
      case "key":
      case "ime":
      case "text":
        if (this.active) await this.active.input(m);
        break;
      case "tab":
        if (m.op === "new") await this.newTab();
        else if (m.op === "close") await this.closeTab(m.id ?? this.activeId);
        else if (m.op === "switch" && m.id != null) await this.switchTab(m.id);
        break;
      case "dialog":
        await this.respondDialog(m.id, m.accept, m.text);
        break;
      case "perf":
        if (this.video) break; // perf (jpeg quality/scale) doesn't apply to video
        this.quality = m.quality;
        this.fps = m.fps;
        this.captureScale = m.scale ?? 1;
        if (this.active) await this.active.startCast(); // re-apply quality/scale
        break;
      case "ack":
        break; // frame acks are advisory; bufferedAmount is the real signal
      case "ping":
        this.send({ t: "pong" });
        break;
      case "burn":
        this.send({ t: "bye", reason: "burned" });
        await this.burn("user-burn");
        break;
    }
  }

  async burn(reason) {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.ffmpeg = null;
    }
    for (const t of this.tabs.values()) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    this.tabs.clear();
    try {
      if (this.context) await this.context.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    // tell index.js to forget us
    if (this.onDead) this.onDead(reason);
  }
}
