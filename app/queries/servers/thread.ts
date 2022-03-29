// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Database, Q, Query} from '@nozbe/watermelondb';
import {combineLatest, of as of$} from 'rxjs';
import {map, switchMap} from 'rxjs/operators';

import {Preferences} from '@constants';
import {MM_TABLES, SYSTEM_IDENTIFIERS} from '@constants/database';
import {getPreferenceValue} from '@helpers/api/preference';

import type PreferenceModel from '@typings/database/models/servers/preference';
import type SystemModel from '@typings/database/models/servers/system';
import type ThreadModel from '@typings/database/models/servers/thread';

const {SERVER: {THREADS_IN_TEAM, PREFERENCE, SYSTEM, THREAD}} = MM_TABLES;

export function processIsCRTEnabled(preferences: PreferenceModel[], config?: ClientConfig): boolean {
    let preferenceDefault = Preferences.COLLAPSED_REPLY_THREADS_OFF;
    const configValue = config?.CollapsedThreads;
    if (configValue === 'default_on') {
        preferenceDefault = Preferences.COLLAPSED_REPLY_THREADS_ON;
    }
    const preference = getPreferenceValue(preferences, Preferences.CATEGORY_DISPLAY_SETTINGS, Preferences.COLLAPSED_REPLY_THREADS, preferenceDefault);

    const isAllowed = config?.FeatureFlagCollapsedThreads === 'true' && config?.CollapsedThreads !== 'disabled';

    return isAllowed && (preference === Preferences.COLLAPSED_REPLY_THREADS_ON || config?.CollapsedThreads === 'always_on');
}

export const getIsCRTEnabled = async (database: Database): Promise<boolean> => {
    const {value: config} = await database.get<SystemModel>(SYSTEM).find(SYSTEM_IDENTIFIERS.CONFIG);
    const preferences = await database.get<PreferenceModel>(PREFERENCE).query(Q.where('category', Preferences.CATEGORY_DISPLAY_SETTINGS)).fetch();
    return processIsCRTEnabled(preferences, config);
};

export const getThreadById = async (database: Database, threadId: string) => {
    try {
        const thread = await database.get<ThreadModel>(THREAD).find(threadId);
        return thread;
    } catch {
        return undefined;
    }
};

export const observeIsCRTEnabled = (database: Database) => {
    const config = database.get<SystemModel>(SYSTEM).findAndObserve(SYSTEM_IDENTIFIERS.CONFIG);
    const preferences = database.get<PreferenceModel>(PREFERENCE).query(Q.where('category', Preferences.CATEGORY_DISPLAY_SETTINGS)).observe();
    return combineLatest([config, preferences]).pipe(
        map(
            ([{value: cfg}, prefs]) => processIsCRTEnabled(prefs, cfg),
        ),
    );
};

export const queryThreadById = (database: Database, threadId: string) => {
    return database.get<ThreadModel>(THREAD).query(
        Q.where('id', threadId),
    ).observe().pipe(
        switchMap((threads) => threads[0]?.observe() || of$(undefined)),
    );
};

type QueryThreadsInTeamArgs = {
    database: Database;
    hasReplies?: boolean;
    isFollowing?: boolean;
    onlyUnreads?: boolean;
    sort?: boolean;
    teamId?: string;
    limit?: number;
};

export const queryThreadsInTeam = ({database, hasReplies = true, isFollowing = true, onlyUnreads, sort, teamId, limit}: QueryThreadsInTeamArgs): Query<ThreadModel> => {
    const query: Q.Clause[] = [];

    if (isFollowing) {
        query.push(Q.where('is_following', true));
    }

    // Posts can be followed even without replies, they shouldn't be displayed in global threads
    if (hasReplies) {
        query.push(Q.where('reply_count', Q.gt(0)));
    }

    // If teamId is specified, only get threads in that team (includes DM/GMs)
    if (teamId) {
        query.push(
            Q.on(THREADS_IN_TEAM, 'team_id', teamId),
        );
    }

    if (onlyUnreads) {
        query.push(Q.where('unread_replies', Q.gt(0)));
    } else {
        query.push(Q.where('loaded_in_global_threads', true));
    }

    if (sort) {
        query.push(Q.sortBy('last_reply_at', Q.desc));
    }

    if (limit) {
        query.push(Q.take(limit));
    }

    return database.get<ThreadModel>(THREAD).query(...query);
};

export const queryUnreadsAndMentionsInTeam = (database: Database, teamId: string) => {
    return queryThreadsInTeam({database, teamId, onlyUnreads: true}).observeWithColumns(['unread_replies', 'unread_mentions']).pipe(
        switchMap((threads) => {
            let unreads = 0;
            let mentions = 0;
            threads.forEach((thread) => {
                unreads += thread.unreadReplies;
                mentions += thread.unreadMentions;
            });
            return of$({unreads, mentions});
        }),
    );
};

export async function getNewestThreadInTeam(
    database: Database,
    teamId: string,
    unread: boolean,
): Promise<ThreadModel | undefined> {
    try {
        const threads = await queryThreadsInTeam({database, isFollowing: true, onlyUnreads: unread, sort: true, teamId, limit: 1}).fetch();
        return threads?.[0] || undefined;
    } catch (e) {
        return undefined;
    }
}