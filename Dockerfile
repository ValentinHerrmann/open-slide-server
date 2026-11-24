# syntax=docker/dockerfile:1
# Two images:
#   gateway: stock Caddy        -> services "gateway" and "claude-proxy"
#   app:     Node + Claude Code CLI + git + python -> "editor", "admin", "worker", "builder", "deps"
# All code of this repo is baked in (read-only at runtime); data lives in ./data.

FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52 AS gateway
# The official binary carries a file capability (bind :80). We listen on 8080 and run with
# no-new-privileges + no capabilities, where such a binary can't be executed: copy it to drop it.
RUN cp /usr/bin/caddy /usr/bin/caddy.new && mv /usr/bin/caddy.new /usr/bin/caddy
COPY gateway/ /etc/open-slide/gateway/
COPY proxy/ /etc/open-slide/proxy/
ENV XDG_DATA_HOME=/tmp XDG_CONFIG_HOME=/tmp
ENTRYPOINT ["/bin/sh", "/etc/open-slide/gateway/entrypoint.sh"]

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS app
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.330 && npm cache clean --force
COPY editor/ /opt/open-slide/editor/
COPY admin/ /opt/open-slide/admin/
COPY worker/ /opt/open-slide/worker/
COPY runner/ /opt/open-slide/runner/
COPY templates/ /opt/open-slide/templates/
USER node
WORKDIR /workspace
