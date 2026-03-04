import type {
    LinearClient
} from '@linear/sdk';
import type {
    LinearFriendlyId,
    LinearGuid
} from '@/types/linear-ids';
import {
    asLinearGuid,
    asLinearFriendlyId,
    isTemporaryFriendlyId,
    isLinearGuid
} from '@/types/linear-ids';
import type {
    StagedChange,
    ChangeResult
} from './types';
import type { IdMapper } from '@/linear/id-mapper';

export class TemporaryIdMapper {
    private temporaryIdMap: Map<string, LinearGuid | LinearFriendlyId> = new Map();
    private idMapper: IdMapper;
    private focusedProjectId: LinearGuid | null;
    private linearClient: LinearClient; // Needed for resolveReferences template resolution

    constructor(linearClient: LinearClient, idMapper: IdMapper, focusedProjectId: LinearGuid | null) {
        this.linearClient = linearClient;
        this.idMapper = idMapper;
        this.focusedProjectId = focusedProjectId;
    }

    /**
     * Clear the temporary ID map.
     */
    clear(): void {
        this.temporaryIdMap.clear();
    }

    /**
     * Store the mapping between a temporary ID (internal or change-based) and a resolved Linear ID.
     * @param change The change that created the entity
     * @param result The result object containing the Linear ID
     */
    storeIdMapping(change: StagedChange, result: any): void {
        if (!result || !result.id) {
            console.warn(`Cannot store ID mapping for change ${change.id}: result is missing Linear ID`);
            return;
        }

        const linearUuid = asLinearGuid(result.id); // Always store the UUID
        const linearIdentifier: LinearFriendlyId | undefined = result.identifier 
            ? asLinearFriendlyId(result.identifier) 
            : undefined;
        
        console.log(`=== STORING ID MAPPING (in TemporaryIdMapper) ===`);
        console.log(`Change ID: ${change.id}`);
        console.log(`Linear UUID: ${linearUuid}`);
        console.log(`Linear Identifier: ${linearIdentifier || 'N/A'}`);
        console.log(`Entity Type: ${change.entityType}`);
        console.log(`Operation: ${change.operation}`);

        // 1. Map the internalId if available in the payload
        const internalId = change.payload?.internalId; // Expect TemporaryFriendlyId
        if (internalId && typeof internalId === 'string' && isTemporaryFriendlyId(internalId)) {
            this.temporaryIdMap.set(internalId, linearUuid);
            console.log(`MAPPING: ${internalId} -> ${linearUuid}`);
            
            // Also update the main IdMapper if a friendly ID exists
            if (this.idMapper && linearIdentifier) {
                try {
                    this.idMapper.updateWithLinearIds(
                        change.entityType as any, 
                        internalId, 
                        linearUuid, 
                        linearIdentifier
                    );
                    console.log(`Updated main IdMapper: ${internalId} -> ${linearIdentifier} / ${linearUuid}`);
                } catch (e) {
                    console.error(`Error updating main IdMapper for ${internalId}: ${e}`);
                }
            }
        } else {
            console.log(`No valid internalId (TemporaryFriendlyId) found in payload for direct mapping.`);
        }

        // 2. Always store TMPC-<changeId> format for consistent access during resolution
        const changeRefKey = `TMPC-${change.id}`;
        this.temporaryIdMap.set(changeRefKey, linearUuid);
        console.log(`MAPPING: ${changeRefKey} -> ${linearUuid}`);
        
        // 3. Store TMP-<changeId> as well for potential legacy use or flexibility
        const legacyRefKey = `TMP-${change.id}`;
        this.temporaryIdMap.set(legacyRefKey, linearUuid);
        console.log(`MAPPING: ${legacyRefKey} -> ${linearUuid}`);
        
        // 4. For numeric index values from internal IDs (e.g., TMP-5), store TMPC- format
        if (internalId && typeof internalId === 'string') {
            const match = internalId.match(/^TMP-(\d+)$/);
            if (match && match[1]) {
                const alternateKey = `TMPC-${match[1]}`;
                this.temporaryIdMap.set(alternateKey, linearUuid);
                console.log(`MAPPING: ${alternateKey} -> ${linearUuid} (from numeric internalId)`);
            }
        }

        // 5. Register with main ID mapper (redundant if updated via internalId, but safe fallback)
        if (this.idMapper && linearIdentifier) {
            if (change.entityType === 'issue' && change.operation === 'create') {
                this.idMapper.registerIssue(
                    result.title || 'Unnamed Issue',
                    linearUuid,
                    linearIdentifier
                );
                console.log(`Registered issue in main IdMapper: ${linearIdentifier} (${linearUuid})`);
            } else if (change.entityType === 'project' && change.operation === 'create') {
                this.idMapper.registerProject(
                    result.name || 'Unnamed Project',
                    linearUuid,
                    linearIdentifier // Project identifier might not be friendly ID format initially
                );
                console.log(`Registered project in main IdMapper: ${linearIdentifier} (${linearUuid})`);
            }
        }
        
        console.log(`temporaryIdMap now has ${this.temporaryIdMap.size} entries`);
        console.log(`=== ID MAPPING COMPLETE (in TemporaryIdMapper) ===`);
    }

    /**
     * Resolve any temporary IDs (TMP- or TMPC-) in a given string ID.
     * @param id The ID string to resolve
     * @returns The resolved Linear GUID or null if not found/resolved
     */
    private resolveTemporaryId(id: string): LinearGuid | null {
        if (!id || typeof id !== 'string') return null;
        
        // Try direct lookup first
        let resolvedId = this.temporaryIdMap.get(id);
        if (resolvedId) {
            console.log(`Directly resolved ${id} to ${resolvedId}`);
            // Ensure we return a GUID
            return isLinearGuid(resolvedId) ? resolvedId : null; 
        }
        
        console.log(`Could not directly resolve ID ${id}, checking alternatives...`);
        
        // Try trimmed ID
        const trimmedId = id.trim();
        if (trimmedId !== id) {
            resolvedId = this.temporaryIdMap.get(trimmedId);
            if (resolvedId) {
                console.log(`Resolved ID using trimmed ID: ${trimmedId} -> ${resolvedId}`);
                return isLinearGuid(resolvedId) ? resolvedId : null;
            }
        }
        
        // Handle prefix variations (TMP- vs TMPC-)
        if (id.startsWith('TMP-')) {
            const tmpcVersion = id.replace('TMP-', 'TMPC-');
            resolvedId = this.temporaryIdMap.get(tmpcVersion);
            if (resolvedId) {
                console.log(`Resolved TMP- -> TMPC- conversion: ${id} -> ${tmpcVersion} -> ${resolvedId}`);
                return isLinearGuid(resolvedId) ? resolvedId : null;
            }
        } else if (id.startsWith('TMPC-')) {
            const tmpVersion = id.replace('TMPC-', 'TMP-');
            resolvedId = this.temporaryIdMap.get(tmpVersion);
            if (resolvedId) {
                console.log(`Resolved TMPC- -> TMP- conversion: ${id} -> ${tmpVersion} -> ${resolvedId}`);
                return isLinearGuid(resolvedId) ? resolvedId : null;
            }
        }

        // Try suffix matching as a last resort
        const idParts = id.split('-');
        if (idParts.length >= 2) {
            const suffix = idParts.slice(1).join('-');
            for (const [mapKey, mapValue] of this.temporaryIdMap.entries()) {
                if (mapKey.endsWith(`-${suffix}`)) {
                    console.log(`Resolved using suffix match: ${id} -> ${mapKey} -> ${mapValue}`);
                    return isLinearGuid(mapValue) ? mapValue : null;
                }
            }
        }
        
        console.warn(`Failed to resolve temporary ID: ${id}`);
        return null;
    }

    /**
     * Resolve references (temporary IDs and template variables) in a payload object.
     * @param payload The payload object to resolve references in
     * @param processedChanges Map of previously processed changes (changeId -> ChangeResult)
     * @returns The resolved payload object
     */
    async resolveReferences(
        payload: any,
        processedChanges: Map<string, ChangeResult>
    ): Promise<any> {
        console.log('=== RESOLVING REFERENCES (in TemporaryIdMapper) ===');
        console.log(`Input payload: ${JSON.stringify(payload, null, 2)}`);
        console.log(`Processed changes count: ${processedChanges.size}`);
        console.log(`Current temporaryIdMap size: ${this.temporaryIdMap.size}`);
        
        // Deep clone the payload object
        const result = JSON.parse(JSON.stringify(payload));
        
        // Process each key in the payload
        for (const key of Object.keys(result)) {
            const value = result[key];
            console.log(`Processing key: ${key}, value: ${value}`);

            if (typeof value === 'string') {
                // 1. Resolve TMPC-<changeId> references
                if (value.startsWith('TMPC-')) {
                    const resolvedGuid = this.resolveTemporaryId(value);
                    if (resolvedGuid) {
                        result[key] = resolvedGuid;
                        console.log(`Resolved TMPC reference "${value}" to GUID ${resolvedGuid}`);
                    } else {
                        console.warn(`Reference not found or failed to resolve: ${value}`);
                    }
                }
                // 2. Resolve TMP-<internalId> references (like TMP-1, TMP-projA)
                else if (value.startsWith('TMP-')) {
                    const resolvedGuid = this.resolveTemporaryId(value);
                    if (resolvedGuid) {
                        result[key] = resolvedGuid;
                        console.log(`Resolved TMP reference "${value}" to GUID ${resolvedGuid}`);
                    } else {
                         console.warn(`TMP reference not found or failed to resolve: ${value}`);
                         // Check if it's a placeholder like TMP-PROJECT_ID meant for template resolution
                         if (!value.includes('PROJECT_ID') && !value.includes('ISSUE_ID')) {
                             // Only warn if it doesn't look like a template variable
                             console.warn(`Could not resolve temporary ID: ${value}. This might cause issues.`);
                         }
                    }
                }
                // 3. Resolve {{template_variables}}
                else if (value.startsWith('{{') && value.endsWith('}}')) {
                    const variableName = value.substring(2, value.length - 2).toLowerCase();
                    console.log(`Found template variable: ${value}, variable name: ${variableName}`);
                    
                    if (variableName.includes('project')) {
                        if (this.focusedProjectId) {
                            result[key] = this.focusedProjectId;
                            console.log(`Resolved template variable "${value}" to focused project ID: ${this.focusedProjectId}`);
                        } else {
                            console.warn(`Could not resolve template variable: ${value} - no focused project ID available`);
                            // Attempt to find the most recently created project from processed changes
                            let latestProjectId: LinearGuid | null = null;
                            let latestTimestamp = 0;
                            for (const changeResult of processedChanges.values()) {
                                if (changeResult.change.entityType === 'project' && changeResult.success && changeResult.result?.id) {
                                     const timestamp = new Date(changeResult.result.createdAt || 0).getTime();
                                     const projectId = changeResult.result.id; // Assign to variable first
                                     if (timestamp >= latestTimestamp && isLinearGuid(projectId)) {
                                         latestProjectId = projectId; // Use the narrowed variable
                                         latestTimestamp = timestamp;
                                     }
                                }
                            }
                            if(latestProjectId) {
                                result[key] = latestProjectId;
                                console.log(`Resolved template variable "${value}" to latest created project ID: ${latestProjectId}`);
                            } else {
                                console.warn(`Could not resolve template variable: ${value} - no focused or recently created project found.`);
                            }
                        }
                    } 
                    else if (variableName.includes('issue') || variableName.includes('task')) {
                        const searchTerm = variableName.replace(/_issue_id$|_task_id$/, '');
                        console.log(`Looking for issue/task matching "${searchTerm}" for template variable "${value}"`);
                        
                        let matchingIssueId: LinearGuid | null = null;
                        
                        // Prioritize searching the main IdMapper
                        if (this.idMapper) {
                            const allUuids = this.idMapper.getAllKnownUuids();
                            console.log(`Searching ${allUuids.length} known UUIDs in idMapper`);
                            for (const uuid of allUuids) {
                                const friendlyId = this.idMapper.getFriendlyId('issue', uuid);
                                if (friendlyId) {
                                    try {
                                        const issue = await this.linearClient.issue(uuid); // Requires LinearClient
                                        if (issue && issue.title.toLowerCase().includes(searchTerm)) {
                                            matchingIssueId = asLinearGuid(uuid);
                                            console.log(`Found matching issue in IdMapper/Linear: ${issue.title} (${matchingIssueId})`);
                                            break;
                                        }
                                    } catch (error) {
                                        console.warn(`Error fetching issue details for ${uuid} during template resolution: ${error}`);
                                    }
                                }
                            }
                        }

                        // Fallback: Search processed changes if not found via IdMapper
                        if (!matchingIssueId) {
                             console.log(`No match in IdMapper, searching processed changes...`);
                             let bestMatchId: LinearGuid | null = null;
                             let highestRelevance = 0;
                             for (const changeResult of processedChanges.values()) {
                                 if (changeResult.change.entityType === 'issue' && changeResult.success && changeResult.result?.id && isLinearGuid(changeResult.result.id)) {
                                     const title = changeResult.result.title?.toLowerCase() || '';
                                     let relevance = 0;
                                     if (title === searchTerm) relevance = 100;
                                     else if (title.includes(searchTerm)) relevance = 60;
                                     // Add more sophisticated matching if needed

                                     if (relevance > highestRelevance) {
                                         highestRelevance = relevance;
                                         bestMatchId = changeResult.result.id;
                                     }
                                 }
                             }
                             if (bestMatchId) {
                                 matchingIssueId = bestMatchId;
                                 console.log(`Found best matching issue in processed changes: ${matchingIssueId} (relevance ${highestRelevance})`);
                             }
                        }
                        
                        if (matchingIssueId) {
                            result[key] = matchingIssueId;
                            console.log(`Resolved template variable "${value}" to issue ID: ${matchingIssueId}`);
                        } else {
                            console.warn(`Could not find matching issue for template variable: ${value}`);
                        }
                    } else {
                        console.warn(`Unknown template variable format: ${value}`);
                    }
                } 
                // 4. Handle legacy/placeholder Project IDs (less common now with templates)
                 else if (key === 'projectId' && (value === 'PROJECT_ID' || value.includes('_ID') || value.includes('${'))) {
                     console.warn(`Handling legacy placeholder project ID: ${value}`);
                     if (this.focusedProjectId) {
                         result[key] = this.focusedProjectId;
                     } else {
                         // Find latest created project from processedChanges (similar to template logic)
                         let latestProjectId: LinearGuid | null = null;
                         let latestTimestamp = 0;
                         for (const changeResult of processedChanges.values()) {
                            if (changeResult.change.entityType === 'project' && changeResult.success && changeResult.result?.id) {
                                const timestamp = new Date(changeResult.result.createdAt || 0).getTime();
                                const projectId = changeResult.result.id; // Assign to variable first
                                if (timestamp >= latestTimestamp && isLinearGuid(projectId)) {
                                    latestProjectId = projectId; // Use the narrowed variable
                                    latestTimestamp = timestamp;
                                }
                            }
                         }
                         if (latestProjectId) {
                             result[key] = latestProjectId;
                             console.log(`Resolved placeholder project ID "${value}" to ${latestProjectId}`);
                         } else {
                             console.warn(`Could not resolve placeholder project ID: ${value}`);
                         }
                     }
                 }

            } 
            // Recursively process nested objects
            else if (value && typeof value === 'object') {
                console.log(`Processing nested object for key: ${key}`);
                result[key] = await this.resolveReferences(value, processedChanges);
            }
        }

        console.log(`Output payload: ${JSON.stringify(result, null, 2)}`);
        console.log('=== REFERENCE RESOLUTION COMPLETE (in TemporaryIdMapper) ===');
        return result;
    }

    /**
     * Validate that relationship IDs in a payload are valid Linear GUIDs.
     * Assumes IDs have already been resolved by resolveReferences.
     * @param payload The payload containing relationship IDs (parentId, childId)
     * @throws Error if any required ID is missing or not a valid Linear GUID
     */
    validateRelationshipIds(payload: Record<string, any>): void {
        const parentId = payload.parentId;
        const childId = payload.childId;

        if (!parentId || !childId) {
            throw new Error('Both parentId and childId must be provided and resolved for relationship operations');
        }

        if (!isLinearGuid(parentId)) {
            throw new Error(`Invalid or unresolved parent ID format: ${parentId}. Must be a valid Linear GUID after resolution.`);
        }

        if (!isLinearGuid(childId)) {
            throw new Error(`Invalid or unresolved child ID format: ${childId}. Must be a valid Linear GUID after resolution.`);
        }
        console.log(`Relationship IDs validated: Parent=${parentId}, Child=${childId}`);
    }
} 