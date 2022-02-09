// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {getOrCreateWebSocketClient, WebSocketClientInterface} from '@mattermost/react-native-network-client';

import {WebsocketEvents} from '@constants';
import DatabaseManager from '@database/manager';
import {queryCommonSystemValues} from '@queries/servers/system';

const MAX_WEBSOCKET_FAILS = 7;
const MIN_WEBSOCKET_RETRY_TIME = 3000; // 3 sec

const MAX_WEBSOCKET_RETRY_TIME = 300000; // 5 mins

export default class WebSocketClient {
    private conn?: WebSocketClientInterface;
    private connectionTimeout: any;
    private connectionId: string;
    private token: string;

    // responseSequence is the number to track a response sent
    // via the websocket. A response will always have the same sequence number
    // as the request.
    private responseSequence: number;

    // serverSequence is the incrementing sequence number from the
    // server-sent event stream.
    private serverSequence: number;
    private connectFailCount: number;
    private eventCallback?: Function;
    private firstConnectCallback?: () => void;
    private missedEventsCallback?: () => void;
    private reconnectCallback?: () => void;
    private errorCallback?: Function;
    private closeCallback?: (connectFailCount: number, lastDisconnect: number) => void;
    private connectingCallback?: () => void;
    private stop: boolean;
    private lastConnect: number;
    private lastDisconnect: number;

    private serverUrl: string;

    constructor(serverUrl: string, token: string, lastDisconnect = 0) {
        this.connectionId = '';
        this.token = token;
        this.responseSequence = 1;
        this.serverSequence = 0;
        this.connectFailCount = 0;
        this.stop = false;
        this.serverUrl = serverUrl;
        this.lastConnect = 0;
        this.lastDisconnect = lastDisconnect;
    }

    public async initialize(opts = {}) {
        const defaults = {
            forceConnection: true,
        };

        const {forceConnection} = Object.assign({}, defaults, opts);

        if (forceConnection) {
            this.stop = false;
        }

        if (this.conn) {
            return;
        }

        const database = DatabaseManager.serverDatabases[this.serverUrl]?.database;
        if (!database) {
            return;
        }

        const system = await queryCommonSystemValues(database);
        const connectionUrl = (system.config.WebsocketURL || this.serverUrl) + '/api/v4/websocket';

        if (this.connectingCallback) {
            this.connectingCallback();
        }

        const regex = /^(?:https?|wss?):(?:\/\/)?[^/]*/;
        const captured = (regex).exec(connectionUrl);

        let origin;
        if (captured) {
            origin = captured[0];
        } else {
            // If we're unable to set the origin header, the websocket won't connect, but the URL is likely malformed anyway
            const errorMessage = 'websocket failed to parse origin from ' + connectionUrl;
            console.warn(errorMessage); // eslint-disable-line no-console
            return;
        }

        let url = connectionUrl;

        const reliableWebSockets = system.config.EnableReliableWebSockets === 'true';
        if (reliableWebSockets) {
            // Add connection id, and last_sequence_number to the query param.
            // We cannot also send it as part of the auth_challenge, because the session cookie is already sent with the request.
            url = `${connectionUrl}?connection_id=${this.connectionId}&sequence_number=${this.serverSequence}`;
        }

        // Manually changing protocol since getOrCreateWebsocketClient does not accept http/s
        if (url.startsWith('https:')) {
            url = 'wss:' + url.substr('https:'.length);
        }

        if (url.startsWith('http:')) {
            url = 'ws:' + url.substr('http:'.length);
        }

        if (this.connectFailCount === 0) {
            console.log('websocket connecting to ' + url); //eslint-disable-line no-console
        }

        try {
            const {client} = await getOrCreateWebSocketClient(url, {headers: {origin}});
            this.conn = client;
        } catch (error) {
            return;
        }

        this.conn!.onOpen(() => {
            this.lastConnect = Date.now();

            // No need to reset sequence number here.
            if (!reliableWebSockets) {
                this.serverSequence = 0;
            }

            if (this.token) {
                // we check for the platform as a workaround until we fix on the server that further authentications
                // are ignored
                this.sendMessage('authentication_challenge', {token: this.token});
            }

            if (this.connectFailCount > 0) {
                console.log('websocket re-established connection to', url); //eslint-disable-line no-console
                if (!reliableWebSockets && this.reconnectCallback) {
                    this.reconnectCallback();
                } else if (reliableWebSockets && this.serverSequence && this.missedEventsCallback) {
                    this.missedEventsCallback();
                }
            } else if (this.firstConnectCallback) {
                console.log('websocket connected to', url); //eslint-disable-line no-console
                this.firstConnectCallback();
            }

            this.connectFailCount = 0;
        });

        this.conn!.onClose(() => {
            const now = Date.now();
            if (this.lastDisconnect < this.lastConnect) {
                this.lastDisconnect = now;
            }

            this.conn = undefined;
            this.responseSequence = 1;

            if (this.connectFailCount === 0) {
                console.log('websocket closed', url); //eslint-disable-line no-console
            }

            this.connectFailCount++;

            if (this.closeCallback) {
                this.closeCallback(this.connectFailCount, this.lastDisconnect);
            }

            if (this.stop) {
                return;
            }

            let retryTime = MIN_WEBSOCKET_RETRY_TIME;

            // If we've failed a bunch of connections then start backing off
            if (this.connectFailCount > MAX_WEBSOCKET_FAILS) {
                retryTime = MIN_WEBSOCKET_RETRY_TIME * this.connectFailCount;
                if (retryTime > MAX_WEBSOCKET_RETRY_TIME) {
                    retryTime = MAX_WEBSOCKET_RETRY_TIME;
                }
            }

            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
            }

            this.connectionTimeout = setTimeout(
                () => {
                    if (this.stop) {
                        clearTimeout(this.connectionTimeout);
                        return;
                    }
                    this.initialize(opts);
                },
                retryTime,
            );
        });

        this.conn!.onError((evt: any) => {
            if (this.connectFailCount <= 1) {
                console.log('websocket error', url); //eslint-disable-line no-console
                console.log(evt); //eslint-disable-line no-console
            }

            if (this.errorCallback) {
                this.errorCallback(evt);
            }
        });

        this.conn!.onMessage((evt: any) => {
            const msg = evt.message;

            // This indicates a reply to a websocket request.
            // We ignore sequence number validation of message responses
            // and only focus on the purely server side event stream.
            if (msg.seq_reply) {
                if (msg.error) {
                    console.warn(msg); //eslint-disable-line no-console
                }
            } else if (this.eventCallback) {
                if (reliableWebSockets) {
                    // We check the hello packet, which is always the first packet in a stream.
                    if (msg.event === WebsocketEvents.HELLO && this.reconnectCallback) {
                        //eslint-disable-next-line no-console
                        console.log(url, 'got connection id ', msg.data.connection_id);

                        // If we already have a connectionId present, and server sends a different one,
                        // that means it's either a long timeout, or server restart, or sequence number is not found.
                        // Then we do the sync calls, and reset sequence number to 0.
                        if (this.connectionId !== '' && this.connectionId !== msg.data.connection_id) {
                            //eslint-disable-next-line no-console
                            console.log(url, 'long timeout, or server restart, or sequence number is not found.');
                            this.reconnectCallback();
                            this.serverSequence = 0;
                        }

                        // If it's a fresh connection, we have to set the connectionId regardless.
                        // And if it's an existing connection, setting it again is harmless, and keeps the code simple.
                        this.connectionId = msg.data.connection_id;
                    }

                    // Now we check for sequence number, and if it does not match,
                    // we just disconnect and reconnect.
                    if (msg.seq !== this.serverSequence) {
                        // eslint-disable-next-line no-console
                        console.log(url, 'missed websocket event, act_seq=' + msg.seq + ' exp_seq=' + this.serverSequence);

                        // We are not calling this.close() because we need to auto-restart.
                        this.connectFailCount = 0;
                        this.responseSequence = 1;
                        this.conn?.close(); // Will auto-reconnect after MIN_WEBSOCKET_RETRY_TIME.
                        return;
                    }
                } else if (msg.seq !== this.serverSequence && this.reconnectCallback) {
                    // eslint-disable-next-line no-console
                    console.log(url, 'missed websocket event, act_seq=' + msg.seq + ' exp_seq=' + this.serverSequence);
                    this.reconnectCallback();
                }

                this.serverSequence = msg.seq + 1;
                this.eventCallback(msg);
            }
        });

        this.conn.open();
    }

    public setConnectingCallback(callback: () => void) {
        this.connectingCallback = callback;
    }

    public setEventCallback(callback: Function) {
        this.eventCallback = callback;
    }

    public setFirstConnectCallback(callback: () => void) {
        this.firstConnectCallback = callback;
    }

    public setMissedEventsCallback(callback: () => void) {
        this.missedEventsCallback = callback;
    }

    public setReconnectCallback(callback: () => void) {
        this.reconnectCallback = callback;
    }

    public setErrorCallback(callback: Function) {
        this.errorCallback = callback;
    }

    public setCloseCallback(callback: (connectFailCount: number, lastDisconnect: number) => void) {
        this.closeCallback = callback;
    }

    public close(stop = false) {
        this.stop = stop;
        this.connectFailCount = 0;
        this.responseSequence = 1;

        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.close();
        }
    }

    public invalidate() {
        this.conn?.invalidate();
        this.conn = undefined;
    }

    private sendMessage(action: string, data: any) {
        const msg = {
            action,
            seq: this.responseSequence++,
            data,
        };

        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.send(JSON.stringify(msg));
        } else if (!this.conn || this.conn.readyState === WebSocket.CLOSED) {
            this.conn = undefined;
            this.initialize(this.token);
        }
    }

    public sendUserTypingEvent(channelId: string, parentId?: string) {
        this.sendMessage('user_typing', {
            channel_id: channelId,
            parent_id: parentId,
        });
    }

    public isConnected(): boolean {
        return this.conn?.readyState === WebSocket.OPEN; //|| (!this.stop && this.connectFailCount <= 2);
    }
}
