#!/bin/bash
# Keeps a live device code on screen; starts the Claude engine once approved.
cd "$(dirname "$0")/.."
while true; do
  clear
  echo "ENTER THIS CODE IN RELAY  (Settings -> Link a device)"
  echo
  if npx -y @relaymessenger/cli pair; then
    exec npx -y @relaymessenger/cli start --engine claude
  fi
  echo "Code expired, minting a fresh one..."
  sleep 1
done
