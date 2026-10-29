// input.js — translate validated client input messages into CDP Input calls.
// The client never sends raw CDP; only the fixed message set in protocol.js,
// which we map here.

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 (same as our wire mods).
function mouseButtons(btn) {
  // CDP "buttons" bitfield for move events: left=1, right=2, middle=4
  switch (btn) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    default:
      return 0;
  }
}

export async function handleMouse(cdp, m) {
  const type =
    m.op === "down"
      ? "mousePressed"
      : m.op === "up"
        ? "mouseReleased"
        : "mouseMoved";
  const params = {
    type,
    x: m.x,
    y: m.y,
    modifiers: m.mods,
    buttons: m.op === "move" ? mouseButtons(m.btn) : undefined,
  };
  if (m.op !== "move") {
    params.button = m.btn;
    params.clickCount = m.clicks;
  }
  await cdp.send("Input.dispatchMouseEvent", params);
}

export async function handleWheel(cdp, m) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: m.x,
    y: m.y,
    deltaX: m.dx,
    deltaY: m.dy,
    modifiers: m.mods,
  });
}

export async function handleKey(cdp, m) {
  const type = m.op === "down" ? "keyDown" : "keyUp";
  const params = {
    type,
    key: m.key,
    code: m.code || undefined,
    windowsVirtualKeyCode: m.vk || undefined,
    modifiers: m.mods,
  };
  // For printable characters, CDP needs `text` on keyDown to actually insert
  // the character; "rawKeyDown" otherwise for non-text keys.
  if (type === "keyDown") {
    if (m.text) {
      params.text = m.text;
    } else {
      params.type = "rawKeyDown";
    }
  }
  await cdp.send("Input.dispatchKeyEvent", params);
}

// IME composition (interim text shown while composing, e.g. ㅎ -> 하 -> 한).
export async function handleIme(cdp, text) {
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

// Commit text (composition end, or paste).
export async function handleText(cdp, text) {
  await cdp.send("Input.insertText", { text });
}
