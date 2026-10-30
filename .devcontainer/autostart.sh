#!/usr/bin/env bash
# Auto-start the render server when the Codespace starts, in the background, so
# you never have to open the terminal. It keeps running even if the VS Code
# editor tab crashes or you close it — only the Codespace stopping ends it.
#
# Password: uses the APP_PASSWORD env var if you set one (e.g. a Codespaces
# Secret named APP_PASSWORD). Otherwise it falls back to a throwaway test
# password so the auto-start always works. For anything beyond a quick test,
# set a real APP_PASSWORD secret.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR/apps/server" || exit 0

# Already up? (bash TCP probe; no curl dependency)
if (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null; then
  exec 3>&- 3<&-
  echo "render-server already running on :8080"
  exit 0
fi

export CHROMIUM_SANDBOX="${CHROMIUM_SANDBOX:-false}"
export APP_PASSWORD="${APP_PASSWORD:-test1234}"
export HEADLESS="${HEADLESS:-true}"

nohup node src/index.js > /tmp/render-server.log 2>&1 &
sleep 1
echo "render-server starting (password: ${APP_PASSWORD}; log: /tmp/render-server.log)"
