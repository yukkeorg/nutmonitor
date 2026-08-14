#!/usr/bin/env -S gjs -m
/* test-nutclient.js
 *
 * Checks lib/nutClient.js and lib/upsState.js against tools/mock-nutd.mjs.
 * Run it through `make test`, which starts and stops the mock server.
 */

import GLib from 'gi://GLib';
import System from 'system';

import * as Nut from '../src/lib/nutClient.js';
import * as UpsState from '../src/lib/upsState.js';

const PORT = Number.parseInt(GLib.getenv('NUT_MOCK_PORT') ?? '13493', 10);
const DEAD_PORT = Number.parseInt(GLib.getenv('NUT_DEAD_PORT') ?? '13499', 10);

let failures = 0;
let checks = 0;

function check(condition, description) {
    checks++;
    if (condition) {
        print(`  ok   ${description}`);
    } else {
        failures++;
        print(`  FAIL ${description}`);
    }
}

function equals(actual, expected, description) {
    check(actual === expected, `${description} (got ${JSON.stringify(actual)})`);
}

function config(extra = {}) {
    return {
        host: '127.0.0.1',
        port: PORT,
        upsName: 'mockups',
        username: '',
        password: '',
        timeout: 5,
        ...extra,
    };
}

async function testTokenizer() {
    print('tokenize()');

    const tokens = Nut.tokenize('VAR mockups ups.model "Mock\\\\UPS \\"X\\" 1500"');
    equals(tokens.length, 4, 'four tokens');
    equals(tokens[2], 'ups.model', 'variable name');
    equals(tokens[3], 'Mock\\UPS "X" 1500', 'escapes are unwrapped');

    const empty = Nut.tokenize('VAR mockups ups.serial ""');
    equals(empty[3], '', 'empty quoted value');
}

async function testSnapshot() {
    print('fetchSnapshot() against the mock server');

    const snapshot = await Nut.fetchSnapshot(config());
    equals(snapshot.upsName, 'mockups', 'ups name');
    check(Object.keys(snapshot.vars).length > 10, 'variables were parsed');
    equals(snapshot.vars['ups.mfr'], 'Mock "Power" Corp.', 'quote inside a value');
    equals(snapshot.vars['ups.model'], 'Mock\\UPS 1500', 'backslash inside a value');
    check(snapshot.vars['ups.status'] !== undefined, 'ups.status is present');
}

async function testAutoSelect() {
    print('fetchSnapshot() with an empty UPS name');

    const snapshot = await Nut.fetchSnapshot(config({upsName: ''}));
    equals(snapshot.upsName, 'mockups', 'first UPS is picked automatically');
}

async function testListUps() {
    print('listUps()');

    const units = await Nut.listUps(config());
    equals(units.length, 1, 'one unit');
    equals(units[0].name, 'mockups', 'unit name');
    equals(units[0].description, 'Mock UPS for tests', 'unit description');
}

async function testUnknownUps() {
    print('unknown UPS name');

    try {
        await Nut.fetchSnapshot(config({upsName: 'nosuchups'}));
        check(false, 'should have thrown');
    } catch (error) {
        equals(error.code, 'UNKNOWN-UPS', 'error code');
        check(Nut.describeError(error).length > 0, 'error has a description');
    }
}

async function testAccessDenied() {
    print('protected UPS without credentials');

    try {
        await Nut.fetchSnapshot(config({upsName: 'secretups'}));
        check(false, 'should have thrown');
    } catch (error) {
        equals(error.code, 'ACCESS-DENIED', 'error code');
    }
}

async function testAuthenticated() {
    print('protected UPS with credentials');

    const snapshot = await Nut.fetchSnapshot(
        config({upsName: 'secretups', username: 'monuser', password: 'secret'}));
    equals(snapshot.upsName, 'secretups', 'authentication was accepted');
}

async function testTimeout() {
    print('server that never answers');

    const start = GLib.get_monotonic_time();
    try {
        await Nut.fetchSnapshot(config({upsName: 'slowups', timeout: 1}));
        check(false, 'should have thrown');
    } catch (error) {
        equals(error.code, Nut.LOCAL_ERRORS.TIMEOUT, 'error code');
        const elapsed = (GLib.get_monotonic_time() - start) / 1000000;
        check(elapsed < 3, `gave up quickly (${elapsed.toFixed(1)} s)`);
    }
}

async function testConnectionRefused() {
    print('nothing listening');

    try {
        await Nut.fetchSnapshot(config({port: DEAD_PORT}));
        check(false, 'should have thrown');
    } catch (error) {
        equals(error.code, Nut.LOCAL_ERRORS.CONNECTION_FAILED, 'error code');
    }
}

async function testFormatting() {
    print('upsState formatting');

    equals(UpsState.formatRuntime(4980), '1 h 23 min', 'hours and minutes');
    equals(UpsState.formatRuntime(240), '4 min', 'minutes only');
    equals(UpsState.formatRuntime(45), '45 s', 'seconds only');
    equals(UpsState.formatPercent(99.6), '100%', 'percent is rounded');
    equals(UpsState.formatVolt(101.23), '101.2 V', 'voltage');
    equals(UpsState.formatWatt(900), '900 W', 'power');

    equals(UpsState.parseStatus('OB LB').join('|'), 'OB|LB', 'status flags');
    equals(UpsState.statusSummary(['LB', 'OB']), 'On battery, Low battery',
        'the headline flag comes first');
    check(UpsState.isCritical(['OB']), 'on battery is critical');
    check(!UpsState.isCritical(['OL', 'CHRG']), 'on line is not critical');

    equals(UpsState.iconName(['OL'], 100), 'battery-level-100-charged-symbolic',
        'icon while fully charged on line power');
    equals(UpsState.iconName(['OL', 'CHRG'], 62), 'battery-level-60-charging-symbolic',
        'icon while charging');
    equals(UpsState.iconName(['OB'], 74), 'battery-level-70-symbolic',
        'icon on battery');
    equals(UpsState.iconName(['OB', 'LB'], 18), 'battery-caution-symbolic',
        'icon on low battery');
    equals(UpsState.iconName([], null), 'battery-missing-symbolic',
        'icon without data');

    equals(UpsState.deviceName({'ups.mfr': 'Mock', 'ups.model': 'UPS 1500'}),
        'Mock UPS 1500', 'device name');
    equals(UpsState.panelText('charge', {vars: {'battery.charge': '42'}}), '42%',
        'panel text');
}

async function main() {
    const tests = [
        testTokenizer,
        testSnapshot,
        testAutoSelect,
        testListUps,
        testUnknownUps,
        testAccessDenied,
        testAuthenticated,
        testTimeout,
        testConnectionRefused,
        testFormatting,
    ];

    for (const test of tests) {
        try {
            await test();
        } catch (error) {
            failures++;
            print(`  FAIL ${test.name} threw: ${error}`);
        }
    }

    print('');
    print(`${checks - failures}/${checks} checks passed`);
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;

main().catch(error => {
    printerr(`unexpected error: ${error}`);
    failures++;
}).finally(() => {
    exitCode = failures === 0 ? 0 : 1;
    loop.quit();
});

loop.run();
System.exit(exitCode);
