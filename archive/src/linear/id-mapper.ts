import { type LinearClient } from '@linear/sdk';
// Type imports needed for ID mapping and type checking
import {
  type LinearGuid, 
  type LinearFriendlyId,
  type TemporaryFriendlyId,
  type TemporaryGuid,
  createTemporaryGuid,
  createTemporaryFriendlyId,
  asProjectSlugId,
  isLinearFriendlyId,
  isLinearGuid,
} from '@/types/linear-ids';
// Types
import type { 
  ProjectSlugId,
  FriendlyId,
  Guid,
} from '@/types/linear-ids';
// <<< ADDED: Import Serializable types from graph >>>
import type { SerializableIdMappings } from '@/graph/graph';

/**
 * Mapping type for different entity types
 */
export type EntityType = 'project' | 'issue';

/**
 * Interface for a mapping entry
 */
interface MappingEntry {
  linearGuid?: LinearGuid;           // Linear UUID (if synced with Linear)
  temporaryGuid: TemporaryGuid;      // Temporary UUID (always present)
  linearFriendlyId?: LinearFriendlyId; // Linear's native ID (if synced with Linear)
  projectSlugId?: ProjectSlugId;     // Project's slug ID (if available)
  temporaryFriendlyId: TemporaryFriendlyId; // Temporary friendly ID (always present)
  name: string;                     // Name of the entity (for display purposes)
  entityType: EntityType;            // <<< ADDED: Store the type explicitly
}

/**
 * The IdMapper provides a simple abstraction for managing different types of IDs:
 * 
 * - LinearGuid: Linear's UUID (e.g., "12345678-1234-1234-1234-123456789012")
 * - LinearFriendlyId: Linear's friendly ID (e.g., "ABC-123")
 * - TemporaryGuid: Temporary UUID (e.g., "temp-12345678-1234-1234-1234-123456789012")
 * - TemporaryFriendlyId: Temporary friendly ID (e.g., "TMP-123")
 */
export class IdMapper {
  private projectMappings: Map<FriendlyId | Guid | ProjectSlugId, MappingEntry> = new Map(); // Any ID -> Entry
  private issueMappings: Map<FriendlyId | Guid, MappingEntry> = new Map();   // Any ID -> Entry
  
  private projectCounter = 1;
  private issueCounter = 1;
  
  constructor(
    // @ts-ignore - linearClient is intentionally kept for potential future use within methods
    private linearClient: LinearClient, 
    initialMappings: SerializableIdMappings | null = null
  ) {
    if (initialMappings) {
      console.log("[IdMapper] Initializing with provided mappings...");
      this._initializeFromSerializable(initialMappings);
    }
  }
  
  private _initializeFromSerializable(mappings: SerializableIdMappings): void {
    for (const [originalId, mappingData] of Object.entries(mappings)) {
      if (!mappingData || !mappingData.guid || !isLinearGuid(mappingData.guid)) {
          console.warn(`[IdMapper] Skipping invalid initial mapping for key ${originalId}: Missing or invalid GUID.`);
          continue;
      }

      // Determine entity type (heuristic based on friendly ID format)
      let entityType: EntityType | null = null;
      if (mappingData.friendlyId && isLinearFriendlyId(mappingData.friendlyId)) {
          entityType = 'issue';
      } else {
          // Assume project if no friendly ID or if originalId looks like a project slug/UUID?
          // This check is weak. If friendlyId is null/missing, we should rely on other context
          // or perhaps require the type to be included in SerializableIdMapping.
          // For now, defaulting to project if not clearly an issue.
          entityType = 'project'; 
          // TODO: Improve entity type detection.
          console.log(`[IdMapper] Assuming entity type 'project' for initial mapping key ${originalId}`);
      }

      // If type couldn't be determined (e.g., invalid friendlyId format if that check was stricter)
      // if (!entityType) { ... skip ... }

      // Generate NEW internal temporary IDs for this rehydrated mapping
      const temporaryGuid = createTemporaryGuid();
      const temporaryFriendlyId = createTemporaryFriendlyId(entityType === 'issue' ? this.issueCounter++ : this.projectCounter++);

      const entry: MappingEntry = {
          linearGuid: mappingData.guid, // We know this is valid from the check above
          temporaryGuid: temporaryGuid, 
          linearFriendlyId: mappingData.friendlyId as LinearFriendlyId | undefined, 
          temporaryFriendlyId: temporaryFriendlyId,
          name: mappingData.friendlyId || mappingData.guid, // Use friendlyId or GUID as name placeholder
          entityType: entityType, 
          projectSlugId: undefined, // We don't get this from the serializable format currently
      };
      
      // Add to the correct map
      const targetMap = entityType === 'issue' ? this.issueMappings : this.projectMappings;
      
      // Store mappings ONLY for the resolved Linear IDs and the NEW internal temporary IDs.
      // DO NOT use originalId as a key unless we validate its format.
      if (entry.linearGuid) { 
          targetMap.set(entry.linearGuid, entry); // Key is LinearGuid (valid)
      }
      if (entry.linearFriendlyId) {
          targetMap.set(entry.linearFriendlyId, entry); // Key is LinearFriendlyId (valid)
      }
      targetMap.set(entry.temporaryGuid, entry); // Key is TemporaryGuid (valid)
      targetMap.set(entry.temporaryFriendlyId, entry); // Key is TemporaryFriendlyId (valid)

      // Optionally, if we trust originalId format:
      // if (isLinearFriendlyId(originalId) || isLinearGuid(originalId) || isTemporaryFriendlyId(originalId) || isTemporaryGuid(originalId) || isProjectSlugId(originalId)) {
      //     targetMap.set(originalId as any, entry);
      // } else {
      //     console.warn(`[IdMapper] Initial mapping key ${originalId} has unrecognized format, not using as direct key.`);
      // }

      console.log(`[IdMapper] Initialized mapping for ${entityType}: ${entry.linearFriendlyId || originalId} -> ${entry.linearGuid}`);
    }
  }
  
  /**
   * Register a project or retrieve existing mapping
   * @param name Project name
   * @param linearGuid Optional Linear UUID if already synced
   * @param projectSlugId Optional project slug ID if available
   * @returns Temporary friendly ID for the project
   */
  registerProject(name: string, linearGuid?: LinearGuid, projectSlugId?: string): TemporaryFriendlyId {
    if (linearGuid) {
      for (const [_, entry] of this.projectMappings.entries()) {
        if (entry.linearGuid === linearGuid) {
          return entry.temporaryFriendlyId;
        }
      }
    }
    
    const temporaryFriendlyId = createTemporaryFriendlyId(this.projectCounter++);
    const temporaryGuid = createTemporaryGuid();
    
    const entry: MappingEntry = { 
      temporaryGuid,
      temporaryFriendlyId,
      name,
      entityType: 'project'
    };
    
    if (linearGuid) entry.linearGuid = linearGuid;
    if (projectSlugId) entry.projectSlugId = asProjectSlugId(projectSlugId);
    
    this.projectMappings.set(temporaryGuid, entry);
    this.projectMappings.set(temporaryFriendlyId, entry);
    if (entry.linearGuid) this.projectMappings.set(entry.linearGuid, entry);
    if (entry.projectSlugId) this.projectMappings.set(entry.projectSlugId, entry);
    
    return temporaryFriendlyId;
  }
  
  /**
   * Register an issue or retrieve existing mapping
   * @param name Issue title
   * @param linearGuid Optional Linear UUID if already synced
   * @param linearFriendlyId Optional Linear friendly ID if already synced
   * @returns Temporary friendly ID for the issue
   */
  registerIssue(name: string, linearGuid?: LinearGuid, linearFriendlyId?: LinearFriendlyId): TemporaryFriendlyId {
    if (linearGuid) {
      for (const [_, entry] of this.issueMappings.entries()) {
        if (entry.linearGuid === linearGuid) {
          return entry.temporaryFriendlyId;
        }
      }
    }
    
    const temporaryFriendlyId = createTemporaryFriendlyId(this.issueCounter++);
    const temporaryGuid = createTemporaryGuid();
    
    const entry: MappingEntry = { 
      temporaryGuid,
      temporaryFriendlyId,
      name,
      entityType: 'issue'
    };
    
    if (linearGuid) entry.linearGuid = linearGuid;
    if (linearFriendlyId) entry.linearFriendlyId = linearFriendlyId;
    
    this.issueMappings.set(temporaryGuid, entry);
    this.issueMappings.set(temporaryFriendlyId, entry);
    if (entry.linearGuid) this.issueMappings.set(entry.linearGuid, entry);
    if (entry.linearFriendlyId) this.issueMappings.set(entry.linearFriendlyId, entry);
    
    return temporaryFriendlyId;
  }
  
  /**
   * Update an existing issue mapping with Linear IDs after syncing
   * @param temporaryId Temporary ID (friendly or GUID)
   * @param linearGuid Linear GUID to add
   * @param linearFriendlyId Linear friendly ID to add
   * @returns Whether the update was successful
   */
  updateWithLinearIds(type: EntityType, temporaryId: TemporaryFriendlyId | TemporaryGuid, linearGuid: LinearGuid, linearFriendlyId: LinearFriendlyId): boolean {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(temporaryId);
    if (!entry) {
      return false;
    }
    
    entry.linearGuid = linearGuid;
    entry.linearFriendlyId = linearFriendlyId;
    entry.entityType = type;
    
    mappings.set(linearGuid, entry);
    mappings.set(linearFriendlyId, entry);
    
    return true;
  }
  
  /**
   * Get a friendly ID for an entity (either Linear or Temporary)
   * @param type Type of entity
   * @param id Any ID (can be GUID or friendly ID)
   * @returns The friendly ID or null if not found
   */
  getFriendlyId(type: EntityType, id: FriendlyId | Guid): FriendlyId | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(id);
    if (!entry) {
      return null;
    }
    
    if (entry.linearFriendlyId) {
      return entry.linearFriendlyId;
    }
    
    return entry.temporaryFriendlyId;
  }
  
  /**
   * Get a GUID for an entity (either Linear or Temporary)
   * @param type Type of entity
   * @param id Any ID (can be GUID or friendly ID)
   * @returns The GUID or null if not found
   */
  getGuid(type: EntityType, id: FriendlyId | Guid): Guid | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(id);
    if (!entry) {
      return null;
    }
    
    return entry.linearGuid ?? null;
  }
  
  /**
   * Check if an ID is temporary
   * @param type Type of entity
   * @param id Any ID
   * @returns Whether the ID is temporary or null if not found
   */
  isTemporary(type: EntityType, id: FriendlyId | Guid): boolean | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(id);
    if (!entry) {
      return null;
    }
    
    return !entry.linearGuid && !entry.linearFriendlyId;
  }
  
  /**
   * Get the Linear GUID for an entity if it's known (synced)
   * @param type Type of entity
   * @param id Any ID (can be GUID or friendly ID)
   * @returns The Linear GUID or null if not found or not synced
   */
  getLinearGuid(type: EntityType, id: FriendlyId | Guid): LinearGuid | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    const entry = mappings.get(id);
    return entry?.linearGuid ?? null;
  }
  
  /**
   * Get the Linear friendly ID for an entity if it's known (synced)
   * @param type Type of entity
   * @param id Any ID (can be GUID or friendly ID)
   * @returns The Linear friendly ID or null if not found or not synced
   */
  getLinearFriendlyId(type: EntityType, id: FriendlyId | Guid): LinearFriendlyId | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    const entry = mappings.get(id);
    return entry?.linearFriendlyId ?? null;
  }
  
  /**
   * Get the temporary GUID for an entity
   * @param type Type of entity
   * @param id Any ID
   * @returns The temporary GUID or null if not found
   */
  getTemporaryGuid(type: EntityType, id: FriendlyId | Guid): TemporaryGuid | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(id);
    if (!entry) {
      return null;
    }
    
    return entry.temporaryGuid;
  }
  
  /**
   * Get the temporary friendly ID for an entity
   * @param type Type of entity
   * @param id Any ID
   * @returns The temporary friendly ID or null if not found
   */
  getTemporaryFriendlyId(type: EntityType, id: FriendlyId | Guid): TemporaryFriendlyId | null {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    
    const entry = mappings.get(id);
    if (!entry) {
      return null;
    }
    
    return entry.temporaryFriendlyId;
  }
  
  /**
   * Get the best display ID for an entity
   * @param type Type of entity
   * @param id Any ID
   * @returns The best display ID
   */
  getBestDisplayId(type: EntityType, id: FriendlyId | Guid): string {
    const mappings = type === 'project' ? this.projectMappings : this.issueMappings;
    const entry = mappings.get(id);
    
    if (!entry) {
      return String(id);
    }
    
    if (type === 'project' && entry.projectSlugId) {
      return entry.projectSlugId;
    }
    
    if (entry.linearFriendlyId) {
      return entry.linearFriendlyId;
    }
    
    return entry.temporaryFriendlyId;
  }
  
  /**
   * Clear all mappings
   */
  clear(): void {
    this.projectMappings.clear();
    this.issueMappings.clear();
    this.projectCounter = 1;
    this.issueCounter = 1;
  }
  
  /**
   * Get all known UUIDs (both Linear and temporary)
   * @returns Array of all known UUIDs
   */
  getAllKnownUuids(): Guid[] {
    const uuids: Guid[] = [];
    
    for (const entry of this.projectMappings.values()) {
      if (entry.linearGuid) {
        uuids.push(entry.linearGuid);
      }
      uuids.push(entry.temporaryGuid);
    }
    
    for (const entry of this.issueMappings.values()) {
      if (entry.linearGuid) {
        uuids.push(entry.linearGuid);
      }
      uuids.push(entry.temporaryGuid);
    }
    
    return uuids;
  }
  
  /**
   * Exports the current resolved mappings in a serializable format.
   * Includes only entities that have been successfully mapped to a Linear GUID.
   * Uses the Linear Friendly ID (if available) or the Temporary Friendly ID as the key.
   */
  getSerializableMappings(): SerializableIdMappings {
    const serializable: SerializableIdMappings = {};
    const combinedEntries = [...this.projectMappings.values(), ...this.issueMappings.values()];
    
    const uniqueEntries = new Set<MappingEntry>(combinedEntries);

    for (const entry of uniqueEntries) {
        if (entry.linearGuid) {
            const key = entry.linearFriendlyId || entry.temporaryFriendlyId;
            serializable[key] = {
                guid: entry.linearGuid,
                friendlyId: entry.linearFriendlyId || null,
            };
        }
    }
    return serializable;
  }
} 