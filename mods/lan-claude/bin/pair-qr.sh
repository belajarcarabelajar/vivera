#!/usr/bin/env bash
# Shows the pairing QR (https://<LAN-IP>:8443/pair?t=<token>) on the PC screen so the token never
# lands in a chat transcript. Scan it with the phone on the same Wi-Fi.
# --terminal prints the QR in this terminal instead of opening an image window.
set -euo pipefail
token_file="${LAN_CLAUDE_CONFIG_DIR:-$HOME/.config/lan-claude}/token"
[ -s "$token_file" ] || { echo "Token belum ada; jalankan service dulu (systemctl --user start lan-claude)." >&2; exit 1; }
ip=$(ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
[ -n "$ip" ] || { echo "IP LAN tidak ditemukan." >&2; exit 1; }
url="https://$ip:${LAN_CLAUDE_PORT:-8443}/pair?t=$(cat "$token_file")"
if [ "${1:-}" = "--terminal" ]; then
  qrencode -t ANSIUTF8 "$url"
  exit 0
fi
out="$(mktemp --suffix=.png)"
qrencode -s 10 -o "$out" "$url"
chmod 600 "$out"
echo "QR dibuka di layar: $out (hapus setelah dipindai)."
xdg-open "$out" >/dev/null 2>&1 &
