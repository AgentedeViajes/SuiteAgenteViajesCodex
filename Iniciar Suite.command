#!/bin/zsh

# Abre la Suite desde un servidor local privado. Esto evita bloqueos CORS de
# las APIs que suelen aparecer cuando los HTML se abren directamente (file://).
cd "$(dirname "$0")" || exit 1

SUITE_PORT=4173
python3 -m http.server "$SUITE_PORT" --bind 127.0.0.1 --directory . >/tmp/suite-agente-viajes.log 2>&1 &
SUITE_SERVER_PID=$!

cleanup() {
  kill "$SUITE_SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

sleep 1
open "http://127.0.0.1:$SUITE_PORT/"
wait "$SUITE_SERVER_PID"
