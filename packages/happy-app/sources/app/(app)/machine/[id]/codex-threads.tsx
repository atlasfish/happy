import React from 'react';
import { ActivityIndicator, RefreshControl, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useMachine, useSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import {
    codexListThreads,
    machineSpawnNewSession,
    machineStopSession,
    type CodexHistoricalThread,
} from '@/sync/ops';
import { isMachineOnline } from '@/utils/machineUtils';

function formatUpdatedAt(value: number): string {
    if (!value) return '';
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toLocaleString();
}

export default function CodexThreadsScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const machine = useMachine(machineId!);
    const sessions = useSessions();
    const navigateToSession = useNavigateToSession();
    const [threads, setThreads] = React.useState<CodexHistoricalThread[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [resumingId, setResumingId] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async (cursor?: string) => {
        if (!machineId) return;
        const result = await codexListThreads({ machineId, cursor, limit: 50 });
        if (result.type === 'error') {
            setError(result.errorMessage);
            return;
        }
        setError(null);
        setThreads((current) => cursor ? [...current, ...result.threads] : result.threads);
        setNextCursor(result.nextCursor);
    }, [machineId]);

    React.useEffect(() => {
        void load().finally(() => setLoading(false));
    }, [load]);

    const refresh = React.useCallback(async () => {
        setRefreshing(true);
        try {
            await load();
        } finally {
            setRefreshing(false);
        }
    }, [load]);

    const resume = React.useCallback(async (thread: CodexHistoricalThread) => {
        if (!machineId || !thread.cwd) {
            Modal.alert('Cannot Resume', 'This Codex thread does not contain a working directory.');
            return;
        }
        const existing = (sessions ?? []).find((value) => (
            typeof value !== 'string'
            && value.metadata?.machineId === machineId
            && value.metadata?.codexThreadId === thread.id
            && value.presence === 'online'
        ));

        if (existing && typeof existing !== 'string') {
            const close = await Modal.confirm(
                'Codex Thread Already Open',
                'This thread is already running in Happy on this computer. Close that process and resume it in a new Happy session?',
                { cancelText: 'Cancel', confirmText: 'Close and Resume', destructive: true },
            );
            if (!close) return;
            const stopped = await machineStopSession(machineId, existing.id);
            if (!stopped.success) {
                Modal.alert('Unable to Stop Session', stopped.message ?? 'The existing process could not be stopped.');
                return;
            }
        } else {
            const proceed = await Modal.confirm(
                'Resume Codex Thread?',
                'If this thread is open in Codex Desktop or VS Code, close it there first. Happy cannot safely identify and close an external Codex process. Continue?',
                { cancelText: 'Cancel', confirmText: 'Resume' },
            );
            if (!proceed) return;
        }

        setResumingId(thread.id);
        try {
            const result = await machineSpawnNewSession({
                machineId,
                directory: thread.cwd,
                agent: 'codex',
                resumeCodexThreadId: thread.id,
            });
            if (result.type !== 'success') {
                const message = result.type === 'error'
                    ? result.errorMessage
                    : result.type === 'requestToApproveDirectoryCreation'
                        ? `The working directory no longer exists: ${result.directory}`
                        : 'The machine has not finished starting the session. Please try again.';
                Modal.alert('Failed to Resume', message);
                return;
            }
            await sync.refreshSessions();
            navigateToSession(result.sessionId);
        } catch (error) {
            Modal.alert('Failed to Resume', error instanceof Error ? error.message : 'The session could not be resumed.');
        } finally {
            setResumingId(null);
        }
    }, [machineId, navigateToSession, sessions]);

    const online = Boolean(machine && isMachineOnline(machine));
    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: 'Codex History' }} />
            <ItemList
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
                keyboardShouldPersistTaps="handled"
            >
                {!online && (
                    <ItemGroup>
                        <Item title="Machine Offline" subtitle="Start the Happy daemon on this computer to browse or resume Codex threads." showChevron={false} />
                    </ItemGroup>
                )}
                {loading ? (
                    <View style={{ padding: 32, alignItems: 'center' }}><ActivityIndicator /></View>
                ) : error ? (
                    <ItemGroup><Item title="Unable to Load Codex History" subtitle={error} onPress={() => void refresh()} /></ItemGroup>
                ) : threads.length === 0 ? (
                    <ItemGroup><Item title="No Codex Threads" subtitle="No local Codex history was found on this computer." showChevron={false} /></ItemGroup>
                ) : (
                    <ItemGroup>
                        {threads.map((thread) => (
                            <Item
                                key={thread.id}
                                title={thread.name?.trim() || thread.preview.trim() || 'Untitled Codex thread'}
                                subtitle={[thread.cwd, formatUpdatedAt(thread.updatedAt)].filter(Boolean).join('\n')}
                                subtitleLines={3}
                                onPress={online && !resumingId ? () => void resume(thread) : undefined}
                                disabled={!online || Boolean(resumingId)}
                                loading={resumingId === thread.id}
                            />
                        ))}
                        {nextCursor && (
                            <Item title="Load More" onPress={() => void load(nextCursor)} />
                        )}
                    </ItemGroup>
                )}
                <Text style={{ color: theme.colors.textSecondary, padding: 16, fontSize: 13 }}>
                    Resuming creates a new Happy session and reconnects it to the selected local Codex thread.
                </Text>
            </ItemList>
        </>
    );
}
