/* prefs.js
 *
 * Preferences window. Runs in its own process, so it may use GTK4/libadwaita
 * but must not touch anything from the shell.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Nut from './lib/nutClient.js';
import * as UpsState from './lib/upsState.js';

const PANEL_LABEL_MODES = ['charge', 'runtime', 'load', 'status', 'none'];
const PANEL_BOXES = ['left', 'center', 'right'];

export default class NutMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('UPS Monitor'),
            icon_name: 'uninterruptible-power-supply-symbolic',
        });

        page.add(this._buildConnectionGroup(settings, window));
        page.add(this._buildDisplayGroup(settings));
        page.add(this._buildNotificationGroup(settings));

        window.add(page);
        window.connect('close-request', () => {
            this._cancelTest();
            return false;
        });
    }

    _buildConnectionGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('Where upsd is running. Reading UPS data usually needs no credentials.'),
        });

        const host = new Adw.EntryRow({title: _('Host')});
        settings.bind('host', host, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(host);

        const port = new Adw.SpinRow({
            title: _('Port'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 65535,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        settings.bind('port', port, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(port);

        const upsName = new Adw.EntryRow({title: _('UPS name')});
        upsName.set_tooltip_text(_('Leave empty to use the first UPS the server reports'));
        settings.bind('ups-name', upsName, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(upsName);

        const username = new Adw.EntryRow({title: _('User name (optional)')});
        settings.bind('username', username, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(username);

        const password = new Adw.PasswordEntryRow({title: _('Password (optional)')});
        settings.bind('password', password, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(password);

        const interval = new Adw.SpinRow({
            title: _('Update interval'),
            subtitle: _('In seconds'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 300,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('poll-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const timeout = new Adw.SpinRow({
            title: _('Connection timeout'),
            subtitle: _('In seconds'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('connection-timeout', timeout, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(timeout);

        const testRow = new Adw.ActionRow({
            title: _('Test connection'),
            subtitle: _('Not tested yet'),
        });
        const testButton = new Gtk.Button({
            label: _('Test'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked',
            () => this._runTest(settings, testRow, testButton, window));
        testRow.add_suffix(testButton);
        testRow.activatable_widget = testButton;
        group.add(testRow);

        return group;
    }

    _buildDisplayGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Display')});

        const labels = new Gtk.StringList();
        labels.append(_('Battery charge'));
        labels.append(_('Runtime left'));
        labels.append(_('Load'));
        labels.append(_('Status'));
        labels.append(_('Nothing'));

        group.add(this._enumRow(settings, 'panel-label', PANEL_LABEL_MODES, labels, {
            title: _('Text next to the icon'),
        }));

        const boxes = new Gtk.StringList();
        boxes.append(_('Left'));
        boxes.append(_('Center'));
        boxes.append(_('Right'));

        group.add(this._enumRow(settings, 'panel-box', PANEL_BOXES, boxes, {
            title: _('Section of the top bar'),
        }));

        const position = new Adw.SpinRow({
            title: _('Order within the section'),
            subtitle: _('0 is leftmost. The load order of other extensions can still shift it.'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('panel-position', position, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(position);

        const detail = new Adw.SwitchRow({
            title: _('Show detailed rows'),
            subtitle: _('Voltages and nominal power in the menu'),
        });
        settings.bind('show-menu-detail', detail, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(detail);

        return group;
    }

    /**
     * A combo row for a string enum key, kept in sync in both directions.
     *
     * @param {Gio.Settings} settings the extension settings
     * @param {string} key the enum key to bind to
     * @param {string[]} nicks the enum nicks, in the order of the model
     * @param {Gtk.StringList} model the labels shown to the user
     * @param {object} params extra Adw.ComboRow properties, e.g. the title
     * @returns {Adw.ComboRow} the row, ready to be added to a group
     */
    _enumRow(settings, key, nicks, model, params) {
        const row = new Adw.ComboRow({
            ...params,
            model,
            selected: Math.max(0, nicks.indexOf(settings.get_string(key))),
        });

        row.connect('notify::selected', () => {
            settings.set_string(key, nicks[row.selected]);
        });
        settings.connect(`changed::${key}`, () => {
            const index = nicks.indexOf(settings.get_string(key));
            if (index >= 0 && index !== row.selected) {
                row.selected = index;
            }
        });

        return row;
    }

    _buildNotificationGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Notifications')});

        const rows = [
            ['notify-on-battery', _('Power failure'), _('The UPS switched to battery')],
            ['notify-low-battery', _('Low battery'), _('The UPS reports the low battery flag')],
            ['notify-on-line', _('Mains power restored'), _('The UPS is back on line power')],
            ['notify-replace-battery', _('Replace battery'), _('The UPS asks for a new battery')],
            ['notify-comm-lost', _('Communication lost'), _('The NUT server cannot be reached')],
        ];

        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }

        return group;
    }

    _cancelTest() {
        if (this._testCancellable) {
            this._testCancellable.cancel();
            this._testCancellable = null;
        }
    }

    _runTest(settings, row, button, window) {
        this._cancelTest();

        const cancellable = new Gio.Cancellable();
        this._testCancellable = cancellable;

        const config = {
            host: settings.get_string('host'),
            port: settings.get_int('port'),
            upsName: settings.get_string('ups-name'),
            username: settings.get_string('username'),
            password: settings.get_string('password'),
            timeout: settings.get_int('connection-timeout'),
        };

        button.sensitive = false;
        row.subtitle = _('Connecting…');

        Nut.fetchSnapshot(config, cancellable).then(snapshot => {
            if (cancellable.is_cancelled()) {
                return;
            }

            const count = Object.keys(snapshot.vars).length;
            const status = UpsState.statusSummary(
                UpsState.parseStatus(snapshot.vars['ups.status']));
            const message = UpsState.fmt(
                _('Connected to %s: %s, %d variables'), snapshot.upsName, status, count);

            row.subtitle = message;
            this._toast(window, message);
        }).catch(error => {
            if (cancellable.is_cancelled() || Nut.isCancelled(error)) {
                return;
            }

            const message = UpsState.fmt(_('Failed: %s'), Nut.describeError(error));
            row.subtitle = message;
            this._toast(window, message);
        }).finally(() => {
            if (this._testCancellable === cancellable) {
                this._testCancellable = null;
            }
            button.sensitive = true;
        });
    }

    _toast(window, message) {
        if (typeof window.add_toast === 'function') {
            window.add_toast(new Adw.Toast({title: message, timeout: 3}));
        }
    }
}
