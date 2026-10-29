// privacy.js — keep the local browser's history/tab/forms free of any remote
// page information. The app's own URL stays a single fixed entry.
export function setupPrivacy() {
  // Lock the local title/icon no matter what the remote page is.
  const FIXED = "Viewer";
  document.title = FIXED;
  const obs = new MutationObserver(() => {
    if (document.title !== FIXED) document.title = FIXED;
  });
  const titleEl = document.querySelector("title");
  if (titleEl) obs.observe(titleEl, { childList: true });

  // Never push remote URLs into the local history: we never call pushState /
  // replaceState, and we strip any hash/query the page might have been opened
  // with so the address bar entry is clean.
  if (location.hash || location.search) {
    try {
      history.replaceState(null, FIXED, location.pathname);
    } catch {
      /* ignore */
    }
  }

  // Guard against accidental tab close while connected.
  let connected = false;
  window.addEventListener("beforeunload", (e) => {
    if (!connected) return;
    e.preventDefault();
    e.returnValue = "";
  });

  return {
    setConnected(v) {
      connected = v;
    },
  };
}
