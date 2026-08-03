#!/bin/bash
# Keeps a live pairing QR on screen; starts the Claude engine once claimed.
cd "$(dirname "$0")/.."
while true; do
  clear
  echo "SCAN THIS FROM RELAY  (New Message -> Scan QR Code)"
  echo
  if npx -y @relaymessenger/cli pair; then
    exec npx -y @relaymessenger/cli start --engine claude
  fi
  echo "Code expired, minting a fresh one..."
  sleep 1
done
