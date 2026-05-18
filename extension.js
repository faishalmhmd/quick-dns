import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

const DNS_PRESETS = [
    { id: 'cloudflare',  name: 'Cloudflare',         dns1: '1.1.1.1',          dns2: '1.0.0.1' },
    { id: 'google',      name: 'Google',             dns1: '8.8.8.8',          dns2: '8.8.4.4' },
    { id: 'quad9',       name: 'Quad9',              dns1: '9.9.9.9',          dns2: '149.112.112.112' },
    { id: 'adguard',     name: 'AdGuard',            dns1: '94.140.14.14',     dns2: '94.140.15.15' },
    { id: 'malwlink',    name: 'Malw.link',          dns1: '84.21.189.133',    dns2: '193.23.209.189' },
    { id: 'xbox',        name: 'Xbox DNS',           dns1: '111.88.96.50',     dns2: '111.88.96.51' },
    { id: 'comssone',    name: 'Comss.one',          dns1: '83.220.169.155',   dns2: '212.109.195.93' },
];

function pingHost(host) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['ping', '-c', '1', '-W', '2', host],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const match = stdout.match(/time=(\d+\.?\d*)\s*ms/);
                    resolve(match ? parseFloat(match[1]) : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

function getActiveConnection() {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['nmcli', '-t', '-f', 'NAME,DEVICE', 'con', 'show', '--active'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const lines = stdout.trim().split('\n');
                    for (const line of lines) {
                        const [name, device] = line.split(':');
                        if (name && device && !['lo', 'docker0'].some(x => name.startsWith(x))) {
                            resolve({ name, device });
                            return;
                        }
                    }
                    resolve(null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

function runCommands(commands) {
    return new Promise((resolve) => {
        function next(index) {
            if (index >= commands.length) {
                resolve(true);
                return;
            }
            try {
                const proc = Gio.Subprocess.new(
                    commands[index],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, , stderr] = proc.communicate_utf8_finish(res);
                        if (proc.get_successful()) {
                            next(index + 1);
                        } else {
                            console.warn(`[QuickDNS] Failed: ${commands[index].join(' ')}`, stderr?.trim());
                            resolve(false);
                        }
                    } catch (e) {
                        console.warn(`[QuickDNS] Exception: ${commands[index].join(' ')}`, String(e));
                        resolve(false);
                    }
                });
            } catch (e) {
                console.warn(`[QuickDNS] Subprocess error: ${commands[index].join(' ')}`, String(e));
                resolve(false);
            }
        }
        next(0);
    });
}

function nmcliSetDNS(connection, device, dns1, dns2) {
    return runCommands([
        ['nmcli', 'con', 'mod', connection, 'ipv4.dns', `${dns1} ${dns2}`],
        ['nmcli', 'con', 'mod', connection, 'ipv4.ignore-auto-dns', 'yes'],
        ['nmcli', 'device', 'reapply', device],
    ]);
}

function nmcliResetDNS(connection, device) {
    return runCommands([
        ['nmcli', 'con', 'mod', connection, 'ipv4.ignore-auto-dns', 'no'],
        ['nmcli', 'con', 'mod', connection, 'ipv4.dns', ''],
        ['nmcli', 'device', 'reapply', device],
    ]);
}

const QuickDnsToggle = GObject.registerClass({
    Signals: { 'preset-selected': { param_types: [GObject.TYPE_STRING] } },
}, class QuickDnsToggle extends QuickSettings.QuickMenuToggle {
    _init(iconPath) {
        super._init({
            title: _('Quick DNS'),
            toggleMode: true,
        });

        this._icons = {};
        this._menuItems = new Map();

        const icon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
        this.menu.setHeader(icon, _('Quick DNS'), _('Select DNS server'));

        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);

        for (const preset of DNS_PRESETS) {
            const item = new PopupMenu.PopupMenuItem(preset.name);
            item.connect('activate', () => {
                this.emit('preset-selected', preset.id);
            });
            this._menuItems.set(preset.id, item);
            this._itemsSection.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pingItem = new PopupMenu.PopupMenuItem('Проверить пинг');
        this._pingItem.connect('activate', () => {
            this._pingItem.setSensitive(false);
            this._pingItem.label.text = 'Пингую...';

            const promises = DNS_PRESETS.map(async (preset) => {
                const ping = await pingHost(preset.dns1);
                return { name: preset.name, ping };
            });

            Promise.all(promises).then((results) => {
                this._pingItem.setSensitive(true);
                this._pingItem.label.text = 'Проверить пинг';

                let msg = '';
                for (const r of results) {
                    const status = r.ping !== null ? `${r.ping}ms` : '✗';
                    msg += `${r.name}: ${status}\n`;
                }
                Main.notify('Quick DNS — Ping', msg.trim());
            });
        });
        this.menu.addMenuItem(this._pingItem);

        this._statusLabel = new PopupMenu.PopupMenuItem('');
        this._statusLabel.reactive = false;
        this.menu.addMenuItem(this._statusLabel);
    }

    setActivePreset(id) {
        for (const [presetId, item] of this._menuItems) {
            item.setOrnament(presetId === id
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    setStatus(text) {
        this._statusLabel.label.text = text;
    }
});

const QuickDnsIndicator = GObject.registerClass(
class QuickDnsIndicator extends QuickSettings.SystemIndicator {
    _init(iconPath) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
        this._indicator.reactive = true;
    }
});

export default class QuickDnsExtension extends Extension {
    enable() {
        const iconPath = `${this.path}/icons/quickdns-symbolic.svg`;

        this._indicator = new QuickDnsIndicator(iconPath);
        this._toggle = new QuickDnsToggle(iconPath);

        this._indicator.quickSettingsItems.push(this._toggle);
        QuickSettingsMenu.addExternalIndicator(this._indicator);

        this._state = { enabled: false, preset: 'cloudflare' };

        this._toggle.setActivePreset(this._state.preset);
        this._toggle.setStatus('Disabled');

        this._toggle.connect('preset-selected', (t, id) => {
            this._state.preset = id;
            this._toggle.setActivePreset(id);
            if (!this._state.enabled) {
                this._state.enabled = true;
                this._toggle.checked = true;
            }
            this._applyDNS();
        });

        this._toggle.connect('clicked', () => {
            this._state.enabled = this._toggle.checked;
            this._applyDNS();
        });
    }

    disable() {
        this._toggle.destroy();
        this._toggle = null;

        this._indicator.destroy();
        this._indicator = null;
    }

    async _applyDNS() {
        const conn = await getActiveConnection();
        if (!conn) {
            Main.notify('Quick DNS', 'No active network connection found');
            this._toggle.setStatus('No connection');
            return;
        }

        if (this._state.enabled) {
            const preset = DNS_PRESETS.find(p => p.id === this._state.preset);
            this._toggle.setStatus(`Applying ${preset.name}...`);
            const ok = await nmcliSetDNS(conn.name, conn.device, preset.dns1, preset.dns2);
            if (ok) {
                this._toggle.setStatus(`${preset.name}\n${preset.dns1}, ${preset.dns2}`);
            } else {
                this._toggle.setStatus('Permission denied');
                Main.notify('Quick DNS',
                    `Failed to set DNS. Try: sudo nmcli con mod "${conn.name}" ipv4.dns "${preset.dns1} ${preset.dns2}"`);
            }
        } else {
            this._toggle.setStatus('Resetting DNS...');
            const ok = await nmcliResetDNS(conn.name, conn.device);
            if (ok) {
                this._toggle.setStatus('Auto (DHCP)');
            } else {
                this._toggle.setStatus('Permission denied');
                Main.notify('Quick DNS',
                    `Failed to reset DNS. Try: sudo nmcli con mod "${conn.name}" ipv4.ignore-auto-dns no ipv4.dns ""`);
            }
        }
    }
}
