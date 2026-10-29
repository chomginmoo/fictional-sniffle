// ime.js — Korean (and any IME) composition. While composing we stream the
// interim text (ㅎ -> 하 -> 한) to the remote input; on commit we send the
// final text. The sink is kept empty afterwards so nothing is stored locally.
import { send } from "../connection.js";

export function attachIme(sink) {
  let composing = false;

  sink.addEventListener("compositionstart", () => {
    composing = true;
  });

  sink.addEventListener("compositionupdate", (ev) => {
    send({ t: "ime", text: ev.data || "" });
  });

  sink.addEventListener("compositionend", (ev) => {
    composing = false;
    const text = ev.data || "";
    if (text) send({ t: "text", text });
    // clear interim composition on the remote, then wipe the local sink
    else send({ t: "ime", text: "" });
    queueMicrotask(() => (sink.value = ""));
  });

  // Safety net: if any text lands in the sink outside composition, forward and
  // clear it (e.g. on-screen keyboard in tablet mode).
  sink.addEventListener("input", (ev) => {
    if (composing) return;
    if (ev.inputType === "insertFromPaste") return; // handled in keyboard.js
    const v = sink.value;
    if (v) {
      send({ t: "text", text: v });
      sink.value = "";
    }
  });
}
