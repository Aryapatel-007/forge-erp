#!/bin/bash
# Starts Forge ERP from this folder on a Mac. The first run downloads Node.js and MongoDB into
# runtime/, checked against the checksums their makers publish. Close this window to stop Forge.
set -eu -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/app"
RUNTIME="$ROOT/runtime"
DATA="$ROOT/data"
URL="http://localhost:4100/"
mkdir -p "$RUNTIME" "$DATA"

case "$(uname -m)" in
  arm64)
    NODE_FILE=node-v22.23.4-darwin-arm64.tar.gz; NODE_SHA=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428; NODE_DIR=node-v22.23.4-darwin-arm64
    MONGO_FILE=mongodb-macos-arm64-7.0.14.tgz; MONGO_SHA=8805f8b33801cd07b90118c25e507b0de21c6ad426b375fbe49e896ffc575d0e; MONGO_DIR=mongodb-macos-aarch64-7.0.14 ;;
  x86_64)
    NODE_FILE=node-v22.23.4-darwin-x64.tar.gz; NODE_SHA=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819; NODE_DIR=node-v22.23.4-darwin-x64
    MONGO_FILE=mongodb-macos-x86_64-7.0.14.tgz; MONGO_SHA=9b0f70feacf7c41542ee7d0905e2f8090b09d5b8413f0c9079406c09afd7a2c0; MONGO_DIR=mongodb-macos-x86_64-7.0.14 ;;
  *) echo "This Mac's chip, $(uname -m), is not supported."; exit 1 ;;
esac

fetch() {
  local name=$1 file=$2 sha=$3 url=$4 member=$5 target=$6
  if [ -x "$target" ] && [ "$(cat "$target.sha256" 2> /dev/null)" = "$sha" ]; then return; fi
  echo "Downloading $name. This happens once."
  curl --fail --location --progress-bar --retry 3 --output "$RUNTIME/$file" "$url"
  if [ "$(shasum -a 256 "$RUNTIME/$file" | awk '{print $1}')" != "$sha" ]; then
    rm -f "$RUNTIME/$file"
    echo "$name did not match its published checksum, so it was not used."
    exit 1
  fi
  tar -xzf "$RUNTIME/$file" -C "$RUNTIME" "$member"
  mkdir -p "$(dirname "$target")"
  mv -f "$RUNTIME/$member" "$target"
  chmod 755 "$target"
  echo "$sha" > "$target.sha256"
  rm -rf "$RUNTIME/$file" "$RUNTIME/${member%%/*}"
}

fetch "Node.js" "$NODE_FILE" "$NODE_SHA" "https://nodejs.org/dist/v22.23.4/$NODE_FILE" "$NODE_DIR/bin/node" "$RUNTIME/node"
fetch "MongoDB" "$MONGO_FILE" "$MONGO_SHA" "https://fastdl.mongodb.org/osx/$MONGO_FILE" "$MONGO_DIR/bin/mongod" "$RUNTIME/mongod"

NODE="$RUNTIME/node"
SETUP="$APP/server/scripts/windowsSetup.js"
"$NODE" "$SETUP" prepare --data "$DATA" --host keep > /dev/null

# The database runs while this window is open.
if ! pgrep -f "mongod --config $DATA/mongod.cfg" > /dev/null; then
  "$RUNTIME/mongod" --config "$DATA/mongod.cfg" --fork --pidfilepath "$DATA/mongod.pid" > /dev/null
fi
stop_database() { [ -f "$DATA/mongod.pid" ] && kill "$(cat "$DATA/mongod.pid")" 2> /dev/null || true; }
trap stop_database EXIT
"$NODE" "$SETUP" replset --data "$DATA" > /dev/null

if [ ! -f "$DATA/sign-in.txt" ]; then
  PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-16)
  OUTPUT=$(ADMIN_EMAIL=admin@forge.local ADMIN_NAME=Administrator ADMIN_PASSWORD="$PASSWORD" ADMIN_IF_NONE=1 "$NODE" --env-file="$DATA/forge.env" "$APP/server/scripts/createAdmin.js")
  if echo "$OUTPUT" | grep -q "created"; then
    printf 'Forge ERP\nOpen: %s\nEmail: admin@forge.local\nPassword: %s\n' "$URL" "$PASSWORD" > "$DATA/sign-in.txt"
    chmod 600 "$DATA/sign-in.txt"
  fi
fi
[ -f "$DATA/sign-in.txt" ] && { echo; cat "$DATA/sign-in.txt"; echo; }

( "$NODE" "$SETUP" wait-ready --data "$DATA" > /dev/null && open "$URL" ) &
echo "Forge is starting at $URL. Keep this window open. Close it to stop Forge."
cd "$APP/server"
"$NODE" --env-file="$DATA/forge.env" server.js
