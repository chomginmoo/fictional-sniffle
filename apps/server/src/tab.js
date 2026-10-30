// tab.js — one browser tab = one Playwright Page + its CDP session.
// Owns screencast capture, page-state events, dialogs, downloads, and input.
import { resolveAddress } from "./urlPolicy.js";
import { handleMouse, handleWheel, handleKey, handleIme, handleText } from "./input.js";

const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 70);

export class Tab {
  constructor(id, page, session) {
    this.id = id;
    this.page = page;
    this.session = session;
    this.cdp = null;
    this.casting = false;
    this.seq = 0;
    this.width = 1280;
    this.height = 720;
    this._stateTimer = null;
  }

  async init() {
    this.cdp = await this.page.context().newCDPSession(this.page);

    this.cdp.on("Page.screencastFrame", async (f) => {
      // Ack immediately so Chromium keeps capturing; client-side backpressure
      // is handled by session.sendFrame (drops when the socket is behind).
      const sessionId = f.sessionId;
      try {
        await this.cdp.send("Page.screencastFrameAck", { sessionId });
      } catch {
        /* tab closing */
      }
      if (!this.casting) return;
      // throttle to the session's target fps (we still ack every frame above so
      // Chromium keeps capturing; we just forward fewer to the weak client).
      // While moving/scrolling, allow a higher fps for smoother motion.
      const now = Date.now();
      const targetFps = this.session.motion
        ? this.session.motionFps || this.session.fps || 20
        : this.session.fps || 20;
      const minInterval = 1000 / targetFps;
      if (now - (this._lastSent || 0) < minInterval) return;
      this._lastSent = now;
      const bytes = Buffer.from(f.data, "base64");
      const w = f.metadata.deviceWidth || this.width;
      const h = f.metadata.deviceHeight || this.height;
      this.session.sendFrame(this.id, (this.seq = (this.seq + 1) >>> 0), w, h, bytes);
    });

    // Page state -> client (throttled a touch to avoid event storms).
    const onState = () => this._scheduleState();
    this.page.on("framenavigated", (fr) => {
      if (fr === this.page.mainFrame()) onState();
    });
    this.page.on("load", onState);
    this.page.on("domcontentloaded", onState);
    this.page.on("close", () => this.session.onTabClosed(this.id));

    // Dialogs: do not auto-dismiss; hand to the client.
    this.page.on("dialog", (dialog) => {
      const dlgId = this.session.registerDialog(dialog);
      this.session.send({
        t: "dialog",
        tab: this.id,
        id: dlgId,
        kind: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || "",
      });
    });

    // Downloads: v1 notifies the name only (file stays server-side and is
    // discarded). File transfer to the client is a later stage.
    this.page.on("download", async (dl) => {
      this.session.send({ t: "download", tab: this.id, name: dl.suggestedFilename() });
      try {
        await dl.cancel();
      } catch {
        /* ignore */
      }
    });
  }

  _scheduleState() {
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.emitState();
    }, 60);
  }

  emitState() {
    if (this.page.isClosed()) return;
    this.session.send({
      t: "state",
      tab: this.id,
      url: safeUrl(this.page),
      title: safeTitleSync(this),
      loading: this._loading === true,
      back: this._canBack,
      fwd: this._canFwd,
    });
    this.session.emitTabs();
  }

  async setViewport(w, h) {
    this.width = w;
    this.height = h;
    try {
      await this.page.setViewportSize({ width: w, height: h });
    } catch {
      /* page may be mid-close */
    }
    if (this.casting) await this.startCast();
  }

  async startCast() {
    if (!this.cdp) return;
    if (this.session.video) return; // video mode captures via ffmpeg, not screencast
    // If already casting (e.g. a quality/viewport change), restart so Chromium
    // emits a fresh frame with the new settings instead of silently ignoring
    // the second start.
    if (this.casting) {
      try {
        await this.cdp.send("Page.stopScreencast");
      } catch {
        /* ignore */
      }
    }
    try {
      // Viewport (this.width/height) is the full client size; the capture scale
      // only shrinks the streamed image, so the page never reflows on perf change.
      const scale = this.session.captureScale ?? 1;
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.session.currentQuality?.() ?? this.session.quality ?? JPEG_QUALITY,
        maxWidth: Math.max(200, Math.round(this.width * scale)),
        maxHeight: Math.max(200, Math.round(this.height * scale)),
        everyNthFrame: 1,
      });
      this.casting = true;
    } catch {
      /* ignore */
    }
  }

  async stopCast() {
    this.casting = false;
    try {
      await this.cdp.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
  }

  async navigate(input) {
    const res = resolveAddress(input);
    if (res.blocked) {
      this.session.send({ t: "err", message: "차단됨: " + res.blocked });
      return;
    }
    this._loading = true;
    this.emitState();
    try {
      await this.page.goto(res.url, { waitUntil: "commit", timeout: 30000 });
    } catch {
      /* navigation error surfaces in the page itself */
    } finally {
      this._loading = false;
      await this._refreshNav();
      this.emitState();
    }
  }

  async nav(op) {
    try {
      if (op === "back") await this.page.goBack({ timeout: 15000 }).catch(() => {});
      else if (op === "forward") await this.page.goForward({ timeout: 15000 }).catch(() => {});
      else if (op === "reload") await this.page.reload({ timeout: 30000 }).catch(() => {});
      else if (op === "stop") await this.cdp.send("Page.stopLoading").catch(() => {});
    } finally {
      await this._refreshNav();
      this.emitState();
    }
  }

  async _refreshNav() {
    // Best-effort back/forward availability via history length + position.
    try {
      const [len, idx] = await this.page.evaluate(() => [
        history.length,
        // not directly available; approximate
        0,
      ]);
      this._canBack = len > 1;
      this._canFwd = false; // forward state is hard to detect reliably; left false
    } catch {
      this._canBack = false;
      this._canFwd = false;
    }
  }

  async input(m) {
    if (!this.cdp) return;
    try {
      if (m.t === "mouse") await handleMouse(this.cdp, m);
      else if (m.t === "wheel") await handleWheel(this.cdp, m);
      else if (m.t === "key") await handleKey(this.cdp, m);
      else if (m.t === "ime") await handleIme(this.cdp, m.text);
      else if (m.t === "text") await handleText(this.cdp, m.text);
    } catch {
      /* input after close; ignore */
    }
  }

  async close() {
    await this.stopCast();
    try {
      await this.cdp.detach();
    } catch {
      /* ignore */
    }
    try {
      if (!this.page.isClosed()) await this.page.close();
    } catch {
      /* ignore */
    }
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}

// title cached on navigation-ish events; evaluate is async so we cache last.
function safeTitleSync(tab) {
  tab.page
    .title()
    .then((tt) => {
      if (tt !== tab._title) {
        tab._title = tt;
        tab.session.emitTabs();
      }
    })
    .catch(() => {});
  return tab._title || "";
}
