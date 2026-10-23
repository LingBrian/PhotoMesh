#!/usr/bin/env bash
set -euo pipefail
VERSION='__VERSION__'
[[ "$VERSION" != "__VERSION__" ]] || { echo "Download install.sh from a PhotoMesh release." >&2; exit 1; }
REPO='LingBrian/PhotoMesh'
BASE="https://github.com/$REPO/releases/download/v$VERSION"
ASSET="PhotoMesh-$VERSION-node-agent-linux-x64.tar.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fL "$BASE/$ASSET" -o "$WORK/$ASSET"
curl -fL "$BASE/SHA256SUMS.txt" -o "$WORK/SHA256SUMS.txt"
LINE="$(grep -E "[[:space:]]$ASSET$" "$WORK/SHA256SUMS.txt" | head -n 1)"
[[ -n "$LINE" ]] || { echo "No checksum entry for $ASSET." >&2; exit 1; }
EXPECTED="$(printf '%s' "$LINE" | awk '{print $1}')"
ACTUAL="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo "SHA-256 verification failed." >&2; exit 1; }
DEST="${HOME}/.local/opt/photomesh/node-agent/$VERSION"
mkdir -p "$DEST"
tar -xzf "$WORK/$ASSET" -C "$DEST"
chmod +x "$DEST/runtime/node" "$DEST/start.sh"
echo "Installed PhotoMesh Node Agent $VERSION to $DEST"
exec "$DEST/start.sh"
