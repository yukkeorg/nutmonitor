/* serviceState.js
 *
 * Reads the state of the NUT systemd units of this machine over the system bus.
 *
 * Only reading is done here. systemd answers those queries without any
 * authorisation, while starting or stopping a unit would need polkit and is
 * deliberately out of scope.
 *
 * The unit names come from upstream NUT and are the same on Debian/Ubuntu,
 * Fedora/RHEL, Arch and openSUSE. Debian and Ubuntu add nut-client.service as
 * an alias of nut-monitor.service, and some older packages named the monitor
 * after the daemon it runs, so those are tried as well.
 *
 * Unit reference:
 * https://github.com/networkupstools/nut/tree/master/scripts/systemd
 * D-Bus reference:
 * https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gettext from 'gettext';

const Domain = Gettext.domain('nutmonitor@yukke.org');
const _ = Domain.gettext;

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const SYSTEMD_BUS_NAME = 'org.freedesktop.systemd1';
const SYSTEMD_OBJECT_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER = 'org.freedesktop.systemd1.Manager';

/** ListUnitsByNames answers with one struct per name that was asked for. */
const UNIT_LIST_TYPE = '(a(ssssssouso))';

/** How long to wait for systemd, in milliseconds. */
const CALL_TIMEOUT = 3000;

/**
 * Candidates for the unit that runs upsmon, most likely first.
 *
 * upsmon runs on the machine that watches a UPS, which is this one even when
 * upsd itself lives elsewhere, so the local units are worth showing whatever
 * host the extension is pointed at.
 */
export const MONITOR_UNITS = [
    'nut-monitor.service',
    'nut-client.service',
    'upsmon.service',
];

/**
 * Ask systemd about a list of units.
 *
 * Names that no unit file matches come back with a load state of `not-found`
 * rather than an error, and aliases come back under the name they resolve to.
 *
 * @param {string[]} names the unit names to look up
 * @param {Gio.Cancellable} [cancellable] cancels the call
 * @returns {Promise<Array<object>>} one entry per name that was asked for
 */
async function listUnits(names, cancellable = null) {
    const reply = await Gio.DBus.system.call(
        SYSTEMD_BUS_NAME, SYSTEMD_OBJECT_PATH, SYSTEMD_MANAGER,
        'ListUnitsByNames',
        new GLib.Variant('(as)', [names]),
        new GLib.VariantType(UNIT_LIST_TYPE),
        Gio.DBusCallFlags.NONE, CALL_TIMEOUT, cancellable);

    const [units] = reply.deepUnpack();

    return units.map(unit => ({
        name: unit[0],
        description: unit[1],
        loadState: unit[2],
        activeState: unit[3],
        subState: unit[4],
    }));
}

/**
 * Read the state of the NUT monitoring service of this machine.
 *
 * @param {Gio.Cancellable} [cancellable] cancels the call
 * @returns {Promise<?object>} the state of the first unit that exists, an
 *   `installed: false` placeholder when none of them do, or null when systemd
 *   cannot be asked at all
 */
export async function fetchMonitorState(cancellable = null) {
    let units;

    try {
        units = await listUnits(MONITOR_UNITS, cancellable);
    } catch (error) {
        if (error instanceof GLib.Error &&
            error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            throw error;
        }

        // No systemd, no system bus, or a sandbox between the two. Nothing
        // useful can be said, which the caller tells apart from "not installed".
        return null;
    }

    const found = units.find(unit => unit.loadState !== 'not-found');
    if (found === undefined) {
        return {
            name: MONITOR_UNITS[0],
            description: '',
            loadState: 'not-found',
            activeState: 'inactive',
            subState: 'dead',
            installed: false,
        };
    }

    return {...found, installed: true};
}

/**
 * Tell whether a unit is running, or at least on its way there.
 *
 * @param {object} state the value returned by fetchMonitorState()
 * @returns {boolean} true while nothing is wrong with the unit
 */
export function isHealthy(state) {
    return state.installed && state.loadState !== 'masked' &&
        ['active', 'activating', 'reloading'].includes(state.activeState);
}

/**
 * Turn a unit state into text for the menu.
 *
 * @param {object} state the value returned by fetchMonitorState()
 * @returns {string} a translated, human readable state
 */
export function describeState(state) {
    if (!state.installed) {
        return _('Not installed');
    }
    if (state.loadState === 'masked') {
        return _('Masked');
    }

    switch (state.activeState) {
    case 'active':
        return _('Running');
    case 'activating':
        return _('Starting…');
    case 'deactivating':
        return _('Stopping…');
    case 'reloading':
        return _('Reloading…');
    case 'inactive':
        return _('Stopped');
    case 'failed':
        return _('Failed');
    default:
        return state.activeState;
    }
}
