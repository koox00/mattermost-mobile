// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {shallow} from 'enzyme';
import React from 'react';

import Preferences from '@mm-redux/constants/preferences';

import List from './list';

describe('ChannelsList List', () => {
    const baseProps = {
        onSelectChannel: jest.fn(),
        testID: 'main.sidebar.channels_list.list',
        canJoinPublicChannels: true,
        canCreatePrivateChannels: true,
        canCreatePublicChannels: true,
        showLegacySidebar: true,
        collapsedThreadsEnabled: false,
        favoriteChannelIds: [],
        unreadChannelIds: [],
        styles: {},
        theme: Preferences.THEMES.default,
        orderedChannelIds: [],
        isLandscape: false,
        onCollapseCategory: jest.fn(),
    };

    test('should match snapshot', () => {
        const wrapper = shallow(<List {...baseProps}/>);

        expect(wrapper.getElement()).toMatchSnapshot();
    });

    test('should match snapshot with collapsed threads enabled', () => {
        const wrapper = shallow(
            <List
                {...baseProps}
                collapsedThreadsEnabled={true}
            />,
        );

        expect(wrapper.getElement()).toMatchSnapshot();
    });
});
