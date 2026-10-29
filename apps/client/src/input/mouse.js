// mouse.js — pointer + wheel capture. Move/wheel events are coalesced to one
// per animation frame so a touchpad can't flood the socket.
import { send } from "../connection.js";
import { toRemoteCoords } from "../viewer.js";

function mods(ev) {
  return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
}
function btn(ev) {
  return ev.button === 1 ? "middle" : ev.button === 2 ? "right" : "left";
}

export function attachMouse(canvas, sink) {
  let pendingMove = null;
  let pendingWheel = null;
  let flushQueued = false;

  function flush() {
    flushQueued = false;
    if (pendingMove) {
      send(pendingMove);
      pendingMove = null;
    }
    if (pendingWheel) {
      send(pendingWheel);
      pendingWheel = null;
    }
  }
  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  }

  canvas.addEventListener("mousemove", (ev) => {
    const { x, y } = toRemoteCoords(ev);
    pendingMove = { t: "mouse", op: "move", x, y, btn: "none", mods: mods(ev) };
    queueFlush();
  });

  canvas.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    sink.focus({ preventScroll: true }); // keep keyboard/IME flowing
    const { x, y } = toRemoteCoords(ev);
    send({ t: "mouse", op: "down", x, y, btn: btn(ev), clicks: ev.detail || 1, mods: mods(ev) });
  });

  window.addEventListener("mouseup", (ev) => {
    const { x, y } = toRemoteCoords(ev);
    send({ t: "mouse", op: "up", x, y, btn: btn(ev), clicks: ev.detail || 1, mods: mods(ev) });
  });

  // Right-click: suppress the local menu, forward to remote.
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault(); // block local zoom/scroll; forward instead
      const { x, y } = toRemoteCoords(ev);
      const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1; // lines/pages -> px
      if (!pendingWheel) {
        pendingWheel = { t: "wheel", x, y, dx: 0, dy: 0, mods: mods(ev) };
      }
      pendingWheel.x = x;
      pendingWheel.y = y;
      pendingWheel.dx += ev.deltaX * mult;
      pendingWheel.dy += ev.deltaY * mult;
      queueFlush();
    },
    { passive: false },
  );
}
