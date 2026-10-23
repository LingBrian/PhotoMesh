#!/usr/bin/env bash
set -euo pipefail
VERSION='__VERSION__'
[[ "$VERSION" != "__VERSION__" ]] || { echo "Download install.sh from a PhotoMesh release." >&2; exit 1; }
REPO='LingBrian/PhotoMesh'
ASSET="PhotoMesh-$VERSION-node-agent-linux-x64.tar.gz"
API="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ASSET_URL="$(curl -fsSL "$API" | python3 -c 'import json,sys; a=json.load(sys.stdin)["assets"]; n=sys.argv[1]; print(next(x["browser_download_url"] for x in a if x["name"]==n))' "$ASSET")"
SUM_URL="$(curl -fsSL "$API" | python3 -c 'import json,sys; a=json.load(sys.stdin)["assets"]; print(next(x["browser_download_url"] for x in a if x["name"]=="SHA256SUMS.txt"))')"
curl -fL "$ASSET_URL" -o "$WORK/$ASSET"
curl -fL "$SUM_URL" -o "$WORK/SHA256SUMS.txt"
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
