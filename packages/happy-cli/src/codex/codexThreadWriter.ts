import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import psList from 'ps-list';
import { projectPath } from '@/projectPath';

export type CodexThreadWriterOwner = {
    pid: number;
    processName: string;
    appPid: number;
    appName: string;
    canForceClose: boolean;
};

function lockPath(threadId: string): string {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    return join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
}

function parsePids(value: string): number[] {
    const parsed = JSON.parse(value || '[]') as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter((pid): pid is number => Number.isInteger(pid) && pid > 0);
}

function lockOwnerPids(path: string): number[] {
    if (!existsSync(path)) return [];
    if (process.platform === 'win32') {
        const script = join(projectPath(), 'scripts', 'find-lock-owners.ps1');
        const result = spawn.sync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path,
        ], { encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) return [];
        try {
            return parsePids(result.stdout);
        } catch {
            return [];
        }
    }

    const result = spawn.sync('lsof', ['-t', '--', path], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return result.stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function findCodexThreadWriterOwners(threadId: string): Promise<CodexThreadWriterOwner[]> {
    const ownerPids = lockOwnerPids(lockPath(threadId));
    if (ownerPids.length === 0) return [];

    const processes = await psList();
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const owners = ownerPids.map((pid): CodexThreadWriterOwner => {
        const owner = byPid.get(pid);
        let appPid = pid;
        let appName = owner?.name || 'Codex';
        let canForceClose = /codex/i.test(owner?.name || '');
        let current = owner;

        for (let depth = 0; current && depth < 8; depth += 1) {
            const name = current.name || '';
            const command = current.cmd || '';
            if (/chatgpt(?:\.exe)?$/i.test(name)) {
                appPid = current.pid;
                appName = 'Codex Desktop';
                canForceClose = true;
                break;
            }
            if (/code(?:\.exe)?$/i.test(name)) {
                appPid = current.pid;
                appName = 'Visual Studio Code';
                canForceClose = true;
                break;
            }
            if (/happy-cli|happy\.mjs|dist[\\/]index\.mjs.*codex/i.test(command)) {
                appName = 'Happy Codex session';
                canForceClose = false;
                break;
            }
            current = byPid.get(current.ppid ?? -1);
        }

        return {
            pid,
            processName: owner?.name || 'codex',
            appPid,
            appName,
            canForceClose,
        };
    });

    return [...new Map(owners.map((owner) => [owner.appPid, owner])).values()];
}

export async function forceCloseCodexThreadWriters(threadId: string): Promise<CodexThreadWriterOwner[]> {
    const owners = await findCodexThreadWriterOwners(threadId);
    if (owners.length === 0) {
        throw new Error('The writer lock is active, but its owning process could not be identified safely.');
    }
    const unsafe = owners.find((owner) => !owner.canForceClose);
    if (unsafe) {
        throw new Error(`${unsafe.appName} owns this thread and must be stopped through Happy.`);
    }

    for (const owner of owners) {
        if (process.platform === 'win32') {
            const result = spawn.sync('taskkill', ['/PID', String(owner.appPid), '/T', '/F'], {
                encoding: 'utf8',
                windowsHide: true,
            });
            if (result.status !== 0) {
                throw new Error(`Failed to close ${owner.appName} (PID ${owner.appPid}).`);
            }
        } else {
            process.kill(owner.appPid, 'SIGTERM');
        }
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if ((await findCodexThreadWriterOwners(threadId)).length === 0) return owners;
    }
    throw new Error('The Codex process closed, but the thread writer lock is still active.');
}
