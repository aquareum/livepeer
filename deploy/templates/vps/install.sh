#!/bin/sh
# Installs an instance on a fresh Debian or Ubuntu VPS. Run as root from a checkout of this repository:
#   DOMAIN=video.example.com sh deploy/templates/vps/install.sh
# The instance starts with the presets' test sign-in, which answers only on this server: visitors at DOMAIN
# are told it needs an identity provider. Connect one (deploy/README.md, "Sign-in on a public address").
set -eu

: "${DOMAIN:?Set DOMAIN to the hostname that points at this server}"
PRESET="${PRESET:-full}"

command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
command -v node >/dev/null 2>&1 || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | sh
  apt-get install -y nodejs
}
command -v caddy >/dev/null 2>&1 || apt-get install -y caddy

./livepeer setup --preset "$PRESET"

sed "s/{\$DOMAIN}/$DOMAIN/" deploy/templates/vps/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy
./livepeer doctor
echo "Instance is live at https://$DOMAIN"
