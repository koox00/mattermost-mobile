// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {lte} from 'semver';

import {Client4} from '@client/rest';
import {Config} from '@mm-redux/types/config';

export const shouldShowLegacySidebar = (config: Partial<Config>) => {
    const serverVersion = config.Version || Client4.getServerVersion();

    if (!serverVersion) {
        return false;
    }

    return (lte('5.31.0', serverVersion) && config.ExperimentalChannelSidebarOrganization === 'true') || config.EnableLegacySidebar !== 'false';
};
