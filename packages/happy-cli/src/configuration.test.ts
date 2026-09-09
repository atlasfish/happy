import { describe, expect, it } from 'vitest';

import { parseCodexResumeBackfillTurns } from './configuration';

describe('parseCodexResumeBackfillTurns', () => {
    it('reads a valid nested value including zero', () => {
        expect(parseCodexResumeBackfillTurns({ codex: { resumeBackfillTurns: 0 } })).toBe(0);
        expect(parseCodexResumeBackfillTurns({ codex: { resumeBackfillTurns: 12 } })).toBe(12);
    });

    it('falls back to three for malformed or excessive values', () => {
        expect(parseCodexResumeBackfillTurns(null)).toBe(3);
        expect(parseCodexResumeBackfillTurns({ codex: { resumeBackfillTurns: -1 } })).toBe(3);
        expect(parseCodexResumeBackfillTurns({ codex: { resumeBackfillTurns: 51 } })).toBe(3);
        expect(parseCodexResumeBackfillTurns({ codex: { resumeBackfillTurns: '3' } })).toBe(3);
    });
});
