/* nutClient.js
 *
 * A small asynchronous client for the NUT (Network UPS Tools) network protocol.
 *
 * This module deliberately depends on nothing but GLib/Gio, so that the very
 * same code can run inside the GNOME Shell process, inside the preferences
 * process and inside a plain `gjs` test script.
 *
 * Protocol reference:
 * https://networkupstools.org/docs/developer-guide.chunked/net-protocol.html
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gettext from 'gettext';

const Domain = Gettext.domain('nutmonitor@yukke.org');
const _ = Domain.gettext;

Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');

const DEFAULT_PORT = 3493;
const DEFAULT_TIMEOUT = 5;

/** Errors raised by this module. `code` is either a NUT `ERR` code or one of
 *  the local pseudo codes below. */
export class NutError extends Error {
    constructor(code, message = null) {
        super(message ?? code);
        this.name = 'NutError';
        this.code = code;
    }
}

/** Local pseudo codes, deliberately outside the NUT namespace. */
export const LOCAL_ERRORS = {
    TIMEOUT: 'X-TIMEOUT',
    CONNECTION_FAILED: 'X-CONNECTION-FAILED',
    PROTOCOL: 'X-PROTOCOL',
    NO_UPS: 'X-NO-UPS',
};

/**
 * Split one protocol line into tokens, honouring double quoted strings and
 * the `\"` / `\\` escapes upsd uses inside them.
 *
 * @param {string} line one line of protocol text, without the trailing newline
 * @returns {string[]} the tokens of the line
 */
export function tokenize(line) {
    const tokens = [];
    let i = 0;

    while (i < line.length) {
        while (i < line.length && line[i] === ' ') {
            i++;
        }
        if (i >= line.length) {
            break;
        }

        if (line[i] === '"') {
            i++;
            let value = '';
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\' && i + 1 < line.length) {
                    value += line[i + 1];
                    i += 2;
                } else {
                    value += line[i];
                    i++;
                }
            }
            // Skip the closing quote, if the server sent one.
            if (i < line.length) {
                i++;
            }
            tokens.push(value);
        } else {
            const start = i;
            while (i < line.length && line[i] !== ' ') {
                i++;
            }
            tokens.push(line.slice(start, i));
        }
    }

    return tokens;
}

/**
 * Turn a Gio failure into a NutError, so that callers only have to deal with
 * one kind of error. Cancellations are passed through untouched so that
 * isCancelled() keeps working.
 *
 * @param {Error} error anything an I/O operation threw
 * @returns {Error} the normalised error
 */
function normalizeError(error) {
    if (error instanceof NutError) {
        return error;
    }

    if (error instanceof GLib.Error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            return error;
        }
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
            return new NutError(LOCAL_ERRORS.TIMEOUT);
        }
        return new NutError(LOCAL_ERRORS.CONNECTION_FAILED, error.message);
    }

    return error;
}

/**
 * Reject a pending operation once `seconds` have passed, cancelling the I/O
 * that is still in flight.
 *
 * The operation runs under a cancellable of its own, which follows the
 * caller's one. A timeout cancels only that inner cancellable, so the caller's
 * one is never cancelled behind its back and a timeout always comes out as a
 * TIMEOUT error, whether the socket or this guard noticed it first.
 *
 * @param {function(Gio.Cancellable): Promise} start starts the operation with
 *   the cancellable it must use
 * @param {number} seconds timeout in seconds; values <= 0 disable the guard
 * @param {Gio.Cancellable} [cancellable] the caller's cancellable
 * @returns {Promise} the guarded operation
 */
export function withTimeout(start, seconds, cancellable = null) {
    if (!(seconds > 0)) {
        return start(cancellable).catch(error => {
            throw normalizeError(error);
        });
    }

    const inner = new Gio.Cancellable();
    // Runs the callback right away, and returns 0, when the caller has
    // already cancelled.
    const handlerId = cancellable?.connect(() => inner.cancel()) ?? 0;

    const guarded = start(inner).catch(error => {
        throw normalizeError(error);
    });

    let timeoutId = 0;

    const guard = new Promise((resolve, reject) => {
        timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            timeoutId = 0;
            inner.cancel();
            reject(new NutError(LOCAL_ERRORS.TIMEOUT));
            return GLib.SOURCE_REMOVE;
        });
    });

    return Promise.race([guarded, guard]).finally(() => {
        if (timeoutId !== 0) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        if (handlerId !== 0) {
            cancellable.disconnect(handlerId);
        }
    });
}

/**
 * One short lived connection to upsd.
 *
 * Only used through withConnection(), which puts a deadline on the whole
 * exchange and turns the Gio errors thrown here into NutErrors.
 */
class NutConnection {
    constructor(connection, cancellable) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._input = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
            close_base_stream: true,
        });
        this._output = connection.get_output_stream();
        this._decoder = new TextDecoder('utf-8');
        this._encoder = new TextEncoder();
    }

    /**
     * Open a connection to a NUT server.
     *
     * @param {object} config connection settings
     * @param {string} config.host host name or address of upsd
     * @param {number} [config.port] TCP port, 3493 by default
     * @param {number} timeout how long the socket may stay idle during a
     *   single read or write, in seconds
     * @param {Gio.Cancellable} cancellable cancels every operation on the
     *   connection
     * @returns {Promise<NutConnection>} the open connection
     */
    static async open(config, timeout, cancellable) {
        const host = config.host?.trim() || 'localhost';
        const port = config.port > 0 ? config.port : DEFAULT_PORT;

        const client = new Gio.SocketClient({timeout});
        const address = Gio.NetworkAddress.new(host, port);
        const connection = await client.connect_async(address, cancellable);

        return new NutConnection(connection, cancellable);
    }

    async _writeLine(line) {
        const bytes = this._encoder.encode(`${line}\n`);
        await this._output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable);
    }

    async _readLine() {
        const result = await this._input.read_line_async(
            GLib.PRIORITY_DEFAULT, this._cancellable);

        // read_line_finish() returns [line, length]; the promisified call keeps
        // that array intact because the first element is not `true`.
        const raw = Array.isArray(result) ? result[0] : result;
        if (raw === null) {
            throw new NutError(LOCAL_ERRORS.PROTOCOL,
                _('The server closed the connection unexpectedly'));
        }

        return this._decoder.decode(raw).replace(/\r$/, '');
    }

    /**
     * Send a command and read exactly one response line.
     *
     * @param {string} command the command to send, without the newline
     * @returns {Promise<string[]>} the tokens of the response line
     */
    async command(command) {
        await this._writeLine(command);
        const tokens = tokenize(await this._readLine());
        throwIfError(tokens);
        return tokens;
    }

    /**
     * Send a `LIST ...` command and collect the rows of the reply.
     *
     * @param {string} command the full LIST command, e.g. `LIST VAR myups`
     * @param {string} rowType the token that starts a data row, e.g. `VAR`
     * @returns {Promise<string[][]>} the tokens of every data row
     */
    async list(command, rowType) {
        await this._writeLine(command);

        const first = tokenize(await this._readLine());
        throwIfError(first);
        if (first[0] !== 'BEGIN') {
            throw new NutError(LOCAL_ERRORS.PROTOCOL,
                _('Unexpected reply from the server'));
        }

        const rows = [];
        for (;;) {
            const tokens = tokenize(await this._readLine());
            throwIfError(tokens);

            if (tokens[0] === 'END') {
                break;
            }
            if (tokens[0] === rowType) {
                rows.push(tokens);
            }
        }

        return rows;
    }

    /**
     * Authenticate, which NUT only needs for privileged operations.
     *
     * @param {string} username user name from upsd.users
     * @param {string} password matching password
     */
    async authenticate(username, password) {
        await this.command(`USERNAME ${username}`);
        await this.command(`PASSWORD ${password}`);
    }

    /**
     * List the UPS units the server knows about.
     *
     * @returns {Promise<Array<{name: string, description: string}>>} the units
     */
    async listUps() {
        const rows = await this.list('LIST UPS', 'UPS');
        return rows.map(tokens => ({
            name: tokens[1] ?? '',
            description: tokens[2] ?? '',
        }));
    }

    /**
     * Read every variable of one UPS.
     *
     * @param {string} upsName the UPS to query
     * @returns {Promise<object>} variable name to value
     */
    async listVars(upsName) {
        const rows = await this.list(`LIST VAR ${upsName}`, 'VAR');
        const vars = {};
        for (const tokens of rows) {
            if (tokens.length >= 4) {
                vars[tokens[2]] = tokens[3];
            }
        }
        return vars;
    }

    /** Say goodbye and drop the connection. Never throws, never blocks. */
    async close() {
        try {
            await this._writeLine('LOGOUT');
        } catch {
            // The connection is going away anyway.
        }

        try {
            this._connection.close(null);
        } catch {
            // Ignored on purpose.
        }
    }
}

/**
 * Turn an `ERR` reply into an exception.
 *
 * @param {string[]} tokens tokens of a response line
 */
function throwIfError(tokens) {
    if (tokens[0] === 'ERR') {
        throw new NutError(tokens[1] ?? 'UNKNOWN', tokens.slice(1).join(' '));
    }
}

/**
 * Connect, authenticate when credentials are set, run `body` and disconnect.
 *
 * Two timeouts guard the exchange, as in most network clients: the socket
 * gives up on a read or write once it has been idle for `config.timeout`
 * seconds, and the exchange as a whole, name resolution included, must be
 * over within the same time.
 *
 * @param {object} config connection settings: host, port, username, password
 *   and timeout
 * @param {Gio.Cancellable} cancellable the caller's cancellable
 * @param {function(NutConnection): Promise} body the requests to make
 * @returns {Promise} whatever `body` returns
 */
function withConnection(config, cancellable, body) {
    const timeout = config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT;

    return withTimeout(async c => {
        const connection = await NutConnection.open(config, timeout, c);

        try {
            if (config.username && config.password) {
                await connection.authenticate(config.username, config.password);
            }
            return await body(connection);
        } finally {
            await connection.close();
        }
    }, timeout, cancellable);
}

/**
 * Read the current state of one UPS.
 *
 * @param {object} config connection settings: host, port, upsName, username,
 *   password and timeout
 * @param {Gio.Cancellable} [cancellable] cancels the whole exchange
 * @returns {Promise<{upsName: string, vars: object}>} the UPS snapshot
 */
export function fetchSnapshot(config, cancellable = null) {
    return withConnection(config, cancellable, async connection => {
        let upsName = config.upsName?.trim() ?? '';
        if (upsName === '') {
            const units = await connection.listUps();
            if (units.length === 0) {
                throw new NutError(LOCAL_ERRORS.NO_UPS);
            }
            upsName = units[0].name;
        }

        const vars = await connection.listVars(upsName);
        return {upsName, vars};
    });
}

/**
 * List the UPS units of a server, used by the connection test in preferences.
 *
 * @param {object} config connection settings, see fetchSnapshot()
 * @param {Gio.Cancellable} [cancellable] cancels the whole exchange
 * @returns {Promise<Array<{name: string, description: string}>>} the units
 */
export function listUps(config, cancellable = null) {
    return withConnection(config, cancellable, connection => connection.listUps());
}

/**
 * Tell whether an error is just the fallout of a cancelled request.
 *
 * @param {Error} error anything thrown by this module
 * @returns {boolean} true when the request was cancelled on purpose
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Translate an error into a message that makes sense to a user.
 *
 * @param {Error} error anything thrown by this module
 * @returns {string} a translated, human readable message
 */
export function describeError(error) {
    if (isCancelled(error)) {
        return _('The request was cancelled');
    }

    if (error instanceof GLib.Error) {
        return error.message;
    }

    switch (error?.code) {
    case LOCAL_ERRORS.TIMEOUT:
        return _('The server did not answer in time');
    case LOCAL_ERRORS.CONNECTION_FAILED:
        return _('Cannot reach the NUT server');
    case LOCAL_ERRORS.NO_UPS:
        return _('The server has no UPS configured');
    case LOCAL_ERRORS.PROTOCOL:
        return error.message;
    case 'ACCESS-DENIED':
        return _('Access denied: check the user name, the password and upsd.users');
    case 'UNKNOWN-UPS':
        return _('The server does not know a UPS with that name');
    case 'USERNAME-REQUIRED':
    case 'PASSWORD-REQUIRED':
        return _('This server requires a user name and a password');
    case 'INVALID-ARGUMENT':
        return _('The server rejected the request as invalid');
    default:
        return error?.message ?? _('Unknown error');
    }
}
