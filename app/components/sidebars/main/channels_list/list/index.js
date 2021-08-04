// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import {connect} from 'react-redux';

import {DeviceTypes, ViewTypes} from '@constants';
import {General} from '@mm-redux/constants';
import Permissions from '@mm-redux/constants/permissions';
import {
    getSortedFavoriteChannelIds,
    getSortedUnreadChannelIds,
    getOrderedChannelIds,
    getChannelsByCategoryForCurrentTeam,
} from '@mm-redux/selectors/entities/channels';
import {getConfig, getLicense, hasNewPermissions} from '@mm-redux/selectors/entities/general';
import {getTheme, getFavoritesPreferences, getSidebarPreferences, isCollapsedThreadsEnabled} from '@mm-redux/selectors/entities/preferences';
import {haveITeamPermission} from '@mm-redux/selectors/entities/roles';
import {getCurrentTeamId} from '@mm-redux/selectors/entities/teams';
import {getCurrentUserId, getCurrentUserRoles} from '@mm-redux/selectors/entities/users';
import {showCreateOption} from '@mm-redux/utils/channel_utils';
import {memoizeResult} from '@mm-redux/utils/helpers';
import {isAdmin as checkIsAdmin, isSystemAdmin as checkIsSystemAdmin} from '@mm-redux/utils/user_utils';
import {shouldShowLegacySidebar} from '@utils/categories';

import List from './list';

const filterZeroUnreads = memoizeResult((sections) => {
    return sections.filter((s) => {
        if (s.type === ViewTypes.SidebarSectionTypes.UNREADS) {
            return s.items.length > 0;
        }
        return true;
    });
});

function mapStateToProps(state) {
    const config = getConfig(state);
    const collapsedThreadsEnabled = isCollapsedThreadsEnabled(state);
    const license = getLicense(state);
    const roles = getCurrentUserId(state) ? getCurrentUserRoles(state) : '';
    const currentTeamId = getCurrentTeamId(state);
    const isAdmin = checkIsAdmin(roles);
    const isSystemAdmin = checkIsSystemAdmin(roles);
    const sidebarPrefs = getSidebarPreferences(state);
    const lastUnreadChannel = DeviceTypes.IS_TABLET ? state.views.channel.keepChannelIdAsUnread : null;
    const unreadChannelIds = getSortedUnreadChannelIds(state, lastUnreadChannel);
    const favoriteChannelIds = getSortedFavoriteChannelIds(state);
    const orderedChannelIds = filterZeroUnreads(getOrderedChannelIds(
        state,
        lastUnreadChannel,
        sidebarPrefs.grouping,
        sidebarPrefs.sorting,
        true, // The mobile app should always display the Unreads section regardless of user settings (MM-13420)
        sidebarPrefs.favorite_at_top === 'true' && favoriteChannelIds.length,
    ));
    const channelsByCategory = getChannelsByCategoryForCurrentTeam(state);

    let canJoinPublicChannels = true;
    if (hasNewPermissions(state)) {
        canJoinPublicChannels = haveITeamPermission(state, {
            team: currentTeamId,
            permission: Permissions.JOIN_PUBLIC_CHANNELS,
        });
    }
    const canCreatePublicChannels = showCreateOption(state, config, license, currentTeamId, General.OPEN_CHANNEL, isAdmin, isSystemAdmin);
    const canCreatePrivateChannels = showCreateOption(state, config, license, currentTeamId, General.PRIVATE_CHANNEL, isAdmin, isSystemAdmin);

    const showLegacySidebar = shouldShowLegacySidebar(config);

    return {
        theme: getTheme(state),
        canJoinPublicChannels,
        canCreatePrivateChannels,
        canCreatePublicChannels,
        collapsedThreadsEnabled,
        unreadChannelIds,
        favoriteChannelIds,
        orderedChannelIds,
        channelsByCategory,
        showLegacySidebar,
    };
}

function areStatesEqual(next, prev) {
    const equalRoles = getCurrentUserRoles(prev) === getCurrentUserRoles(next);
    const equalChannels = next.entities.channels === prev.entities.channels;
    const equalConfig = next.entities.general.config === prev.entities.general.config;
    const equalUsers = next.entities.users.profiles === prev.entities.users.profiles;
    const equalFav = getFavoritesPreferences(next) === getFavoritesPreferences(prev);

    return equalChannels && equalConfig && equalRoles && equalUsers && equalFav;
}

export default connect(mapStateToProps, null, null, {pure: true, areStatesEqual})(List);
