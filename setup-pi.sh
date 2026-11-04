#!/bin/bash
# Sets up a Raspberry Pi as a Basement Cable TV: the server starts on boot, and a full-screen
# browser opens on it when the desktop logs in. Run it as the desktop user (not with sudo):
#   bash setup-pi.sh
# Running it again pulls the latest code and redoes the setup, so it also works for updates.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/michaeljhopkins/basement-cable.git}
APP_DIR=${APP_DIR:-$HOME/basement-cable}
PORT=${PORT:-8420}
KIOSK=/usr/local/bin/basement-cable-kiosk

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the user that logs in to the desktop, without sudo. It asks for sudo when it needs it."
  exit 1
fi
USER_NAME=$(id -un)

echo "== Installing packages"
sudo apt-get update
# Newer Raspberry Pi OS calls the browser "chromium"; older releases call it "chromium-browser".
if apt-cache show chromium >/dev/null 2>&1; then BROWSER_PKG=chromium; else BROWSER_PKG=chromium-browser; fi
sudo apt-get install -y git nodejs ffmpeg curl "$BROWSER_PKG"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node $NODE_MAJOR is too old; Basement Cable needs Node 18 or newer."
  exit 1
fi

echo "== Getting the code"
# The repo is private, so git asks for your GitHub username and a personal access token (not your password).
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "== Starting the server on boot"
sudo tee /etc/systemd/system/basement-cable.service >/dev/null <<EOF
[Unit]
Description=Basement Cable TV server
Wants=network-online.target
After=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable basement-cable.service
sudo systemctl restart basement-cable.service

echo "== Opening the browser on login"
sudo tee "$KIOSK" >/dev/null <<EOF
#!/bin/sh
# Opens Basement Cable full screen. Started by the desktop when $USER_NAME logs in.
URL='http://localhost:$PORT/?autostart'

# Several autostart files may call this, so only the first copy carries on.
exec 9>"/tmp/basement-cable-kiosk.\$(id -u).lock"
flock -n 9 || exit 0

# The server can still be starting when the desktop comes up.
for _ in \$(seq 90); do
  curl -sf -o /dev/null "\$URL" && break
  sleep 1
done

BROWSER=\$(command -v chromium || command -v chromium-browser)
# Reopens the browser if it crashes or gets closed.
while true; do
  "\$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run \\
    --autoplay-policy=no-user-gesture-required --password-store=basic \\
    --disable-session-crashed-bubble --disable-features=Translate \\
    --check-for-update-interval=31536000 "\$URL"
  sleep 2
done
EOF
sudo chmod 755 "$KIOSK"

# Raspberry Pi OS has used three desktops over the years, so hook into whichever ones are installed.
# A user's own autostart file replaces the system one, so start from a copy to keep the taskbar and desktop.
add_line() { # file, line, system file to start from
  mkdir -p "$(dirname "$1")"
  if [ ! -f "$1" ] && [ -f "$3" ]; then cp "$3" "$1"; fi
  grep -qxF "$2" "$1" 2>/dev/null || echo "$2" >> "$1"
}
if command -v labwc >/dev/null; then
  add_line "$HOME/.config/labwc/autostart" "$KIOSK &" /etc/xdg/labwc/autostart
fi
if command -v wayfire >/dev/null; then
  INI="$HOME/.config/wayfire.ini"
  touch "$INI"
  if ! grep -q "basement_cable" "$INI"; then
    if grep -q '^\[autostart\]' "$INI"; then
      sed -i "/^\[autostart\]/a basement_cable = $KIOSK" "$INI"
    else
      printf '\n[autostart]\nbasement_cable = %s\n' "$KIOSK" >> "$INI"
    fi
  fi
fi
if [ -d /etc/xdg/lxsession/LXDE-pi ]; then
  add_line "$HOME/.config/lxsession/LXDE-pi/autostart" "@$KIOSK" /etc/xdg/lxsession/LXDE-pi/autostart
fi

echo "== Keeping the screen on"
if command -v raspi-config >/dev/null; then
  sudo raspi-config nonint do_blanking 1 || echo "Couldn't turn off screen blanking; you can do it in raspi-config."
fi

echo
echo "Done. The server is running at http://localhost:$PORT."
echo "Reboot to check that it all starts by itself: sudo reboot"
