#!/usr/bin/env node
/* mock-nutd.mjs
 *
 * A tiny stand-in for upsd, enough to exercise the extension without any real
 * UPS hardware.
 *
 *   node tools/mock-nutd.mjs [--port 13493] [--sequence "OL,OB,OB LB,OL"]
 *                            [--advance 3]
 *
 * The status walks through --sequence, moving on after --advance reads of
 * `LIST VAR` (0 disables it). SIGUSR1 advances immediately, which is handy for
 * checking notifications by hand:
 *
 *   kill -USR1 $(pgrep -f mock-nutd)
 *
 * Special UPS names:
 *   mockups    the normal device
 *   secretups  answers ERR ACCESS-DENIED unless USERNAME/PASSWORD came first
 *   slowups    never answers, for timeout tests
 *   dripups    answers LIST VAR one line every 300 ms, so that no single read
 *              times out but the whole reply takes several seconds
 */

import net from 'node:net';
import process from 'node:process';

function parseArgs(argv) {
    const options = {
        port: 13493,
        host: '127.0.0.1',
        sequence: ['OL'],
        advance: 0,
    };

    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        switch (argv[i]) {
        case '--port':
            options.port = Number.parseInt(value, 10);
            i++;
            break;
        case '--host':
            options.host = value;
            i++;
            break;
        case '--sequence':
            options.sequence = value.split(',').map(entry => entry.trim());
            i++;
            break;
        case '--advance':
            options.advance = Number.parseInt(value, 10);
            i++;
            break;
        default:
            break;
        }
    }

    return options;
}

const options = parseArgs(process.argv.slice(2));

const state = {
    index: 0,
    reads: 0,
};

function currentStatus() {
    return options.sequence[state.index % options.sequence.length];
}

function advance() {
    state.index = (state.index + 1) % options.sequence.length;
    console.log(`[mock-nutd] status -> ${currentStatus()}`);
}

process.on('SIGUSR1', advance);

function variables() {
    const status = currentStatus();
    const onBattery = status.includes('OB');
    const low = status.includes('LB');
    const charge = low ? 18 : (onBattery ? 74 : 100);
    const runtime = low ? 240 : (onBattery ? 1560 : 4980);

    return {
        'device.type': 'ups',
        'ups.status': status,
        // The backslash and the quote check the unescaping in the client.
        'ups.mfr': 'Mock "Power" Corp.',
        'ups.model': 'Mock\\UPS 1500',
        'ups.serial': 'MOCK-0001',
        'ups.load': onBattery ? '31' : '23',
        'ups.realpower.nominal': '900',
        'battery.charge': String(charge),
        'battery.charge.low': '20',
        'battery.runtime': String(runtime),
        'battery.voltage': onBattery ? '25.7' : '27.3',
        'input.voltage': onBattery ? '0.0' : '101.2',
        'output.voltage': '101.0',
        'driver.name': 'dummy-ups',
    };
}

function quote(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tokenize(line) {
    const tokens = [];
    let index = 0;

    while (index < line.length) {
        while (index < line.length && line[index] === ' ') {
            index++;
        }
        if (index >= line.length) {
            break;
        }

        if (line[index] === '"') {
            index++;
            let value = '';
            while (index < line.length && line[index] !== '"') {
                if (line[index] === '\\' && index + 1 < line.length) {
                    value += line[index + 1];
                    index += 2;
                } else {
                    value += line[index];
                    index++;
                }
            }
            index++;
            tokens.push(value);
        } else {
            const start = index;
            while (index < line.length && line[index] !== ' ') {
                index++;
            }
            tokens.push(line.slice(start, index));
        }
    }

    return tokens;
}

const server = net.createServer(socket => {
    const session = {authenticated: false};
    let buffer = '';

    const send = text => {
        if (!socket.destroyed) {
            socket.write(`${text}\n`);
        }
    };

    const handle = line => {
        const tokens = tokenize(line);
        const command = (tokens[0] ?? '').toUpperCase();

        switch (command) {
        case 'VER':
            send('Network UPS Tools mock-nutd 0.1');
            break;
        case 'NETVER':
            send('1.3');
            break;
        case 'USERNAME':
            session.username = tokens[1];
            send('OK');
            break;
        case 'PASSWORD':
            if (session.username) {
                session.authenticated = true;
                send('OK');
            } else {
                send('ERR USERNAME-REQUIRED');
            }
            break;
        case 'LOGOUT':
            send('OK Goodbye');
            socket.end();
            break;
        case 'LIST':
            handleList(tokens);
            break;
        case 'GET':
            handleGet(tokens);
            break;
        default:
            send('ERR UNKNOWN-COMMAND');
            break;
        }
    };

    const handleList = tokens => {
        const what = (tokens[1] ?? '').toUpperCase();

        if (what === 'UPS') {
            send('BEGIN LIST UPS');
            send(`UPS mockups ${quote('Mock UPS for tests')}`);
            send('END LIST UPS');
            return;
        }

        if (what !== 'VAR') {
            send('ERR INVALID-ARGUMENT');
            return;
        }

        const name = tokens[2];
        if (name === 'slowups') {
            // Never answers on purpose.
            return;
        }
        if (name === 'dripups') {
            const lines = [
                `BEGIN LIST VAR ${name}`,
                ...Object.entries(variables()).map(
                    ([key, value]) => `VAR ${name} ${key} ${quote(value)}`),
                `END LIST VAR ${name}`,
            ];
            const timer = setInterval(() => {
                const next = lines.shift();
                if (next === undefined) {
                    clearInterval(timer);
                    return;
                }
                send(next);
            }, 300);
            socket.on('close', () => clearInterval(timer));
            return;
        }
        if (name === 'secretups' && !session.authenticated) {
            send('ERR ACCESS-DENIED');
            return;
        }
        if (name !== 'mockups' && name !== 'secretups') {
            send('ERR UNKNOWN-UPS');
            return;
        }

        state.reads++;
        send(`BEGIN LIST VAR ${name}`);
        for (const [key, value] of Object.entries(variables())) {
            send(`VAR ${name} ${key} ${quote(value)}`);
        }
        send(`END LIST VAR ${name}`);

        if (options.advance > 0 && state.reads % options.advance === 0) {
            advance();
        }
    };

    const handleGet = tokens => {
        const what = (tokens[1] ?? '').toUpperCase();
        const name = tokens[2];
        const key = tokens[3];

        if (what !== 'VAR' || name !== 'mockups') {
            send('ERR INVALID-ARGUMENT');
            return;
        }

        const value = variables()[key];
        if (value === undefined) {
            send('ERR VAR-NOT-SUPPORTED');
            return;
        }
        send(`VAR ${name} ${key} ${quote(value)}`);
    };

    socket.setEncoding('utf8');
    socket.on('data', chunk => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== '') {
                handle(line);
            }
            newline = buffer.indexOf('\n');
        }
    });
    socket.on('error', () => {
        // Clients disappear all the time; nothing to do.
    });
});

server.listen(options.port, options.host, () => {
    console.log(`[mock-nutd] listening on ${options.host}:${options.port}, ` +
        `status ${currentStatus()}`);
});
