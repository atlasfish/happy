import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readRecentCodexThreadHistory } from './threadHistorySqlite';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('readRecentCodexThreadHistory', () => {
    it('reads only the requested recent turns and their ordered items', () => {
        const codexHomeDir = mkdtempSync(join(tmpdir(), 'happy-codex-history-'));
        temporaryDirectories.push(codexHomeDir);
        const history = new Database(join(codexHomeDir, 'thread_history_1.sqlite'));
        history.exec(`
            CREATE TABLE thread_turns (
                thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
                status TEXT, error_json TEXT, started_at INTEGER,
                completed_at INTEGER, duration_ms INTEGER
            );
            CREATE TABLE thread_items (
                thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, item_json TEXT
            );
        `);
        const insertTurn = history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        insertTurn.run('thread-1', 'turn-1', 1, 'completed', null, 10, 11, 1000);
        insertTurn.run('thread-1', 'turn-2', 2, 'completed', null, 20, 21, 1000);
        insertTurn.run('thread-1', 'turn-3', 3, 'failed', '{"message":"failed"}', 30, 31, 1000);
        const insertItem = history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)');
        insertItem.run('thread-1', 'turn-2', 2, JSON.stringify({ type: 'userMessage', id: 'item-2', content: [] }));
        insertItem.run('thread-1', 'turn-3', 3, JSON.stringify({ type: 'agentMessage', id: 'item-3', text: 'done' }));
        history.close();

        const state = new Database(join(codexHomeDir, 'state_5.sqlite'));
        state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
        state.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-1', 'Recovered title');
        state.close();

        expect(readRecentCodexThreadHistory({ threadId: 'thread-1', turnLimit: 2, codexHomeDir })).toEqual({
            name: 'Recovered title',
            turns: [
                {
                    id: 'turn-2', status: 'completed', error: undefined,
                    startedAt: 20, completedAt: 21, durationMs: 1000,
                    items: [{ type: 'userMessage', id: 'item-2', content: [] }],
                },
                {
                    id: 'turn-3', status: 'failed', error: { message: 'failed' },
                    startedAt: 30, completedAt: 31, durationMs: 1000,
                    items: [{ type: 'agentMessage', id: 'item-3', text: 'done' }],
                },
            ],
        });
    });
});
