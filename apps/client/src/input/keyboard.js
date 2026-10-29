// keyboard.js — physical key capture on the hidden sink. During IME
// composition (isComposing / keyCode 229) we stay out of the way and let
// ime.js handle it, so Korean input is never double-typed.
import { send } from "../connection.js";

function mods(ev) {
  return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
}

// Keys whose default we must not swallow (so the browser-level combo still
// reaches ChromeOS if it needs to) — keep this list tiny.
const PASSTHROUGH = new Set(["F5", "F11", "F12"]);

function printableText(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return "";
  if (ev.key && ev.key.length === 1) return ev.key;
  return "";
}

export function attachKeyboard(sink) {
  sink.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return; // IME in progress
    if (PASSTHROUGH.has(ev.key)) return;
    ev.preventDefault(); // block local action + keep the sink empty
    send({
      t: "key",
      op: "down",
      key: ev.key,
      code: ev.code,
      vk: ev.keyCode || 0,
      mods: mods(ev),
      text: printableText(ev),
    });
  });

  sink.addEventListener("keyup", (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (PASSTHROUGH.has(ev.key)) return;
    ev.preventDefault();
    send({
      t: "key",
      op: "up",
      key: ev.key,
      code: ev.code,
      vk: ev.keyCode || 0,
      mods: mods(ev),
    });
  });

  // Paste -> send text to remote, never let it land in the sink.
  sink.addEventListener("paste", (ev) => {
    ev.preventDefault();
    const text = (ev.clipboardData || window.clipboardData)?.getData("text") || "";
    if (text) send({ t: "text", text });
  });
}
