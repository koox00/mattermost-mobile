// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {lte} from 'semver';

import {Config} from '@mm-redux/types/config';

export const shouldShowLegacySidebar = (config: Partial<Config>) => {
    return (lte('5.31.0', config.Version!) && config.ExperimentalChannelSidebarOrganization === 'true') || config.EnableLegacySidebar !== 'false';
};
