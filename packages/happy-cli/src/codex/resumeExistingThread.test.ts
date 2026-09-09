import { describe, expect, it, vi } from 'vitest';

import { resumeExistingThread } from './resumeExistingThread';

describe('resumeExistingThread', () => {
    it('resumes the thread and updates session metadata', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                model: 'gpt-5.4',
            }),
            readThread: vi.fn().mockResolvedValue({
                thread: { id: '019ccca2-1a77-7481-9873-de72f3464372', name: 'Existing Codex title', turns: [] },
            }),
        };
        const metadataHandlers: Array<(metadata: any) => any> = [];
        const session = {
            updateMetadata: vi.fn((handler) => metadataHandlers.push(handler)),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
            uploadLocalImageAttachmentEnvelope: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer,
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });

        expect(result).toEqual({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            model: 'gpt-5.4',
        });
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });
        expect(metadataHandlers).toHaveLength(1);
        expect(metadataHandlers[0]({ existing: true })).toEqual({
            existing: true,
            codexThreadId: '019ccca2-1a77-7481-9873-de72f3464372',
        });
        expect(messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Resumed thread'), 'status');
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Resumed Codex thread 019ccca2-1a77-7481-9873-de72f3464372',
        });
        expect(session.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'summary',
            summary: 'Existing Codex title',
        }));
    });

    it('wraps backend resume errors with the thread ID', async () => {
        const client = {
            resumeThread: vi.fn().mockRejectedValue(new Error('thread not found')),
            readThread: vi.fn(),
        };
        const session = {
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
            uploadLocalImageAttachmentEnvelope: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        await expect(
            resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: 'thread-404',
                cwd: '/tmp/project',
                mcpServers: {},
            }),
        ).rejects.toThrow('Failed to resume Codex thread thread-404: thread not found');
    });

    it('backfills only the configured number of recent turns', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({ threadId: 'thread-1', model: 'gpt' }),
            readThread: vi.fn().mockResolvedValue({
                thread: {
                    id: 'thread-1',
                    turns: ['one', 'two', 'three'].map((id) => ({ id, items: [], status: 'completed' })),
                },
            }),
        };
        const session = {
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
            uploadLocalImageAttachmentEnvelope: vi.fn(),
        };

        await resumeExistingThread({
            client,
            session,
            messageBuffer: { addMessage: vi.fn() },
            threadId: 'thread-1',
            cwd: '/tmp/project',
            mcpServers: {},
            backfillTurns: 2,
        });

        expect(session.sendSessionProtocolMessage).toHaveBeenCalledTimes(4);
        expect(session.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.turn)).toEqual([
            'two', 'two', 'three', 'three',
        ]);
    });

    it('does not read or replay history for side chats', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({ threadId: 'thread-1', model: 'gpt' }),
            readThread: vi.fn(),
        };
        const session = {
            updateMetadata: vi.fn(), sendSessionEvent: vi.fn(), sendClaudeSessionMessage: vi.fn(),
            sendSessionProtocolMessage: vi.fn(), uploadLocalImageAttachmentEnvelope: vi.fn(),
        };
        await resumeExistingThread({
            client, session, messageBuffer: { addMessage: vi.fn() }, threadId: 'thread-1', cwd: '/tmp',
            mcpServers: {}, announce: false,
        });
        expect(client.readThread).not.toHaveBeenCalled();
        expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    });

    it('allows history backfill to be disabled while still syncing the title', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({ threadId: 'thread-1', model: 'gpt' }),
            readThread: vi.fn().mockResolvedValue({
                thread: { id: 'thread-1', name: 'Keep this title', turns: [{ id: 'turn-1', items: [] }] },
            }),
        };
        const session = {
            updateMetadata: vi.fn(), sendSessionEvent: vi.fn(), sendClaudeSessionMessage: vi.fn(),
            sendSessionProtocolMessage: vi.fn(), uploadLocalImageAttachmentEnvelope: vi.fn(),
        };
        await resumeExistingThread({
            client, session, messageBuffer: { addMessage: vi.fn() }, threadId: 'thread-1', cwd: '/tmp',
            mcpServers: {}, backfillTurns: 0,
        });
        expect(session.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Keep this title' }));
        expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    });
});
