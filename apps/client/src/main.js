// main.js — wire together connection, viewer, input, and UI.
import * as conn from "./connection.js";
import * as viewer from "./viewer.js";
import * as ui from "./ui.js";
import { setupPrivacy } from "./privacy.js";
import { attachMouse } from "./input/mouse.js";
import { attachKeyboard } from "./input/keyboard.js";
import { attachIme } from "./input/ime.js";

const privacy = setupPrivacy();
ui.init();
viewer.init(document.getElementById("screen"));

// attach input handlers once
const canvas = document.getElementById("screen");
const sink = document.getElementById("sink");
attachMouse(canvas, sink);
attachKeyboard(sink);
attachIme(sink);

conn.setHandlers({
  onMessage(m) {
    switch (m.t) {
      case "hello":
        ui.showBrowser();
        privacy.setConnected(true);
        viewer.sendResize();
        ui.focusSink();
        break;
      case "state":
        ui.onState(m);
        break;
      case "tabs":
        ui.onTabs(m);
        break;
      case "dialog":
        ui.onDialog(m);
        break;
      case "download":
        ui.onDownload(m);
        break;
      case "err":
        ui.toast(m.message || "오류");
        break;
      case "bye":
        privacy.setConnected(false);
        conn.close();
        viewer.clear();
        ui.onBye(m.reason);
        break;
      case "pong":
        break;
    }
  },
  onBinary(buf) {
    viewer.onFrame(buf);
  },
  onAuthError(msg) {
    privacy.setConnected(false);
    ui.showLogin(msg || "인증 실패");
  },
  onReconnecting() {
    ui.toast("다시 연결 중…");
  },
  onClose() {
    /* reconnect logic lives in connection.js */
  },
});

document.getElementById("login-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const pw = document.getElementById("password").value;
  if (!pw) return;
  conn.connect(pw);
});

// keep the keyboard sink focused when the user clicks into the page area
document.getElementById("screen").addEventListener("click", () => ui.focusSink());

// periodic ping to keep the socket warm and detect death
setInterval(() => conn.send({ t: "ping" }), 25000);
