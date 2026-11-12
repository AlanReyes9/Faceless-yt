#!/usr/bin/env bash
# Instalador de Faceless Studio para Linux (Ubuntu, Debian, Fedora, Arch, Mint…).
# Todo se guarda en tu disco: sin límite de espacio ni de tiempo de render.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/AlanReyes9/Faceless-yt/main/deploy/install-linux.sh | bash
#   (o con opciones)  bash install-linux.sh --tunnel --data /media/disco/faceless
#
# Opciones:
#   --dir RUTA     carpeta de la app            (por defecto ~/faceless-studio)
#   --data RUTA    carpeta de datos y vídeos    (por defecto <dir>/data; usa un disco grande si quieres)
#   --port N       puerto web                   (por defecto 3000)
#   --tunnel       publica la app en internet con Cloudflare Tunnel (gratis) para usarla desde el móvil
#   --no-service   no crear el servicio de arranque automático
set -euo pipefail

APP_DIR="$HOME/faceless-studio"; DATA_DIR=""; PORT=3000; TUNNEL=0; SERVICE=1
REPO="https://github.com/AlanReyes9/Faceless-yt.git"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2;;
    --data) DATA_DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --tunnel) TUNNEL=1; shift;;
    --no-service) SERVICE=0; shift;;
    *) echo "Opción desconocida: $1"; exit 1;;
  esac
done
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BIN="$HOME/.local/bin"; mkdir -p "$BIN"; export PATH="$BIN:$PATH"
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ARCH=$(uname -m); case "$ARCH" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; *) A="";; esac

# ---------- 1. Herramientas básicas ----------
for t in git curl; do
  command -v "$t" >/dev/null || { echo "Falta '$t'. Instálalo (p. ej.: sudo apt install $t) y vuelve a ejecutar."; exit 1; }
done

# ---------- 2. Node.js 22 (con nvm, sin sudo) ----------
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  say "Instalando Node.js 22 (nvm)…"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
fi
NODE_BIN="$(command -v node)"
say "Node $("$NODE_BIN" -v) en $NODE_BIN"

# ---------- 3. Descargar o actualizar la app ----------
if [ -d "$APP_DIR/.git" ]; then
  say "Actualizando la app en $APP_DIR…"
  git -C "$APP_DIR" pull --ff-only
else
  say "Descargando la app en $APP_DIR…"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
say "Instalando dependencias (incluye ffmpeg)…"
npm ci --omit=dev --no-audit --no-fund
"$NODE_BIN" node_modules/ffmpeg-static/install.js >/dev/null 2>&1 || true
"$NODE_BIN" -e "require('fs').accessSync(require('ffmpeg-static'))" || { echo "No se pudo instalar ffmpeg."; exit 1; }

# ---------- 4. yt-dlp (enlaces de YouTube, Twitch y Kick; se actualiza en cada instalación porque estas webs cambian a menudo) ----------
if ! command -v yt-dlp >/dev/null || [ -x "$BIN/yt-dlp" ]; then
  say "Instalando/actualizando yt-dlp…"
  if curl -fsSL -o "$BIN/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$([ "$A" = arm64 ] && echo _aarch64)"; then
    chmod +x "$BIN/yt-dlp"
  else echo "  (no se pudo instalar yt-dlp; la app funciona igual subiendo archivos)"; fi
fi

# ---------- 5. Configuración (.env) ----------
mkdir -p "$DATA_DIR"
if [ ! -f .env ]; then
  say "Creando la configuración…"
  PASS=""
  if { printf 'Elige la contraseña para entrar al estudio (Enter = generar una): ' > /dev/tty; } 2>/dev/null; then
    IFS= read -rs PASS < /dev/tty 2>/dev/null || PASS=""
    echo > /dev/tty 2>/dev/null || true
  fi
  GENERATED=0
  [ -n "$PASS" ] || { PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16); GENERATED=1; }
  umask 077
  # Node lee el valor literalmente entre comillas: se usa un tipo de comilla que no esté en la contraseña
  case "$PASS" in *"'"*) case "$PASS" in *'"'*) Q='`';; *) Q='"';; esac;; *) Q="'";; esac
  case "$PASS" in *"$Q"*) echo "La contraseña no puede contener a la vez comillas simples, dobles e invertidas."; exit 1;; esac
  cat > .env <<EOF
# Faceless Studio — configuración local (no la compartas)
APP_PASSWORD=$Q$PASS$Q
APP_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
DATA_DIR=$DATA_DIR
PORT=$PORT
# Renders simultáneos (sube a 2 si tu PC tiene 8 núcleos o más)
JOB_CONCURRENCY=1
X264_PRESET=veryfast
EOF
  [ "$GENERATED" = 1 ] && echo "  Contraseña generada: $PASS   (guárdala; está en $APP_DIR/.env)"
else
  echo "  Ya existe $APP_DIR/.env: se conserva tu configuración."
fi

# ---------- 6. Arranque automático (systemd de usuario) ----------
START_CMD="$NODE_BIN --no-warnings --env-file=$APP_DIR/.env $APP_DIR/server/index.js"
if [ "$SERVICE" = 1 ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  say "Creando el servicio de arranque automático…"
  UNIT="$HOME/.config/systemd/user"; mkdir -p "$UNIT"
  cat > "$UNIT/faceless-studio.service" <<EOF
[Unit]
Description=Faceless Studio
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
Environment=PATH=$BIN:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
ExecStart=$START_CMD
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now faceless-studio.service
  # que siga funcionando aunque cierres sesión
  loginctl enable-linger "$USER" 2>/dev/null || echo "  (para que funcione sin iniciar sesión: sudo loginctl enable-linger $USER)"
  STARTED=service
else
  STARTED=manual
fi

# ---------- 7. Túnel de Cloudflare (opcional) ----------
TUNNEL_URL=""
if [ "$TUNNEL" = 1 ]; then
  if ! command -v cloudflared >/dev/null; then
    say "Instalando cloudflared…"
    curl -fsSL -o "$BIN/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${A:-amd64}"
    chmod +x "$BIN/cloudflared"
  fi
  if [ "$STARTED" = service ]; then
    cat > "$HOME/.config/systemd/user/faceless-tunnel.service" <<EOF
[Unit]
Description=Faceless Studio — túnel Cloudflare
After=faceless-studio.service

[Service]
ExecStart=$BIN/cloudflared tunnel --no-autoupdate --url http://localhost:$PORT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now faceless-tunnel.service
    for _ in $(seq 1 30); do
      TUNNEL_URL=$(journalctl --user -u faceless-tunnel --no-pager -n 200 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
      [ -n "$TUNNEL_URL" ] && break; sleep 1
    done
  fi
fi

# ---------- Listo ----------
say "¡Faceless Studio instalado!"
echo "  Carpeta de la app:   $APP_DIR"
echo "  Datos y vídeos:      $DATA_DIR   (espacio = el de tu disco)"
if [ "$STARTED" = service ]; then
  echo "  Abre:                http://localhost:$PORT"
  echo "  Se inicia sola al encender el PC. Comandos útiles:"
  echo "    systemctl --user restart faceless-studio    # reiniciar"
  echo "    journalctl --user -u faceless-studio -f     # ver el registro"
else
  echo "  Para arrancarla:     $START_CMD"
  echo "  y abre http://localhost:$PORT"
fi
if [ -n "$TUNNEL_URL" ]; then
  echo "  Desde el móvil:      $TUNNEL_URL"
  echo "  (esta dirección cambia si reinicias el túnel; ver: journalctl --user -u faceless-tunnel | grep trycloudflare)"
fi
echo "  Para actualizar en el futuro: vuelve a ejecutar este instalador."
