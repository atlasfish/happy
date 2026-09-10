import { beforeEach, describe, expect, it, vi } from 'vitest';

const { codexClientMethods, writerMethods } = vi.hoisted(() => ({
    codexClientMethods: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        forkThread: vi.fn(),
        readThread: vi.fn(),
        listThreads: vi.fn(),
        rollbackThread: vi.fn(),
        injectItems: vi.fn(),
    },
    writerMethods: {
        findCodexThreadWriterOwners: vi.fn(),
        forceCloseCodexThreadWriters: vi.fn(),
    },
}));

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn().mockImplementation(() => codexClientMethods),
}));

vi.mock('@/codex/codexThreadWriter', () => writerMethods);

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

describe('ApiMachineClient Codex fork RPCs', () => {
    beforeEach(() => {
        for (const method of Object.values(codexClientMethods)) {
            method.mockReset();
        }
        codexClientMethods.connect.mockResolvedValue(undefined);
        codexClientMethods.disconnect.mockResolvedValue(undefined);
        writerMethods.findCodexThreadWriterOwners.mockResolvedValue([]);
        writerMethods.forceCloseCodexThreadWriters.mockResolvedValue([]);
    });

    it('registers a full Codex thread fork RPC', async () => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: { id: 'thread-forked', turns: [] },
        });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-fork-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.connect).toHaveBeenCalledOnce();
        expect(codexClientMethods.forkThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            cwd: '/tmp/project',
        });
        expect(codexClientMethods.disconnect).toHaveBeenCalledOnce();
    });

    it('forwards resumeCodexThreadId through the spawn RPC', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-forked' });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        }));
    });

    it('lists Codex rewind points from thread/read', async () => {
        codexClientMethods.readThread.mockResolvedValue({
            thread: {
                id: 'thread-source',
                turns: [{
                    id: 'turn-1',
                    startedAt: 10,
                    items: [
                        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                    ],
                }],
            },
        });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-list-rewind-points')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({
            type: 'success',
            points: [{ itemId: 'user-1', text: 'hello', timestamp: 10_000 }],
        });
        expect(codexClientMethods.readThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            includeTurns: true,
        });
    });

    it('lists normalized Codex history without sending turns to the app', async () => {
        codexClientMethods.listThreads.mockResolvedValue({
            data: [{
                id: 'thread-1', name: 'Saved title', preview: 'hello', cwd: '/tmp/project',
                updatedAt: 123, turns: [{ id: 'turn-1', items: [] }],
            }],
            nextCursor: 'next-page',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });

        const result = await handlersFrom(client).get('machine-1:codex-list-threads')?.({
            limit: 20,
            cursor: 'cursor-1',
        });

        expect(codexClientMethods.listThreads).toHaveBeenCalledWith({
            limit: 20,
            cursor: 'cursor-1',
            searchTerm: undefined,
        });
        expect(result).toEqual({
            type: 'success',
            threads: [{ id: 'thread-1', name: 'Saved title', preview: 'hello', cwd: '/tmp/project', updatedAt: 123 }],
            nextCursor: 'next-page',
        });
    });

    it('reports the exact application holding a Codex writer lock', async () => {
        writerMethods.findCodexThreadWriterOwners.mockResolvedValue([{
            pid: 32992,
            processName: 'codex.exe',
            appPid: 26668,
            appName: 'Codex Desktop',
            canForceClose: true,
        }]);
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });

        const result = await handlersFrom(client).get('machine-1:codex-inspect-thread-writer')?.({
            directory: '/tmp/project',
            codexThreadId: '01a05792-9d44-7dc0-baec-722d9c508ef8',
        });

        expect(result).toEqual({
            type: 'locked',
            owners: [expect.objectContaining({ appName: 'Codex Desktop', appPid: 26668 })],
        });
        expect(codexClientMethods.connect).not.toHaveBeenCalled();
    });

    it('force closes only the writer resolved for the requested thread', async () => {
        writerMethods.forceCloseCodexThreadWriters.mockResolvedValue([{
            pid: 32992,
            processName: 'codex.exe',
            appPid: 26668,
            appName: 'Codex Desktop',
            canForceClose: true,
        }]);
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });

        const result = await handlersFrom(client).get('machine-1:codex-force-close-thread-writer')?.({
            codexThreadId: '01a05792-9d44-7dc0-baec-722d9c508ef8',
        });

        expect(writerMethods.forceCloseCodexThreadWriters).toHaveBeenCalledWith('01a05792-9d44-7dc0-baec-722d9c508ef8');
        expect(result).toEqual({ type: 'success', owners: [expect.objectContaining({ appPid: 26668 })] });
    });

    it('duplicates a Codex thread by rolling back turns after the selected item', async () => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: {
                id: 'thread-forked',
                turns: [
                    { id: 'turn-1', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'one' }] }] },
                    { id: 'turn-2', items: [{ id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'two' }] }] },
                ],
            },
        });
        codexClientMethods.rollbackThread.mockResolvedValue({ thread: { id: 'thread-forked', turns: [] } });
        codexClientMethods.injectItems.mockResolvedValue({});

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-duplicate-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
            cutAfterItemId: 'user-1',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.rollbackThread).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(codexClientMethods.injectItems).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'one' }],
            }],
        });
    });
});
