#!/bin/sh
# egress-proxy: the editor's only way to the internet (HTTP_PROXY/HTTPS_PROXY in the editor).
# EDITOR_INTERNET=on : web traffic (ports 80/443) to public addresses only. Private, local and
#                      link-local addresses (your host, your LAN, cloud metadata) are always refused.
# EDITOR_INTERNET=off: everything refused (web search still works: it runs on Anthropic's side).
set -eu
case "${EDITOR_INTERNET:-on}" in
on) RULE="http_access allow all" ;;
off) RULE="http_access deny all" ;;
*) echo "egress-proxy: EDITOR_INTERNET must be on or off" >&2; exit 1 ;;
esac
cat >/tmp/squid.conf <<CONF
http_port 3128
pid_filename /tmp/squid.pid
cache_log stdio:/dev/stderr
logformat brief %tl %>a %rm %ru %>Hs
access_log stdio:/dev/stdout brief
cache deny all
cache_mem 8 MB
coredump_dir /tmp
netdb_filename none
dns_v4_first on
forwarded_for delete
via off
acl private dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3 ::/128 ::1 fc00::/7 fe80::/10 ff00::/8
acl web_ports port 80 443
acl SSL_ports port 443
acl CONNECT method CONNECT
http_access deny private
http_access deny !web_ports
http_access deny CONNECT !SSL_ports
$RULE
CONF
exec squid -N -f /tmp/squid.conf
