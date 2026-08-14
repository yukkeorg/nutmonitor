/* extension.js
 *
 * Top bar indicator that shows the state of a UPS managed by NUT.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Nut from './lib/nutClient.js';
import * as UpsState from './lib/upsState.js';
import {Notifier} from './lib/notifier.js';

/** Longest interval used while the server keeps failing, in seconds. */
const MAX_BACKOFF = 60;

const NutIndicator = GObject.registerClass(
class NutIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('UPS'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._snapshot = null;
        this._config = null;
        this._destroyed = false;

        // The shell tears actors down on shutdown without calling disable(),
        // so a poll that lands afterwards must not touch them.
        this.connect('destroy', () => {
            this._destroyed = true;
        });

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._icon = new St.Icon({
            icon_name: UpsState.OFFLINE_ICON,
            style_class: 'system-status-icon nutmonitor-icon',
        });
        this._panelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'nutmonitor-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();
    }

    _buildMenu() {
        this._headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const headerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._headerTitle = new St.Label({
            text: _('UPS'),
            style_class: 'nutmonitor-header-title',
        });
        this._headerSubtitle = new St.Label({
            text: '',
            style_class: 'nutmonitor-header-subtitle',
        });
        this._headerSubtitle.clutter_text.line_wrap = true;
        headerBox.add_child(this._headerTitle);
        headerBox.add_child(this._headerSubtitle);
        this._headerItem.add_child(headerBox);
        this.menu.addMenuItem(this._headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Rows are created once and only updated afterwards.
        this._rows = {
            status: this._addRow(_('Status')),
            charge: this._addRow(_('Battery charge')),
            runtime: this._addRow(_('Runtime left')),
            load: this._addRow(_('Load')),
            inputVoltage: this._addRow(_('Input voltage'), true),
            outputVoltage: this._addRow(_('Output voltage'), true),
            batteryVoltage: this._addRow(_('Battery voltage'), true),
            nominalPower: this._addRow(_('Nominal power'), true),
        };

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        this._refreshItem.connect('activate', () => this._extension.refresh());
        this.menu.addMenuItem(this._refreshItem);

        this._settingsItem = new PopupMenu.PopupMenuItem(_('Settings…'));
        this._settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(this._settingsItem);
    }

    _addRow(title, detail = false) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const label = new St.Label({text: title, x_expand: true});
        const value = new St.Label({
            text: '',
            style_class: 'nutmonitor-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(label);
        item.add_child(value);
        this.menu.addMenuItem(item);

        return {item, value, detail};
    }

    _setRow(row, text) {
        const showDetail = this._settings.get_boolean('show-menu-detail');
        const visible = text !== null && text !== '' && (!row.detail || showDetail);

        row.item.visible = visible;
        if (visible) {
            row.value.text = text;
        }
    }

    /**
     * Show a fresh snapshot.
     *
     * @param {object} snapshot the snapshot returned by fetchSnapshot()
     * @param {object} config the connection settings it was read with
     */
    update(snapshot, config) {
        if (this._destroyed) {
            return;
        }

        this._snapshot = snapshot;
        this._config = config;
        this._render();
    }

    /** Re-render the last snapshot, e.g. after a display setting changed. */
    rerender() {
        if (!this._destroyed && this._snapshot !== null) {
            this._render();
        }
    }

    _render() {
        const vars = this._snapshot.vars;
        const flags = UpsState.parseStatus(vars['ups.status']);
        const charge = UpsState.num(vars, 'battery.charge');

        this._icon.icon_name = UpsState.iconName(flags, charge);
        this._icon.remove_style_class_name('nutmonitor-alert');
        if (UpsState.isCritical(flags)) {
            this._icon.add_style_class_name('nutmonitor-alert');
        }

        const labelMode = this._settings.get_string('panel-label');
        const labelText = UpsState.panelText(labelMode, this._snapshot);
        this._panelLabel.text = labelText;
        this._panelLabel.visible = labelText !== '';

        this._headerTitle.text = `${this._snapshot.upsName}@${this._config.host}`;
        const device = UpsState.deviceName(vars);
        this._headerSubtitle.text = device;
        this._headerSubtitle.visible = device !== '';

        this._setRow(this._rows.status, UpsState.statusSummary(flags));
        this._setRow(this._rows.charge, UpsState.formatPercent(charge));
        this._setRow(this._rows.runtime,
            UpsState.formatRuntime(UpsState.num(vars, 'battery.runtime')));
        this._setRow(this._rows.load,
            UpsState.formatPercent(UpsState.num(vars, 'ups.load')));
        this._setRow(this._rows.inputVoltage,
            UpsState.formatVolt(UpsState.num(vars, 'input.voltage')));
        this._setRow(this._rows.outputVoltage,
            UpsState.formatVolt(UpsState.num(vars, 'output.voltage')));
        this._setRow(this._rows.batteryVoltage,
            UpsState.formatVolt(UpsState.num(vars, 'battery.voltage')));
        this._setRow(this._rows.nominalPower,
            UpsState.formatWatt(UpsState.num(vars, 'ups.realpower.nominal')));
    }

    /**
     * Show that the server could not be reached.
     *
     * @param {string} message a human readable description of the failure
     * @param {object} config the connection settings that were tried
     */
    setError(message, config) {
        if (this._destroyed) {
            return;
        }

        this._snapshot = null;
        this._config = config;

        this._icon.icon_name = UpsState.OFFLINE_ICON;
        this._icon.add_style_class_name('nutmonitor-alert');
        this._panelLabel.text = '';
        this._panelLabel.visible = false;

        this._headerTitle.text = _('UPS unreachable');
        this._headerSubtitle.text = message;
        this._headerSubtitle.visible = true;

        for (const row of Object.values(this._rows)) {
            row.item.visible = false;
        }
    }

    destroy() {
        this._extension = null;
        this._settings = null;
        this._snapshot = null;
        this._rows = null;
        super.destroy();
    }
});

export default class NutMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._notifier = new Notifier(this._settings);
        this._indicator = new NutIndicator(this);
        this._timerId = 0;
        this._cancellable = null;
        this._pending = false;
        this._refreshRequested = false;
        this._failureCount = 0;

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings.connectObject('changed',
            (settings, key) => this._onSettingChanged(key), this);

        this.refresh();
    }

    disable() {
        this._stopTimer();

        if (this._cancellable !== null) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        this._settings.disconnectObject(this);

        if (this._indicator !== null) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._notifier !== null) {
            this._notifier.destroy();
            this._notifier = null;
        }

        this._settings = null;
        this._pending = false;
        this._refreshRequested = false;
    }

    /** Cancel whatever is in flight and poll the server right away. */
    refresh() {
        if (this._settings === null) {
            return;
        }

        this._stopTimer();

        if (this._pending) {
            // Let the running poll finish its rollback, then start over.
            this._refreshRequested = true;
            this._cancellable?.cancel();
            return;
        }

        this._poll().catch(error => console.error(error));
    }

    _onSettingChanged(key) {
        const displayKeys = ['panel-label', 'show-menu-detail'];

        if (displayKeys.includes(key)) {
            this._indicator?.rerender();
            return;
        }
        if (key.startsWith('notify-')) {
            return;
        }

        // A connection setting changed, so start over with a clean slate.
        this._failureCount = 0;
        this.refresh();
    }

    _readConfig() {
        return {
            host: this._settings.get_string('host'),
            port: this._settings.get_int('port'),
            upsName: this._settings.get_string('ups-name'),
            username: this._settings.get_string('username'),
            password: this._settings.get_string('password'),
            timeout: this._settings.get_int('connection-timeout'),
        };
    }

    _nextInterval() {
        const base = this._settings.get_int('poll-interval');
        if (this._failureCount === 0) {
            return base;
        }
        return Math.min(base * Math.pow(2, this._failureCount - 1), MAX_BACKOFF);
    }

    _stopTimer() {
        if (this._timerId !== 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _scheduleNext() {
        if (this._settings === null) {
            return;
        }

        this._stopTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._nextInterval(), () => {
                this._timerId = 0;
                this._poll().catch(error => console.error(error));
                return GLib.SOURCE_REMOVE;
            });
    }

    async _poll() {
        if (this._pending || this._settings === null) {
            return;
        }

        this._pending = true;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const config = this._readConfig();

        try {
            const snapshot = await Nut.fetchSnapshot(config, cancellable);

            // The extension may have been disabled while we waited.
            if (this._settings === null || cancellable.is_cancelled()) {
                return;
            }

            this._failureCount = 0;
            this._indicator?.update(snapshot, config);
            this._notifier?.onSnapshot(snapshot);
        } catch (error) {
            if (this._settings === null || Nut.isCancelled(error) ||
                cancellable.is_cancelled()) {
                return;
            }

            const message = Nut.describeError(error);
            this._failureCount++;
            this._indicator?.setError(message, config);
            this._notifier?.onFailure(this._failureCount, message);
        } finally {
            this._pending = false;
            if (this._cancellable === cancellable) {
                this._cancellable = null;
            }

            if (this._refreshRequested) {
                this._refreshRequested = false;
                this._poll().catch(error => console.error(error));
            } else {
                this._scheduleNext();
            }
        }
    }
}
