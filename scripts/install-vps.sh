#!/usr/bin/env bash
# Installation (ou mise à jour) de Biocez sur un VPS Ubuntu/Debian, en root.
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/joachouri-stack/biocez/main/scripts/install-vps.sh | bash
# Variables facultatives : DOMAINE (défaut biocez.fr), ADMIN_TOKEN (sinon généré à la 1re installation).
# Relancer la même commande met le site à jour sans toucher à la base ni à la configuration.
set -euo pipefail

DOMAINE="${DOMAINE:-biocez.fr}"
DEPOT="https://github.com/joachouri-stack/biocez.git"
APP=/opt/biocez
DONNEES=/var/lib/biocez
CONF=/etc/biocez.env

etape() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root."; exit 1; }
command -v apt-get >/dev/null || { echo "Ce script est prévu pour Ubuntu ou Debian."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

etape "Paquets système"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

etape "Node.js 22"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

etape "Caddy (serveur web + HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
for s in apache2 nginx; do
  if systemctl is-active --quiet "$s"; then echo "Arrêt de $s (il occupe le port 80)"; systemctl disable --now "$s"; fi
done

etape "Code du site"
id biocez >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin biocez
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin main && git -C "$APP" reset -q --hard origin/main
else
  git clone -q --branch main "$DEPOT" "$APP"
fi
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
mkdir -p "$DONNEES"
chown -R biocez:biocez "$APP" "$DONNEES"

etape "Configuration"
if [ ! -f "$CONF" ]; then
  JETON="${ADMIN_TOKEN:-$(openssl rand -hex 20)}"
  cat > "$CONF" <<EOF
PUBLIC_URL=https://$DOMAINE
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_PATH=$DONNEES/biocez.db
ADMIN_TOKEN=$JETON
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
# BREVO_API_KEY=
# MAIL_FROM=Biocez <contact@$DOMAINE>
# GOOGLE_CLIENT_ID=
EOF
  chmod 600 "$CONF"
  echo "Configuration créée : $CONF"
else
  echo "Configuration existante conservée : $CONF"
fi

etape "Service Biocez"
cat > /etc/systemd/system/biocez.service <<EOF
[Unit]
Description=Biocez
After=network.target

[Service]
User=biocez
WorkingDirectory=$APP
EnvironmentFile=$CONF
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q biocez
systemctl restart biocez

cat > /etc/caddy/Caddyfile <<EOF
$DOMAINE {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}

www.$DOMAINE {
	redir https://$DOMAINE{uri} permanent
}
EOF
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

etape "Vérification"
for _ in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:3000/ && break; sleep 1; done
if curl -fs -o /dev/null http://127.0.0.1:3000/; then echo "Le site tourne sur le serveur."; else echo "Le site ne répond pas : journalctl -u biocez -n 50"; fi

IP=$(curl -4 -fs https://ifconfig.me || hostname -I | awk '{print $1}')
DNS=$(getent ahostsv4 "$DOMAINE" | awk 'NR==1{print $1}' || true)
echo
echo "Adresse IP de ce serveur : $IP"
if [ "$DNS" = "$IP" ]; then
  echo "$DOMAINE pointe bien vers ce serveur : https://$DOMAINE"
else
  echo "$DOMAINE pointe vers ${DNS:-rien} : dans Hostinger > Domaines > $DOMAINE > DNS,"
  echo "mettez les enregistrements A « @ » et « www » sur $IP, puis patientez quelques minutes."
fi
echo
echo "Jeton admin (page https://$DOMAINE/admin) : $(grep '^ADMIN_TOKEN=' "$CONF" | cut -d= -f2-)"
