// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {processReceivedThreads, processUpdateTeamThreadsAsRead, processUpdateThreadFollow, processUpdateThreadRead} from '@actions/local/thread';
import DatabaseManager from '@database/manager';

export async function handleThreadUpdatedEvent(serverUrl: string, msg: WebSocketMessage): Promise<void> {
    try {
        const thread = JSON.parse(msg.data.thread) as Thread;
        const teamId = msg.broadcast.team_id;

        // Mark it as following and visible in global threads
        thread.is_following = true;
        thread.loaded_in_global_threads = true;
        processReceivedThreads(serverUrl, [thread], teamId);
    } catch (error) {
        // Do nothing
    }
}

type ThreadReadChangedData = {
    thread_id: string;
    timestamp: number;
    unread_mentions: number;
    unread_replies: number;
};

export async function handleThreadReadChangedEvent(serverUrl: string, msg: WebSocketMessage): Promise<void> {
    const database = DatabaseManager.serverDatabases[serverUrl];
    if (!database) {
        return;
    }

    try {
        const operator = database?.operator;
        if (operator) {
            const {thread_id, timestamp, unread_mentions, unread_replies} = msg.data as ThreadReadChangedData;
            if (thread_id) {
                processUpdateThreadRead(serverUrl, thread_id, timestamp, unread_mentions, unread_replies);
            } else {
                processUpdateTeamThreadsAsRead(serverUrl, msg.broadcast.team_id);
            }
        }
    } catch (error) {
        // Do nothing
    }
}

export async function handleThreadFollowChangedEvent(serverUrl: string, msg: WebSocketMessage): Promise<void> {
    const database = DatabaseManager.serverDatabases[serverUrl];
    if (!database) {
        return;
    }

    try {
        const operator = database?.operator;
        if (operator) {
            const {reply_count, state, thread_id} = msg.data as {
                reply_count: number;
                state: boolean;
                thread_id: string;
            };
            processUpdateThreadFollow(serverUrl, thread_id, state, reply_count);
        }
    } catch (error) {
        // Do nothing
    }
}