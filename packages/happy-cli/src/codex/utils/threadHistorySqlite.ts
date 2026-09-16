import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ThreadItem, ThreadTurn } from '../codexAppServerTypes';

type TurnRow = {
    id: string;
    status: string;
    errorJson: string | null;
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
};

type ItemRow = { turnId: string; itemJson: string };

export type CodexThreadHistorySnapshot = {
    name?: string;
    turns: ThreadTurn[];
};

export type ReadRecentCodexThreadHistoryOptions = {
    threadId: string;
    turnLimit: number;
    /** Exposed for tests and non-default Codex installations. */
    codexHomeDir?: string;
};

function latestStateDatabase(codexHomeDir: string): string | null {
    try {
        return readdirSync(codexHomeDir)
            .filter((name) => /^state_\d+\.sqlite$/.test(name))
            .map((name) => {
                const path = join(codexHomeDir, name);
                return { path, modifiedAt: statSync(path).mtimeMs };
            })
            .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.path ?? null;
    } catch {
        return null;
    }
}

function parseThreadItem(value: string): ThreadItem | null {
    try {
        const item: unknown = JSON.parse(value);
        return item
            && typeof item === 'object'
            && typeof (item as { id?: unknown }).id === 'string'
            && typeof (item as { type?: unknown }).type === 'string'
            ? item as ThreadItem
            : null;
    } catch {
        return null;
    }
}

function parseError(value: string | null): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

type RolloutRecord = {
    ordinal?: number;
    type?: string;
    payload?: Record<string, unknown>;
};

type RolloutTurn = {
    id: string;
    ordinal: number;
    items: ThreadItem[];
    itemIds: Set<string>;
    status: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
};

function textFromContent(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''))
        .join('');
}

function strings(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function rolloutItemToThreadItem(value: unknown): ThreadItem | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id || typeof item.type !== 'string') return null;

    switch (item.type) {
        case 'UserMessage':
            return {
                type: 'userMessage', id,
                content: Array.isArray(item.content)
                    ? item.content.map((part) => ({
                        type: 'text' as const,
                        text: part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                            ? (part as { text: string }).text
                            : '',
                    })).filter((part) => part.text.length > 0)
                    : [],
            };
        case 'AgentMessage':
            return {
                type: 'agentMessage', id,
                text: typeof item.text === 'string' ? item.text : textFromContent(item.content),
                phase: typeof item.phase === 'string' ? item.phase : null,
            };
        case 'Reasoning':
            return {
                type: 'reasoning', id,
                summary: strings(item.summary) ?? strings(item.summary_text),
                content: strings(item.content) ?? strings(item.raw_content),
            };
        case 'CommandExecution': {
            const command = Array.isArray(item.command)
                ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
                : typeof item.command === 'string' ? item.command : '';
            return {
                type: 'commandExecution', id, command,
                cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
                status: typeof item.status === 'string' ? item.status : undefined,
                aggregatedOutput: typeof item.aggregated_output === 'string'
                    ? item.aggregated_output
                    : typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
                exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
            };
        }
        case 'FileChange':
            return { type: 'fileChange', id, changes: Array.isArray(item.changes) ? item.changes : [], status: typeof item.status === 'string' ? item.status : undefined };
        default:
            return null;
    }
}

function recentRolloutFiles(codexHomeDir: string, threadId: string, turnLimit: number): string[] {
    const sessionsDir = join(codexHomeDir, 'sessions');
    if (!existsSync(sessionsDir)) return [];
    try {
        const candidates = readdirSync(sessionsDir, { recursive: true })
            .filter((relativePath): relativePath is string => typeof relativePath === 'string'
                && relativePath.includes(threadId)
                && relativePath.endsWith('.jsonl'))
            .map((relativePath) => join(sessionsDir, relativePath))
            .sort();
        const selected: string[] = [];
        let startedTurns = 0;
        for (const path of candidates.reverse()) {
            const content = readFileSync(path, 'utf8');
            selected.push(path);
            startedTurns += content.split('\n').filter((line) => line.includes('"type":"task_started"')).length;
            if (startedTurns >= turnLimit) break;
        }
        return selected.reverse();
    } catch {
        return [];
    }
}

function readRecentRolloutTurns(options: ReadRecentCodexThreadHistoryOptions): ThreadTurn[] | null {
    if (options.turnLimit === 0) return [];
    const codexHomeDir = options.codexHomeDir ?? join(homedir(), '.codex');
    const paths = recentRolloutFiles(codexHomeDir, options.threadId, options.turnLimit);
    if (paths.length === 0) return null;

    const records: RolloutRecord[] = [];
    for (const path of paths) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            try {
                const record = JSON.parse(line) as RolloutRecord;
                if (typeof record.ordinal === 'number') records.push(record);
            } catch {
                // The active rollout can end with a partially-written line.
            }
        }
    }
    records.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

    const turns = new Map<string, RolloutTurn>();
    for (const record of records) {
        const payload = record.payload;
        if (!payload || record.type !== 'event_msg') continue;
        const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
        if (!turnId) continue;
        if (payload.type === 'task_started') {
            turns.set(turnId, {
                id: turnId,
                ordinal: record.ordinal ?? 0,
                items: [], itemIds: new Set(), status: 'inProgress',
                startedAt: typeof payload.started_at === 'number' ? payload.started_at : undefined,
            });
            continue;
        }
        const turn = turns.get(turnId);
        if (!turn) continue;
        if (payload.type === 'item_completed') {
            const item = rolloutItemToThreadItem(payload.item);
            if (item && !turn.itemIds.has(item.id)) {
                turn.items.push(item);
                turn.itemIds.add(item.id);
            }
        } else if (payload.type === 'task_complete') {
            turn.status = 'completed';
            turn.completedAt = typeof payload.completed_at === 'number' ? payload.completed_at : undefined;
            turn.durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined;
        } else if (payload.type === 'turn_aborted') {
            turn.status = 'interrupted';
            turn.completedAt = typeof payload.completed_at === 'number' ? payload.completed_at : undefined;
        }
    }

    const recent = [...turns.values()].sort((a, b) => a.ordinal - b.ordinal).slice(-options.turnLimit);
    return recent.length > 0 ? recent.map(({ itemIds: _itemIds, ordinal: _ordinal, ...turn }) => turn) : null;
}

function readCodexThreadTitle(codexHomeDir: string, threadId: string): string | undefined {
    const statePath = latestStateDatabase(codexHomeDir);
    if (!statePath) return undefined;
    try {
        const stateDb = new Database(statePath, { readonly: true, fileMustExist: true });
        try {
            stateDb.pragma('busy_timeout = 1000');
            const row = stateDb.prepare('SELECT title FROM threads WHERE id = ?').get(threadId) as { title?: unknown } | undefined;
            return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
        } finally {
            stateDb.close();
        }
    } catch {
        return undefined;
    }
}

/**
 * Reads only the window required to render a resumed conversation. Codex's
 * app-server `thread/read(includeTurns: true)` serializes every turn, which
 * is prohibitively expensive for long-lived threads even when Happy needs
 * only the last few turns.
 */
export function readRecentCodexThreadHistory(
    options: ReadRecentCodexThreadHistoryOptions,
): CodexThreadHistorySnapshot | null {
    const codexHomeDir = options.codexHomeDir ?? join(homedir(), '.codex');
    const name = readCodexThreadTitle(codexHomeDir, options.threadId);
    const rolloutTurns = readRecentRolloutTurns(options);
    if (rolloutTurns) return { name, turns: rolloutTurns };
    const historyPath = join(codexHomeDir, 'thread_history_1.sqlite');
    if (!existsSync(historyPath)) return null;

    const db = new Database(historyPath, { readonly: true, fileMustExist: true });
    try {
        db.pragma('busy_timeout = 1000');
        const turnRows = options.turnLimit === 0 ? [] : db.prepare(`
            SELECT turn_id AS id, status, error_json AS errorJson,
                   started_at AS startedAt, completed_at AS completedAt,
                   duration_ms AS durationMs
            FROM thread_turns
            WHERE thread_id = ?
            ORDER BY rollout_ordinal DESC
            LIMIT ?
        `).all(options.threadId, options.turnLimit) as TurnRow[];
        turnRows.reverse();

        const turnIds = turnRows.map((turn) => turn.id);
        const itemsByTurn = new Map<string, ThreadItem[]>();
        if (turnIds.length > 0) {
            const placeholders = turnIds.map(() => '?').join(', ');
            const itemRows = db.prepare(`
                SELECT turn_id AS turnId, item_json AS itemJson
                FROM thread_items
                WHERE thread_id = ? AND turn_id IN (${placeholders})
                ORDER BY rollout_ordinal ASC
            `).all(options.threadId, ...turnIds) as ItemRow[];
            for (const row of itemRows) {
                const item = parseThreadItem(row.itemJson);
                if (!item) continue;
                const items = itemsByTurn.get(row.turnId) ?? [];
                items.push(item);
                itemsByTurn.set(row.turnId, items);
            }
        }

        return {
            name,
            turns: turnRows.map((turn) => ({
                id: turn.id,
                status: turn.status,
                error: parseError(turn.errorJson),
                startedAt: turn.startedAt,
                completedAt: turn.completedAt,
                durationMs: turn.durationMs,
                items: itemsByTurn.get(turn.id) ?? [],
            })),
        };
    } finally {
        db.close();
    }
}
