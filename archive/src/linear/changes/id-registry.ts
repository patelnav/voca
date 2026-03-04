import type {
    LinearFriendlyId,
    LinearGuid,
    TemporaryFriendlyId,
    FriendlyId,
    Guid
} from '@/types/linear-ids';
import { asTemporaryFriendlyId, isTemporaryFriendlyId } from '@/types/linear-ids';
import type { StagedChange } from './types';

// Define the structure for an entry in the ID registry
interface IdRegistryEntry {
    internalId: TemporaryFriendlyId;
    linearId?: LinearFriendlyId;
    linearUuid?: LinearGuid;
    status: 'pending' | 'created' | 'updated' | 'deleted';
}

export class IdRegistry {
    private registry: Map<FriendlyId | Guid, IdRegistryEntry> = new Map();

    /**
     * Clear the entire registry
     */
    clear(): void {
        this.registry.clear();
    }

    /**
     * Register an internal ID in the registry
     * @param internalId The internal ID to register
     */
    registerInternalId(internalId: TemporaryFriendlyId): void {
        if (!this.registry.has(internalId)) {
            this.registry.set(internalId, {
                internalId,
                status: 'pending'
            });
        }
    }

    /**
     * Update registry when an issue is created in Linear
     * @param internalId The internal friendly ID (e.g., "TMP-5")
     * @param linearId The Linear native ID (e.g., "NP-343")
     * @param linearUuid The Linear UUID
     */
    updateWithLinearId(internalId: TemporaryFriendlyId, linearId: LinearFriendlyId, linearUuid: LinearGuid): void {
        const entry = this.registry.get(internalId);
        if (entry) {
            entry.linearId = linearId;
            entry.linearUuid = linearUuid;
            entry.status = 'created';
            this.registry.set(internalId, entry);
            
            // Create reverse lookups for both linearId and linearUuid
            this.registry.set(linearId, entry);
            this.registry.set(linearUuid, entry);
        }
    }

    /**
     * Get the best ID for reference (preferring Linear IDs)
     * @param id Any ID
     * @returns The best ID to use for reference
     */
    getBestIdForReference(id: FriendlyId | Guid): FriendlyId | Guid {
        const entry = this.registry.get(id);
        if (!entry) {
            return id;
        }

        // Prefer Linear friendly ID if available
        if (entry.linearId) {
            return entry.linearId;
        }

        // Fall back to internal ID
        return entry.internalId;
    }

    /**
     * Get the current state of the ID registry
     * @returns Object containing all ID mappings
     */
    getIdRegistry(): Record<string, IdRegistryEntry> {
        const result: Record<string, any> = {};
        
        for (const [id, entry] of this.registry.entries()) {
            // Only include the primary key (internalId, linearId, or linearUuid) in the output
            if (id === entry.internalId || id === entry.linearId || id === entry.linearUuid) {
                result[id] = entry;
            }
        }
        
        return result;
    }

    /**
     * Check if an ID is registered
     * @param id Any ID
     * @returns Whether the ID is registered
     */
    isIdRegistered(id: FriendlyId | Guid): boolean {
        return this.registry.has(id);
    }

    /**
     * Update the status of a registered ID
     * @param id Any ID
     * @param status New status
     * @returns Whether the update was successful
     */
    updateIdStatus(id: FriendlyId | Guid, status: 'pending' | 'created' | 'updated' | 'deleted'): boolean {
        const entry = this.registry.get(id);
        if (!entry) {
            return false;
        }

        entry.status = status;
        // Update all associated keys if they exist
        this.registry.set(entry.internalId, entry);
        if (entry.linearId) this.registry.set(entry.linearId, entry);
        if (entry.linearUuid) this.registry.set(entry.linearUuid, entry);

        return true;
    }

    /**
     * Register a project's internal ID
     * @param internalId The internal ID to register
     */
    registerProjectInternalId(internalId: TemporaryFriendlyId): void {
        // Same logic as registering a general internal ID
        this.registerInternalId(internalId);
    }

    /**
     * Update registry when a project is created in Linear
     * @param internalId The internal friendly ID (e.g., "TMP-5")
     * @param linearId The Linear project name or friendly ID
     * @param linearUuid The Linear UUID
     */
    updateWithLinearProjectId(internalId: TemporaryFriendlyId, linearId: LinearFriendlyId, linearUuid: LinearGuid): void {
        // Same logic as updating with a general linear ID
        this.updateWithLinearId(internalId, linearId, linearUuid);
    }

    /**
     * Extracts the temporary or internal ID from a change, generating one if necessary.
     * @param change The change to extract from
     * @param idGenerator Function to generate a new ID suffix (e.g., `TMP-${counter++}`)
     * @returns The internal ID if present or generated, null otherwise
     */
    extractInternalIdFromChange(
        change: StagedChange,
        idGenerator: () => string // Function to generate the suffix part
    ): TemporaryFriendlyId | null {
        // Extract from payload if exists and valid
        const internalId = change.payload?.internalId;
        if (internalId && typeof internalId === 'string') {
            if (isTemporaryFriendlyId(internalId)) {
                console.log(`Found existing internal ID in change: ${internalId}`);
                // Ensure it's registered even if found
                this.registerInternalId(internalId);
                return internalId;
            }
        }
        
        // If not found or invalid, generate one based on the entity type
        if (change.entityType === 'issue' || change.entityType === 'project') {
            // Use the provided generator for the unique part
            const newInternalId = asTemporaryFriendlyId(idGenerator());
            this.registerInternalId(newInternalId);
            console.log(`Generated new internal ID ${newInternalId} for ${change.entityType} change ${change.id}`);
            // Inject the new ID back into the payload for consistency
            change.payload.internalId = newInternalId;
            return newInternalId;
        }
        
        // Return null if no internal ID is applicable or could be generated
        return null;
    }
} 