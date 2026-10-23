#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE="$APP_ROOT/runtime/node"
ENTRY="$APP_ROOT/dist/index.js"
[[ -x "$NODE" && -f "$ENTRY" ]] || { echo "PhotoMesh node package is incomplete." >&2; exit 1; }
export PHOTOMESH_DATA_DIR="${PHOTOMESH_DATA_DIR:-$HOME/.local/share/photomesh}"
mkdir -p "$PHOTOMESH_DATA_DIR"
export PORT="${PORT:-8443}"
export PHOTOMESH_API_BIND_ADDRESS="${PHOTOMESH_API_BIND_ADDRESS:-127.0.0.1}"
if [[ -z "${PHOTOMESH_ADMIN_TOKEN:-}" ]]; then
  read -r -s -p "Admin token (blank to generate): " PHOTOMESH_ADMIN_TOKEN; echo
  if [[ -z "$PHOTOMESH_ADMIN_TOKEN" ]]; then
    PHOTOMESH_ADMIN_TOKEN="$(openssl rand -base64 32)"
    printf 'Generated admin token (save it in your password manager):\n%s\n' "$PHOTOMESH_ADMIN_TOKEN"
  fi
fi
export PHOTOMESH_ADMIN_TOKEN
if [[ -z "${PHOTOMESH_EXTERNAL_ROOTS:-}" ]]; then
  read -r -p "Optional external photo folder (blank to skip): " PHOTO_ROOT
  if [[ -n "$PHOTO_ROOT" ]]; then
    [[ -d "$PHOTO_ROOT" ]] || { echo "Photo folder does not exist." >&2; exit 1; }
    PHOTO_ROOT="$(cd -- "$PHOTO_ROOT" && pwd)"
    export PHOTO_ROOT
    PHOTOMESH_EXTERNAL_ROOTS="$("$NODE" -e 'console.log(JSON.stringify([{rootId:"user-photos",libraryId:"user-photos",path:process.env.PHOTO_ROOT,pathStyle:"posix"}]))')"
    export PHOTOMESH_EXTERNAL_ROOTS
  fi
fi
echo "Node API: http://127.0.0.1:$PORT  (Ctrl+C stops the node)"
exec "$NODE" "$ENTRY"
