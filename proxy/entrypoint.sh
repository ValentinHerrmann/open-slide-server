#!/bin/sh
# Starts the Claude proxy and publishes its CA certificate (not the key) for the editor to trust.
set -eu
caddy run --config /etc/open-slide/proxy/Caddyfile --adapter caddyfile &
pid=$!
trap 'kill -TERM $pid 2>/dev/null' TERM INT
root=/pki/caddy/pki/authorities/local/root.crt
i=0
while [ ! -s "$root" ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -s "$root" ] || { echo "claude-proxy: no CA certificate was created" >&2; kill $pid; exit 1; }
cp "$root" /ca-out/.claude-ca.crt && mv /ca-out/.claude-ca.crt /ca-out/claude-ca.crt
echo "claude-proxy: CA certificate published"
wait $pid
