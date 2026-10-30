// ui.js — toolbar, tab bar, address bar, dialogs, toasts. Remote-controlled
// strings (titles, urls, dialog text, file names) are only ever written with
// textContent / value — never innerHTML — so a hostile page title cannot
// inject markup.
import { send } from "./connection.js";
import { setScale } from "./viewer.js";

let el = {};
let addressEditing = false;
let toastTimer = null;
let pendingDialogId = null;

// Performance presets. "보통" is the default — tuned for a weak Chromebook:
// fewer rendered pixels (scale), lower JPEG quality, capped frame rate.
const PERF_MODES = [
  { name: "선명", scale: 1.0, quality: 80, fps: 30 },
  { name: "보통", scale: 0.85, quality: 60, fps: 26 },
  { name: "절약", scale: 0.65, quality: 42, fps: 20 },
];
let perfIndex = 1;

export function init() {
  el = {
    login: document.getElementById("login"),
    loginForm: document.getElementById("login-form"),
    password: document.getElementById("password"),
    loginError: document.getElementById("login-error"),
    app: document.getElementById("app"),
    tabbar: document.getElementById("tabbar"),
    back: document.getElementById("back"),
    forward: document.getElementById("forward"),
    reload: document.getElementById("reload"),
    address: document.getElementById("address"),
    newtab: document.getElementById("newtab"),
    perf: document.getElementById("perf"),
    burn: document.getElementById("burn"),
    progress: document.getElementById("progress"),
    dialog: document.getElementById("dialog"),
    dialogMsg: document.getElementById("dialog-msg"),
    dialogInput: document.getElementById("dialog-input"),
    dialogOk: document.getElementById("dialog-ok"),
    dialogCancel: document.getElementById("dialog-cancel"),
    toast: document.getElementById("toast"),
  };

  el.back.addEventListener("click", () => send({ t: "nav", op: "back" }));
  el.forward.addEventListener("click", () => send({ t: "nav", op: "forward" }));
  el.reload.addEventListener("click", () => send({ t: "nav", op: "reload" }));
  el.newtab.addEventListener("click", () => send({ t: "tab", op: "new" }));

  // restore saved performance mode
  try {
    const saved = Number(localStorage.getItem("perfIndex"));
    if (saved >= 0 && saved < PERF_MODES.length) perfIndex = saved;
  } catch {
    /* storage may be unavailable */
  }
  el.perf.textContent = PERF_MODES[perfIndex].name;
  el.perf.addEventListener("click", () => {
    perfIndex = (perfIndex + 1) % PERF_MODES.length;
    try {
      localStorage.setItem("perfIndex", String(perfIndex));
    } catch {
      /* ignore */
    }
    applyPerf();
    toast(`성능 모드: ${PERF_MODES[perfIndex].name}`);
  });
  el.burn.addEventListener("click", () => {
    if (confirm("현재 세션을 파기할까요? 모든 탭이 닫힙니다.")) send({ t: "burn" });
  });

  el.address.addEventListener("focus", () => {
    addressEditing = true;
    el.address.select();
  });
  el.address.addEventListener("blur", () => (addressEditing = false));
  el.address.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const input = el.address.value;
      send({ t: "go", input });
      el.address.blur();
    }
  });

  el.dialogOk.addEventListener("click", () => resolveDialog(true));
  el.dialogCancel.addEventListener("click", () => resolveDialog(false));
}

export function showBrowser() {
  el.login.classList.add("hidden");
  el.app.classList.remove("hidden");
}

export function showLogin(errMsg) {
  el.app.classList.add("hidden");
  el.login.classList.remove("hidden");
  if (errMsg) {
    el.loginError.textContent = errMsg;
    el.loginError.classList.remove("hidden");
  }
  el.password.value = "";
  el.password.focus();
}

export function onState(m) {
  if (!addressEditing && typeof m.url === "string") el.address.value = m.url;
  el.back.disabled = !m.back;
  el.forward.disabled = !m.fwd;
  el.progress.classList.toggle("hidden", !m.loading);
}

export function onTabs(m) {
  el.tabbar.replaceChildren();
  if (!m.list || m.list.length <= 1) {
    // single tab: hide the bar entirely to save space
    el.tabbar.classList.add("hidden");
  } else {
    el.tabbar.classList.remove("hidden");
  }
  for (const t of m.list || []) {
    const tab = document.createElement("div");
    tab.className = "tab" + (t.active ? " active" : "");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = t.title || "새 탭";
    tab.appendChild(label);
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      send({ t: "tab", op: "close", id: t.id });
    });
    tab.appendChild(x);
    tab.addEventListener("click", () => send({ t: "tab", op: "switch", id: t.id }));
    el.tabbar.appendChild(tab);
  }
}

export function onDialog(m) {
  pendingDialogId = m.id;
  el.dialogMsg.textContent = m.message || "";
  const isPrompt = m.kind === "prompt";
  el.dialogInput.classList.toggle("hidden", !isPrompt);
  el.dialogInput.value = m.defaultValue || "";
  el.dialogCancel.classList.toggle("hidden", m.kind === "alert");
  el.dialog.classList.remove("hidden");
  if (isPrompt) el.dialogInput.focus();
  else el.dialogOk.focus();
}

function resolveDialog(accept) {
  if (pendingDialogId == null) return;
  send({ t: "dialog", id: pendingDialogId, accept, text: el.dialogInput.value });
  pendingDialogId = null;
  el.dialog.classList.add("hidden");
}

export function onDownload(m) {
  toast(`다운로드: ${m.name} (현재 버전은 서버에 저장되지 않고 폐기됩니다)`);
}

export function onBye(reason) {
  const reasons = {
    idle: "장시간 입력이 없어 세션이 종료되었습니다.",
    burned: "세션을 파기했습니다.",
    replaced: "다른 곳에서 로그인되어 이 세션이 종료되었습니다.",
    "no-tabs": "모든 탭이 닫혀 세션이 종료되었습니다.",
    "start-failed": "브라우저를 시작하지 못했습니다. 서버 터미널 로그를 확인하세요 (브라우저 미설치일 가능성).",
  };
  showLogin(reasons[reason] || "세션이 종료되었습니다.");
}

export function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

export function focusSink() {
  document.getElementById("sink").focus({ preventScroll: true });
}

// Apply the current performance mode: tell the server the quality/fps and set
// the client render scale (which also drives the resize message).
export function applyPerf() {
  const m = PERF_MODES[perfIndex];
  el.perf.textContent = m.name;
  send({ t: "perf", quality: m.quality, fps: m.fps });
  setScale(m.scale);
}
