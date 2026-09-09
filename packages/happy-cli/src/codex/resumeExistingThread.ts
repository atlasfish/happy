import { trimIdent } from '@/utils/trimIdent';
import { randomUUID } from 'node:crypto';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { Thread } from './codexAppServerTypes';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';

type ResumeThreadClient = {
    resumeThread: (opts: {
        threadId: string;
        cwd: string;
        mcpServers: Record<string, unknown>;
    }) => Promise<{ threadId: string; model: string }>;
    readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }>;
};

type ResumeThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    sendClaudeSessionMessage: (message: { type: 'summary'; summary: string; leafUuid: string }) => void;
    sendSessionProtocolMessage: (envelope: any) => void;
    uploadLocalImageAttachmentEnvelope: (...args: any[]) => Promise<any>;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    /**
     * Whether to surface a "Resumed Codex thread …" message in the chat UI.
     * Side chats open empty on purpose, so they pass `false` to keep this
     * internal resume detail out of the conversation. Defaults to `true`.
     */
    announce?: boolean;
    backfillTurns?: number;
}): Promise<{ threadId: string; model: string }> {
    try {
        const resumedThread = await opts.client.resumeThread({
            threadId: opts.threadId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers,
        });

        opts.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            codexThreadId: resumedThread.threadId,
        }));
        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumedThread.threadId)}`, 'status');
        if (opts.announce !== false) {
            opts.session.sendSessionEvent({
                type: 'message',
                message: `Resumed Codex thread ${resumedThread.threadId}`,
            });

            try {
                const { thread } = await opts.client.readThread({
                    threadId: resumedThread.threadId,
                    includeTurns: true,
                });
                const title = thread.name?.trim();
                if (title) {
                    opts.session.sendClaudeSessionMessage({
                        type: 'summary',
                        summary: title,
                        leafUuid: randomUUID(),
                    });
                    logger.debug(`[Codex] Synced Happy session title from resumed thread: ${title}`);
                }

                const backfillTurns = opts.backfillTurns ?? configuration.codexResumeBackfillTurns;
                const turns = backfillTurns === 0 ? [] : (thread.turns ?? []).slice(-backfillTurns);
                const envelopes = await buildCodexThreadBackfillEnvelopes({
                    thread: { ...thread, turns },
                    uploadLocalImage: (attachment, imageOpts) => (
                        opts.session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                    ),
                });
                for (const envelope of envelopes) {
                    opts.session.sendSessionProtocolMessage(envelope);
                }
                logger.debug(`[CODEX RESUME BACKFILL] Replayed ${envelopes.length} envelopes from ${turns.length} recent turns`);
            } catch (error) {
                logger.debug('[CODEX RESUME BACKFILL] Title/history sync failed:', error);
            }
        }

        return resumedThread;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resume Codex thread ${opts.threadId}: ${reason}`);
    }
}
