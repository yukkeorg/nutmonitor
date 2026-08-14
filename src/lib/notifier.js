/* notifier.js
 *
 * Turns state transitions into desktop notifications.
 * This is the only file under lib/ that talks to GNOME Shell.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as UpsState from './upsState.js';

/** How many failed polls in a row count as "communication lost". */
const COMM_LOST_THRESHOLD = 3;

export class Notifier {
    constructor(settings) {
        this._settings = settings;
        this._source = null;
        this._previousFlags = null;
        this._commLost = false;
    }

    /**
     * Report a successful poll and notify about anything that changed.
     *
     * @param {object} snapshot the snapshot returned by fetchSnapshot()
     */
    onSnapshot(snapshot) {
        const flags = UpsState.parseStatus(snapshot.vars['ups.status']);

        if (this._commLost) {
            this._commLost = false;
            if (this._settings.get_boolean('notify-comm-lost')) {
                this._notify(_('UPS reachable again'),
                    _('Communication with the NUT server has been restored.'),
                    MessageTray.Urgency.NORMAL);
            }
        }

        // The first poll after enabling only establishes the baseline, so that
        // enabling the extension during a power failure does not spam the user.
        if (this._previousFlags === null) {
            this._previousFlags = flags;
            return;
        }

        const previous = this._previousFlags;
        const rose = flag => flags.includes(flag) && !previous.includes(flag);

        if (rose('OB') && this._settings.get_boolean('notify-on-battery')) {
            this._notify(_('Power failure'),
                this._powerFailureBody(snapshot),
                MessageTray.Urgency.CRITICAL);
        }

        if (rose('LB') && this._settings.get_boolean('notify-low-battery')) {
            this._notify(_('UPS battery is low'),
                this._lowBatteryBody(snapshot),
                MessageTray.Urgency.CRITICAL);
        }

        if (previous.includes('OB') && !flags.includes('OB') &&
            this._settings.get_boolean('notify-on-line')) {
            this._notify(_('Mains power restored'),
                _('The UPS is running on line power again.'),
                MessageTray.Urgency.NORMAL);
        }

        if (rose('RB') && this._settings.get_boolean('notify-replace-battery')) {
            this._notify(_('UPS battery needs replacing'),
                _('The UPS reports that its battery has reached the end of its life.'),
                MessageTray.Urgency.HIGH);
        }

        this._previousFlags = flags;
    }

    /**
     * Report a failed poll.
     *
     * @param {number} failureCount how many polls failed in a row
     * @param {string} message a human readable description of the failure
     */
    onFailure(failureCount, message) {
        if (this._commLost || failureCount < COMM_LOST_THRESHOLD) {
            return;
        }

        this._commLost = true;
        // The UPS state is unknown from here on, so do not compare against it
        // once communication comes back.
        this._previousFlags = null;

        if (this._settings.get_boolean('notify-comm-lost')) {
            this._notify(_('UPS unreachable'), message, MessageTray.Urgency.NORMAL);
        }
    }

    _powerFailureBody(snapshot) {
        const runtime = UpsState.formatRuntime(UpsState.num(snapshot.vars, 'battery.runtime'));
        const charge = UpsState.formatPercent(UpsState.num(snapshot.vars, 'battery.charge'));

        if (runtime !== null && charge !== null) {
            return UpsState.fmt(
                _('The UPS switched to battery. Charge %s, about %s left.'), charge, runtime);
        }
        return _('The UPS switched to battery power.');
    }

    _lowBatteryBody(snapshot) {
        const runtime = UpsState.formatRuntime(UpsState.num(snapshot.vars, 'battery.runtime'));

        if (runtime !== null) {
            return UpsState.fmt(
                _('About %s of runtime left. Save your work and shut down.'), runtime);
        }
        return _('Save your work and shut down.');
    }

    _getSource() {
        if (this._source === null) {
            this._source = new MessageTray.Source({
                title: _('UPS'),
                iconName: 'uninterruptible-power-supply-symbolic',
            });
            // connectObject() cleans itself up when the source goes away, which
            // also happens when the user dismisses the last notification.
            this._source.connectObject('destroy', () => {
                this._source = null;
            }, this);
            Main.messageTray.add(this._source);
        }

        return this._source;
    }

    _notify(title, body, urgency) {
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            urgency,
            isTransient: urgency < MessageTray.Urgency.HIGH,
            privacyScope: MessageTray.PrivacyScope.SYSTEM,
            iconName: 'uninterruptible-power-supply-symbolic',
        });

        source.addNotification(notification);
    }

    /** Drop the notification source and forget the tracked state. */
    destroy() {
        if (this._source !== null) {
            const source = this._source;
            this._source = null;
            source.disconnectObject(this);
            source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        }

        this._settings = null;
        this._previousFlags = null;
    }
}
