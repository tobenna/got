'use strict';
const net = require('net');
const {TimeoutError} = require('./errors');

const reentry = Symbol('reentry');

function addTimeout(delay, callback, ...args) {
	// Event loop order is timers, poll, immediates.
	// The timed event may emit during the current tick poll phase, so
	// defer calling the handler until the poll phase completes.
	let immediate;
	const timeout = setTimeout(
		() => {
			immediate = setImmediate(callback, delay, ...args);
			if (immediate.unref) {
				// Added in node v9.7.0
				immediate.unref();
			}
		},
		delay
	);
	timeout.unref();
	return () => {
		clearTimeout(timeout);
		clearImmediate(immediate);
	};
}

module.exports = (request, options) => {
	if (request[reentry]) {
		return;
	}

	request[reentry] = true;
	const {gotTimeout: delays, host, hostname} = options;
	const timeoutHandler = (delay, event) => {
		request.abort();
		request.emit('error', new TimeoutError(delay, event, options));
	};

	const cancelers = [];
	const cancelTimeouts = () => {
		cancelers.forEach(cancelTimeout => cancelTimeout());
	};

	request.on('error', cancelTimeouts);
	request.once('response', response => {
		response.once('end', cancelTimeouts);
	});

	if (delays.request !== undefined) {
		const cancelTimeout = addTimeout(
			delays.request,
			timeoutHandler,
			'request'
		);
		cancelers.push(cancelTimeout);
	}

	if (delays.socket !== undefined) {
		request.setTimeout(
			delays.socket,
			() => {
				timeoutHandler(delays.socket, 'socket');
			}
		);
	}

	if (delays.lookup !== undefined && !request.socketPath && !net.isIP(hostname || host)) {
		request.once('socket', socket => {
			if (socket.connecting) {
				const cancelTimeout = addTimeout(
					delays.lookup,
					timeoutHandler,
					'lookup'
				);
				cancelers.push(cancelTimeout);
				socket.once('lookup', cancelTimeout);
			}
		});
	}

	if (delays.connect !== undefined) {
		request.once('socket', socket => {
			if (socket.connecting) {
				const timeConnect = () => {
					const cancelTimeout = addTimeout(
						delays.connect,
						timeoutHandler,
						'connect'
					);
					cancelers.push(cancelTimeout);
					return cancelTimeout;
				};

				if (request.socketPath || net.isIP(hostname || host)) {
					socket.once('connect', timeConnect());
				} else {
					socket.once('lookup', () => {
						socket.once('connect', timeConnect());
					});
				}
			}
		});
	}

	if (delays.send !== undefined) {
		request.once('socket', socket => {
			const timeRequest = () => {
				const cancelTimeout = addTimeout(
					delays.send,
					timeoutHandler,
					'send'
				);
				cancelers.push(cancelTimeout);
				return cancelTimeout;
			};

			if (socket.connecting) {
				socket.once('connect', () => {
					request.once('upload-complete', timeRequest());
				});
			} else {
				request.once('upload-complete', timeRequest());
			}
		});
	}

	if (delays.response !== undefined) {
		request.once('upload-complete', () => {
			const cancelTimeout = addTimeout(
				delays.response,
				timeoutHandler,
				'response'
			);
			cancelers.push(cancelTimeout);
			request.once('response', cancelTimeout);
		});
	}
};