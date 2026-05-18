# Quick DNS

Quickly switch DNS servers from GNOME quick settings panel.

## Features

- Switch between multiple DNS presets: Cloudflare, Google, Quad9, AdGuard, and more
- Enable/disable custom DNS with a toggle
- Ping test for all DNS servers
- Shows current DNS status in the quick settings menu

## Requirements

- GNOME Shell 50
- NetworkManager

## Manual Installation

```bash
git clone https://github.com/nolune/quick-dns.git
cd quick-dns
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/quick-dns@nolune
```

Restart GNOME Shell (Alt+F2, type `r`) and enable the extension.

## License

GNU General Public License v2.0
