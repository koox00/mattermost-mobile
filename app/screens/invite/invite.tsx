// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback, useEffect, useState, useRef} from 'react';
import {IntlShape, useIntl} from 'react-intl';
import {Keyboard, View, LayoutChangeEvent} from 'react-native';
import {ImageResource, OptionsTopBarButton} from 'react-native-navigation';
import {SafeAreaView} from 'react-native-safe-area-context';

import {getTeamMembersByIds, addUsersToTeam, sendEmailInvitesToTeam} from '@actions/remote/team';
import {searchProfiles} from '@actions/remote/user';
import Loading from '@components/loading';
import {General, ServerErrors} from '@constants';
import {useServerUrl} from '@context/server';
import {useTheme} from '@context/theme';
import {useModalPosition} from '@hooks/device';
import useNavButtonPressed from '@hooks/navigation_button_pressed';
import {dismissModal, setButtons, setTitle} from '@screens/navigation';
import {isEmail} from '@utils/helpers';
import {makeStyleSheetFromTheme, changeOpacity} from '@utils/theme';
import {isGuest} from '@utils/user';

import Selection from './selection';
import Summary from './summary';

import type {NavButtons} from '@typings/screens/navigation';

const CLOSE_BUTTON_ID = 'close-invite';
const SEND_BUTTON_ID = 'send-invite';

const makeLeftButton = (icon: ImageResource): OptionsTopBarButton => {
    return {
        id: CLOSE_BUTTON_ID,
        icon,
        testID: 'invite.close.button',
    };
};

const makeRightButton = (theme: Theme, formatMessage: IntlShape['formatMessage'], enabled: boolean): OptionsTopBarButton => ({
    id: SEND_BUTTON_ID,
    text: formatMessage({id: 'invite.send_invite', defaultMessage: 'Send'}),
    showAsAction: 'always',
    testID: 'invite.send.button',
    color: theme.sidebarHeaderTextColor,
    disabledColor: changeOpacity(theme.sidebarHeaderTextColor, 0.4),
    enabled,
});

const closeModal = async () => {
    Keyboard.dismiss();
    await dismissModal();
};

const getStyleSheet = makeStyleSheetFromTheme(() => {
    return {
        container: {
            flex: 1,
            flexDirection: 'column',
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
        },
    };
});

export type EmailInvite = string;

export type SearchResult = UserProfile|EmailInvite;

export type InviteResult = {
    userId: string;
    reason: string;
};

export type Result = {
    sent: InviteResult[];
    notSent: InviteResult[];
}

enum Stage {
    SELECTION = 'selection',
    RESULT = 'result',
    LOADING = 'loading',
}

type InviteProps = {
    componentId: string;
    closeButton: ImageResource;

    teamId: string;
    teamDisplayName: string;
    teamLastIconUpdate: number;
    teamInviteId: string;
    teammateNameDisplay: string;
    isAdmin: boolean;
}

export default function Invite({
    componentId,
    closeButton,
    teamId,
    teamDisplayName,
    teamLastIconUpdate,
    teamInviteId,
    teammateNameDisplay,
    isAdmin,
}: InviteProps) {
    const intl = useIntl();
    const {formatMessage, locale} = intl;
    const theme = useTheme();
    const styles = getStyleSheet(theme);
    const serverUrl = useServerUrl();
    const mainView = useRef<View>(null);
    const modalPosition = useModalPosition(mainView);

    const searchTimeoutId = useRef<NodeJS.Timeout | null>(null);

    const [term, setTerm] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [selectedIds, setSelectedIds] = useState<{[id: string]: SearchResult}>({});
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<Result>({sent: [], notSent: []});
    const [wrapperHeight, setWrapperHeight] = useState(0);
    const [stage, setStage] = useState(Stage.SELECTION);

    const selectedCount = Object.keys(selectedIds).length;

    const onLayoutWrapper = useCallback((e: LayoutChangeEvent) => {
        setWrapperHeight(e.nativeEvent.layout.height);
    }, []);

    const setHeaderButtons = useCallback((right: boolean, rightEnabled: boolean) => {
        const buttons: NavButtons = {
            leftButtons: [makeLeftButton(closeButton)],
            rightButtons: right ? [makeRightButton(theme, formatMessage, rightEnabled)] : [],
        };

        setButtons(componentId, buttons);
    }, [closeButton, locale, theme, componentId]);

    const setHeaderTitle = useCallback((title: string) => {
        setTitle(componentId, title);
    }, [locale, theme, componentId]);

    const searchUsers = useCallback(async (searchTerm: string) => {
        if (searchTerm === '') {
            handleClearSearch();
            return;
        }

        const {data} = await searchProfiles(serverUrl, searchTerm.toLowerCase(), {allow_inactive: true});
        const results: SearchResult[] = data ?? [];

        if (isEmail(searchTerm.trim())) {
            results.unshift(searchTerm.trim() as EmailInvite);
        }

        setSearchResults(results);
    }, [serverUrl, teamId]);

    const handleClearSearch = useCallback(() => {
        setTerm('');
        setSearchResults([]);
    }, []);

    const handleSearchChange = useCallback((text: string) => {
        setLoading(true);
        setTerm(text);

        if (searchTimeoutId.current) {
            clearTimeout(searchTimeoutId.current);
        }

        searchTimeoutId.current = setTimeout(async () => {
            await searchUsers(text);
            setLoading(false);
        }, General.SEARCH_TIMEOUT_MILLISECONDS);
    }, [searchUsers]);

    const handleSelectItem = useCallback((item: SearchResult) => {
        const email = typeof item === 'string';
        const id = email ? item : (item as UserProfile).id;
        const newSelectedIds = Object.assign({}, selectedIds);

        if (!selectedIds[id]) {
            newSelectedIds[id] = item;
        }

        setSelectedIds(newSelectedIds);

        handleClearSearch();
    }, [selectedIds, handleClearSearch]);

    const handleSend = async () => {
        if (!selectedCount) {
            return;
        }

        setStage(Stage.LOADING);

        const userIds = [];
        const emails = [];

        for (const [id, item] of Object.entries(selectedIds)) {
            if (typeof item === 'string') {
                emails.push(item);
            } else {
                userIds.push(id);
            }
        }

        const {members: currentTeamMembers = []} = await getTeamMembersByIds(serverUrl, teamId, userIds);
        const currentMemberIds: Record<string, boolean> = {};

        for (const {user_id: currentMemberId} of currentTeamMembers) {
            currentMemberIds[currentMemberId] = true;
        }

        const sent: InviteResult[] = [];
        const notSent: InviteResult[] = [];
        const usersToAdd = [];

        for (const userId of userIds) {
            if (isGuest((selectedIds[userId] as UserProfile).roles)) {
                notSent.push({userId, reason: formatMessage({id: 'invite.members.user-is-guest', defaultMessage: 'Contact your admin to make this guest a full member'})});
            } else if (currentMemberIds[userId]) {
                notSent.push({userId, reason: formatMessage({id: 'invite.members.already-member', defaultMessage: 'This person is already a team member'})});
            } else {
                usersToAdd.push(userId);
            }
        }

        if (usersToAdd.length) {
            const {members} = await addUsersToTeam(serverUrl, teamId, usersToAdd);

            if (members) {
                const membersWithError: Record<string, string> = {};
                for (const {user_id, error} of members) {
                    if (error) {
                        membersWithError[user_id] = error.message;
                    }
                }

                for (const userId of usersToAdd) {
                    if (membersWithError[userId]) {
                        notSent.push({userId, reason: membersWithError[userId]});
                    } else {
                        sent.push({userId, reason: formatMessage({id: 'invite.summary.member_invite', defaultMessage: 'Invited as a member of {teamDisplayName}'}, {teamDisplayName})});
                    }
                }
            }
        }

        if (emails.length) {
            const {members} = await sendEmailInvitesToTeam(serverUrl, teamId, emails);

            if (members) {
                const membersWithError: Record<string, string> = {};
                for (const {email, error} of members) {
                    if (error) {
                        membersWithError[email] = isAdmin && error.server_error_id === ServerErrors.SEND_EMAIL_WITH_DEFAULTS_ERROR ? (
                            formatMessage({id: 'invite.summary.smtp_failure', defaultMessage: 'SMTP is not configured in System Console'})
                        ) : (
                            error.message
                        );
                    }
                }

                for (const email of emails) {
                    if (membersWithError[email]) {
                        notSent.push({userId: email, reason: membersWithError[email]});
                    } else {
                        sent.push({userId: email, reason: formatMessage({id: 'invite.summary.email_invite', defaultMessage: 'An invitation email has been sent'})});
                    }
                }
            }
        }

        setResult({sent, notSent});
        setStage(Stage.RESULT);
    };

    useNavButtonPressed(CLOSE_BUTTON_ID, componentId, closeModal, [closeModal]);
    useNavButtonPressed(SEND_BUTTON_ID, componentId, handleSend, [handleSend]);

    useEffect(() => {
        // Update header buttons in case anything related to the header changes
        setHeaderButtons(stage === Stage.SELECTION, selectedCount > 0);
    }, [theme, locale, selectedCount, stage]);

    useEffect(() => {
        if (stage === Stage.RESULT) {
            // Update header title in case anything related to the header changes
            setHeaderTitle(formatMessage({id: 'invite.title.summary', defaultMessage: 'Invite summary'}));
        }
    }, [locale, stage]);

    const handleRemoveItem = useCallback((id: string) => {
        const newSelectedIds = Object.assign({}, selectedIds);

        Reflect.deleteProperty(newSelectedIds, id);

        setSelectedIds(newSelectedIds);
    }, [selectedIds]);

    const renderContent = () => {
        switch (stage) {
            case Stage.LOADING:
                return (
                    <Loading
                        containerStyle={styles.loadingContainer}
                        size='large'
                        color={theme.centerChannelColor}
                    />
                );
            case Stage.RESULT:
                return (
                    <Summary
                        result={result}
                        selectedIds={selectedIds}
                        onClose={closeModal}
                        testID='invite.screen.summary'
                    />
                );
            default:
                return (
                    <Selection
                        teamId={teamId}
                        teamDisplayName={teamDisplayName}
                        teamLastIconUpdate={teamLastIconUpdate}
                        teamInviteId={teamInviteId}
                        teammateNameDisplay={teammateNameDisplay}
                        serverUrl={serverUrl}
                        term={term}
                        searchResults={searchResults}
                        selectedIds={selectedIds}
                        modalPosition={modalPosition}
                        wrapperHeight={wrapperHeight}
                        loading={loading}
                        onSearchChange={handleSearchChange}
                        onSelectItem={handleSelectItem}
                        onRemoveItem={handleRemoveItem}
                        onClose={closeModal}
                        testID='invite.screen.selection'
                    />
                );
        }
    };

    return (
        <SafeAreaView
            style={styles.container}
            onLayout={onLayoutWrapper}
            ref={mainView}
            testID='invite.screen'
        >
            {renderContent()}
        </SafeAreaView>
    );
}
