import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
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

        let name: string | undefined;
        const statePath = latestStateDatabase(codexHomeDir);
        if (statePath) {
            try {
                const stateDb = new Database(statePath, { readonly: true, fileMustExist: true });
                try {
                    stateDb.pragma('busy_timeout = 1000');
                    const row = stateDb.prepare('SELECT title FROM threads WHERE id = ?').get(options.threadId) as { title?: unknown } | undefined;
                    name = typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
                } finally {
                    stateDb.close();
                }
            } catch {
                // A transient lock or a state schema upgrade must not block history replay.
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
