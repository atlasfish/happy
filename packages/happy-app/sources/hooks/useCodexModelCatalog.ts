import * as React from 'react';
import { getCodexCatalogMetadata } from '@/components/modelModeOptions';
import { codexListModels } from '@/sync/ops';
import type { Metadata, Session } from '@/sync/storageTypes';

export function useCodexModelCatalog(
    machineId: string | null | undefined,
    enabled: boolean,
    sessions: readonly Session[],
): Metadata | null {
    const [liveCatalog, setLiveCatalog] = React.useState<{ machineId: string; metadata: Metadata } | null>(null);

    React.useEffect(() => {
        if (!enabled || !machineId) return;
        let cancelled = false;
        codexListModels(machineId).then((result) => {
            if (!cancelled && result.type === 'success' && result.models.length > 0) {
                setLiveCatalog({ machineId, metadata: { models: result.models } as Metadata });
            }
        });
        return () => { cancelled = true; };
    }, [enabled, machineId]);

    if (!enabled || !machineId) return null;
    return liveCatalog?.machineId === machineId
        ? liveCatalog.metadata
        : getCodexCatalogMetadata(sessions, machineId);
}
