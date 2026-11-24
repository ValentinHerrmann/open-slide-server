#!/bin/sh
# Validates PUBLIC_URL and starts the gateway.
set -eu
PUBLIC_URL="${PUBLIC_URL:-}"
echo "$PUBLIC_URL" | grep -Eq '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' || {
	echo "gateway: PUBLIC_URL must look like https://slides.example.com (lowercase, no path), got '$PUBLIC_URL'" >&2
	exit 1
}
PUBLIC_HOST=$(echo "$PUBLIC_URL" | sed -E 's#^https?://##; s#:[0-9]+$##')
PUBLIC_SCHEME=${PUBLIC_URL%%://*}
export PUBLIC_HOST PUBLIC_SCHEME
exec caddy run --config /etc/open-slide/gateway/Caddyfile --adapter caddyfile
