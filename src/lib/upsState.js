/* upsState.js
 *
 * Interpretation and formatting of the variables upsd reports.
 * Like nutClient.js this module stays free of GNOME Shell imports so it can be
 * used from the shell, from the preferences process and from tests.
 *
 * Status flags:
 * https://networkupstools.org/docs/user-manual.chunked/Configuration_notes.html
 */

import Gettext from 'gettext';

const Domain = Gettext.domain('nutmonitor@yukke.org');
const _ = Domain.gettext;

/**
 * Replace `%d` and `%s` placeholders in order. GJS does not provide a printf
 * outside of GNOME Shell, and this is all the formatting we need.
 *
 * @param {string} template a translated string with %d or %s placeholders
 * @param {...any} values the values to substitute, in order
 * @returns {string} the formatted string
 */
export function fmt(template, ...values) {
    let index = 0;
    return template.replace(/%%|%[ds]/g, match => {
        if (match === '%%') {
            return '%';
        }
        return String(values[index++]);
    });
}

/** Flags that decide the headline state, most severe first. */
const PRIMARY_ORDER = ['OFF', 'FSD', 'ALARM', 'OB', 'BYPASS', 'CAL', 'OL'];

/**
 * Human readable name of a status flag.
 *
 * @param {string} flag a NUT status flag such as `OL`
 * @returns {string} the translated label, or the flag itself when unknown
 */
export function flagLabel(flag) {
    switch (flag) {
    case 'OL':
        return _('Online');
    case 'OB':
        return _('On battery');
    case 'LB':
        return _('Low battery');
    case 'HB':
        return _('High battery');
    case 'RB':
        return _('Replace battery');
    case 'CHRG':
        return _('Charging');
    case 'DISCHRG':
        return _('Discharging');
    case 'BYPASS':
        return _('Bypass');
    case 'CAL':
        return _('Calibrating');
    case 'OVER':
        return _('Overloaded');
    case 'TRIM':
        return _('Trimming voltage');
    case 'BOOST':
        return _('Boosting voltage');
    case 'OFF':
        return _('Output off');
    case 'FSD':
        return _('Forced shutdown');
    case 'ALARM':
        return _('Alarm');
    default:
        return flag;
    }
}

/**
 * Split the `ups.status` variable into flags.
 *
 * @param {string} status the raw value of ups.status
 * @returns {string[]} the flags, uppercased and without empty entries
 */
export function parseStatus(status) {
    if (!status) {
        return [];
    }
    return status.trim().toUpperCase().split(/\s+/).filter(flag => flag !== '');
}

/**
 * Summarise the flags into one line, e.g. "On battery, low battery".
 *
 * @param {string[]} flags the status flags
 * @returns {string} the translated summary
 */
export function statusSummary(flags) {
    if (flags.length === 0) {
        return _('Unknown');
    }

    const primary = PRIMARY_ORDER.find(flag => flags.includes(flag));
    const ordered = [];
    if (primary !== undefined) {
        ordered.push(primary);
    }
    for (const flag of flags) {
        if (flag !== primary) {
            ordered.push(flag);
        }
    }

    return ordered.map(flag => flagLabel(flag)).join(_(', '));
}

/**
 * Tell whether the UPS is in a state that deserves attention.
 *
 * @param {string[]} flags the status flags
 * @returns {boolean} true when the state is not plain "on line"
 */
export function isCritical(flags) {
    return ['OB', 'LB', 'FSD', 'OFF', 'ALARM', 'RB'].some(flag => flags.includes(flag));
}

/**
 * Pick the top bar icon.
 *
 * @param {string[]} flags the status flags
 * @param {number|null} charge battery charge in percent, or null when unknown
 * @returns {string} a symbolic icon name
 */
export function iconName(flags, charge) {
    if (flags.length === 0) {
        return 'battery-missing-symbolic';
    }
    if (flags.includes('OFF') || flags.includes('FSD')) {
        return 'battery-missing-symbolic';
    }
    if (flags.includes('LB')) {
        return 'battery-caution-symbolic';
    }
    if (charge === null) {
        return 'uninterruptible-power-supply-symbolic';
    }

    const level = Math.max(0, Math.min(100, Math.round(charge / 10) * 10));
    const onLine = flags.includes('OL') && !flags.includes('OB');

    if (!onLine) {
        return `battery-level-${level}-symbolic`;
    }
    if (level >= 100) {
        return 'battery-level-100-charged-symbolic';
    }
    if (flags.includes('CHRG')) {
        return `battery-level-${level}-charging-symbolic`;
    }
    return `battery-level-${level}-plugged-in-symbolic`;
}

/** The icon shown when the server cannot be reached. */
export const OFFLINE_ICON = 'battery-missing-symbolic';

/**
 * Read a variable as a number.
 *
 * @param {object} vars the variables of a snapshot
 * @param {string} name the variable name, e.g. `battery.charge`
 * @returns {number|null} the value, or null when absent or not a number
 */
export function num(vars, name) {
    const raw = vars?.[name];
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
}

/**
 * Format a percentage.
 *
 * @param {number|null} value the value in percent
 * @returns {string|null} the formatted value, or null when there is nothing
 */
export function formatPercent(value) {
    if (value === null) {
        return null;
    }
    return fmt(_('%d%%'), Math.round(value));
}

/**
 * Format a voltage.
 *
 * @param {number|null} value the value in volts
 * @returns {string|null} the formatted value, or null when there is nothing
 */
export function formatVolt(value) {
    if (value === null) {
        return null;
    }
    return fmt(_('%s V'), value.toFixed(1));
}

/**
 * Format a power rating.
 *
 * @param {number|null} value the value in watts
 * @returns {string|null} the formatted value, or null when there is nothing
 */
export function formatWatt(value) {
    if (value === null) {
        return null;
    }
    return fmt(_('%d W'), Math.round(value));
}

/**
 * Format a remaining runtime.
 *
 * @param {number|null} seconds the runtime in seconds
 * @returns {string|null} the formatted value, or null when there is nothing
 */
export function formatRuntime(seconds) {
    if (seconds === null) {
        return null;
    }

    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    if (hours > 0) {
        return fmt(_('%d h %d min'), hours, minutes);
    }
    if (minutes > 0) {
        return fmt(_('%d min'), minutes);
    }
    return fmt(_('%d s'), total);
}

/**
 * Name of the device, assembled from the manufacturer and model variables.
 *
 * @param {object} vars the variables of a snapshot
 * @returns {string} the device name, empty when nothing is known
 */
export function deviceName(vars) {
    const mfr = vars['ups.mfr'] ?? vars['device.mfr'] ?? '';
    const model = vars['ups.model'] ?? vars['device.model'] ?? '';
    return [mfr, model].filter(part => part.trim() !== '').join(' ').trim();
}

/**
 * The text shown next to the icon in the top bar.
 *
 * @param {string} mode one of charge, runtime, load, status, none
 * @param {object} snapshot the snapshot returned by fetchSnapshot()
 * @returns {string} the label text, empty when nothing should be shown
 */
export function panelText(mode, snapshot) {
    const vars = snapshot.vars;

    switch (mode) {
    case 'charge':
        return formatPercent(num(vars, 'battery.charge')) ?? '';
    case 'runtime':
        return formatRuntime(num(vars, 'battery.runtime')) ?? '';
    case 'load':
        return formatPercent(num(vars, 'ups.load')) ?? '';
    case 'status':
        return statusSummary(parseStatus(vars['ups.status']));
    default:
        return '';
    }
}
