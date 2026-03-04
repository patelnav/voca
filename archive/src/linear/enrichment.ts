import { type LinearClient, type User, type Team, type WorkflowState, type Project, type Issue } from '@linear/sdk';
import { type StagedChange } from '@/state/types';
import { type LinearGuid, type LinearFriendlyId, type TemporaryFriendlyId, isLinearFriendlyId, isLinearGuid } from '@/types/linear-ids';
import { resolveFriendlyIdToGuid } from '@/linear/operations/utils';

/**
 * Placeholder for errors during enrichment
 */
export class EnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

/**
 * Main function to enrich the data payload of a StagedChange.
 * It dispatches to specific enrichment functions based on opType.
 * 
 * @param change The StagedChange object
 * @param client The LinearClient instance
 * @param idMap A map of temporary IDs to resolved Linear GUIDs
 * @returns The enriched data payload with friendly names/temp IDs resolved to GUIDs
 * @throws {EnrichmentError} if required lookups fail
 */
export async function enrichStagedChangeData(
    change: StagedChange,
    client: LinearClient,
    idMap: Map<string, LinearGuid>
): Promise<Record<string, any>> {
    let enrichedData = { ...change.data }; // Start with a copy of the data

    // 1. Resolve temporary ID references within the payload using idMap
    // TODO: Implement temp ID resolution within the payload values
    const TEMP_ID_PREFIX = 'TMP-'; // Define prefix for temp IDs

    function resolveTempIdsInData(data: any): any {
        if (typeof data === 'string') {
            if (data.startsWith(TEMP_ID_PREFIX)) {
                const resolvedId = idMap.get(data);
                if (resolvedId) {
                    console.log(`Resolved temp ID "${data}" to "${resolvedId}" in payload.`);
                    return resolvedId; // Replace temp ID with resolved GUID
                } else {
                    // This temp ID should have been resolved by a previous step
                    // If it's not in the map, something went wrong (dependency failed?)
                    throw new EnrichmentError(`Unresolved temporary ID found in payload: "${data}". Check dependency order or previous step failures.`);
                }
            }
            return data; // Not a temp ID string
        } else if (Array.isArray(data)) {
            // Recursively resolve elements in arrays
            return data.map(resolveTempIdsInData);
        } else if (typeof data === 'object' && data !== null) {
            // Recursively resolve values in objects
            const resolvedObject: Record<string, any> = {};
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    resolvedObject[key] = resolveTempIdsInData(data[key]);
                }
            }
            return resolvedObject;
        }
        // Return non-string, non-array, non-object types as is
        return data;
    }

    console.log('Resolving temporary IDs in data payload...');
    enrichedData = resolveTempIdsInData(enrichedData);
    console.log('Data payload after temp ID resolution:', enrichedData);

    // 2. Dispatch to entity-specific enrichment logic
    const [entityType, operation] = change.opType.split('.'); // Simpler parse
    
    if (entityType === 'issue') {
        if (operation === 'create') {
            enrichedData = await enrichIssueCreateData(enrichedData, client);
        } else if (operation === 'update') {
            enrichedData = await enrichIssueUpdateData(enrichedData, client);
        }
        // Add other issue operations if needed (e.g., link)
    } else if (entityType === 'comment') {
        if (operation === 'create') {
             enrichedData = await enrichCommentCreateData(enrichedData, client);
        }
    } 
    // Add other entity types (project, etc.) as needed
    else if (entityType === 'project') {
        if (operation === 'update') {
            enrichedData = await enrichProjectUpdateData(enrichedData, client);
        }
    }

    // 3. TODO: Potentially add common enrichment logic applicable to multiple types?

    return enrichedData;
}

// --- Issue Enrichment ---

async function enrichIssueCreateData(
    data: Record<string, any>, 
    client: LinearClient
): Promise<Record<string, any>> {
    console.log('Enriching issue create data:', data);
    const enriched = { ...data };

    // If 'team' (friendly name) is provided, make it 'teamName' for consistent resolution
    if (typeof enriched.team === 'string' && typeof enriched.teamName === 'undefined') {
        enriched.teamName = enriched.team;
        delete enriched.team;
    }

    if (typeof enriched.teamName === 'string') { // Always try to resolve teamName if provided
        try {
            console.log(`[enrichIssueCreateData] Resolving teamName: "${enriched.teamName}"`);
            enriched.teamId = await resolveTeamNameToId(enriched.teamName, client);
            console.log(`[enrichIssueCreateData] Resolved teamName "${enriched.teamName}" to teamId: "${enriched.teamId}"`);
            delete enriched.teamName;
        } catch (e) {
            console.error(`[enrichIssueCreateData] Error resolving teamName "${enriched.teamName}":`, e);
            if (e instanceof EnrichmentError) throw e; // Re-throw to be caught by processSingleChange
            throw new EnrichmentError(`Failed during teamName resolution for "${enriched.teamName}": ${e instanceof Error ? e.message : String(e)}`);
        }
    } else if (enriched.teamId && !isLinearGuid(enriched.teamId)) {
        // teamId is present but it's NOT a GUID (e.g., it could be a name like "LIFE")
        const originalTeamIdString = String(enriched.teamId);
        console.warn(`[enrichIssueCreateData] teamId "${originalTeamIdString}" is not a valid GUID. Attempting to resolve as a team name.`);
        try {
            enriched.teamId = await resolveTeamNameToId(originalTeamIdString, client);
            console.log(`[enrichIssueCreateData] Re-resolved invalid teamId "${originalTeamIdString}" to new teamId: "${enriched.teamId}"`);
        } catch (resolveError) {
             console.error(`[enrichIssueCreateData] Failed to re-resolve invalid teamId "${originalTeamIdString}" as a team name:`, resolveError);
             // If re-resolution fails, throw an error. The original non-GUID string is not acceptable.
             throw new EnrichmentError(`Invalid teamId "${originalTeamIdString}" provided, and it could not be resolved as a team name.`);
        }
    } else if (!enriched.teamId) { // No teamName provided, and no teamId provided at all (or was undefined/null)
        console.error('[enrichIssueCreateData] Missing team context: Neither teamName nor a valid teamId was provided or resolved.');
        throw new EnrichmentError('Cannot create issue: A valid teamId or a resolvable teamName is required.');
    }

    // At this point, enriched.teamId MUST be a valid GUID, or an error should have been thrown.
    if (!enriched.teamId || !isLinearGuid(enriched.teamId)) {
        console.error(`[enrichIssueCreateData] Critical: TeamId ("${enriched.teamId}") is still invalid or missing after resolution attempts.`);
        throw new EnrichmentError(`Team context is invalid or missing after all resolution attempts. Current teamId value: "${enriched.teamId}". Cannot proceed with issue creation.`);
    }
    console.log(`[enrichIssueCreateData] Final validated teamId for issue creation: "${enriched.teamId}"`);

    // Treat 'status' field same as 'statusName' for enrichment, if statusName is not already defined
    if (typeof enriched.status === 'string' && typeof enriched.statusName === 'undefined') {
        enriched.statusName = enriched.status;
        delete enriched.status;
    }

    // Resolve statusName -> stateId (Note: SDK expects stateId, not statusId for create)
    if (typeof enriched.statusName === 'string') {
        enriched.stateId = await resolveWorkflowStateNameToId(enriched.statusName, client, enriched.teamId);
        delete enriched.statusName; 
    }
    
    // Treat 'assignee' field same as 'assigneeIdentifier' for enrichment
    if (typeof enriched.assignee === 'string' && typeof enriched.assigneeIdentifier === 'undefined') {
        enriched.assigneeIdentifier = enriched.assignee;
        delete enriched.assignee;
    }

    // Resolve assigneeIdentifier -> assigneeId
    if (typeof enriched.assigneeIdentifier === 'string') { 
        enriched.assigneeId = await resolveUserToId(enriched.assigneeIdentifier, client);
        delete enriched.assigneeIdentifier;
    }

    // Treat 'project' field same as 'projectName' for enrichment
    if (typeof enriched.project === 'string' && typeof enriched.projectName === 'undefined') {
        enriched.projectName = enriched.project;
        delete enriched.project;
    }

    // Resolve projectName -> projectId
    if (typeof enriched.projectName === 'string') { 
        enriched.projectId = await resolveProjectNameToId(enriched.projectName, client);
        delete enriched.projectName;
    }

    // Example: Resolve labelNames -> labelIds
    if (Array.isArray(enriched.labelNames) && enriched.labelNames.length > 0) {
        enriched.labelIds = await resolveLabelNamesToIds(enriched.labelNames, client);
        delete enriched.labelNames;
    }
    
    // Example: Resolve priorityName -> priority
    if (typeof enriched.priorityName === 'string') {
        enriched.priority = resolvePriorityNameToValue(enriched.priorityName);
        delete enriched.priorityName;
    }

    // Resolve cycleName -> cycleId
    if (typeof enriched.cycleName === 'string') {
        enriched.cycleId = await resolveCycleNameToId(enriched.cycleName, client);
        delete enriched.cycleName;
    } else if (enriched.cycleName === null) { // Handle removing from cycle
        enriched.cycleId = null;
        delete enriched.cycleName;
    }

    // Resolve parentId if it's a friendly ID
    if (typeof enriched.parentId === 'string' && isLinearFriendlyId(enriched.parentId)) {
        // Ensure parentId is not already a GUID before resolving
        if (!isLinearGuid(enriched.parentId)) {
            console.log(`Parent ID ${enriched.parentId} looks like a friendly ID, resolving...`);
            enriched.parentId = await resolveFriendlyIdToGuid(client, enriched.parentId, 'issue');
        }
    } else if (enriched.parentId === null) {
        // Explicitly setting parent to null (removing parent)
        enriched.parentId = null;
    } else if (typeof enriched.parentId === 'string' && !isLinearGuid(enriched.parentId)) {
        // It's a string but not a GUID or known friendly ID format - potentially a tempId?
        // TempId resolution should happen *before* enrichment.
        // For now, warn if it reaches here unresolved.
        console.warn(`Parent ID "${enriched.parentId}" is not a recognized GUID or friendly ID. Temp ID resolution might be missing.`);
        // Optionally throw an error, or let the SDK call fail later.
        // throw new EnrichmentError(`Unresolved parent ID: ${enriched.parentId}`);
    }

    console.log('Enriched issue create data:', enriched);
    return enriched;
}

async function enrichIssueUpdateData(
    data: Record<string, any>, 
    client: LinearClient
): Promise<Record<string, any>> {
    console.log('Enriching issue update data:', data);
    const enriched = { ...data };

    // Ensure 'id' exists and is a GUID (should be resolved before enrichment ideally)
    if (!data.id || !isLinearGuid(data.id)) { // Check if it's a valid GUID
        throw new EnrichmentError(`Missing or invalid required Linear GUID "id" for issue update.`);
    }

    // Determine the status value if provided in a recognized format
    let statusValue: string | undefined = undefined;
    if (typeof enriched.statusName === 'string') {
        statusValue = enriched.statusName;
    } else if (typeof enriched.status === 'string') {
        statusValue = enriched.status;
    } else if (typeof enriched.state === 'object' && enriched.state !== null && typeof enriched.state.name === 'string') {
        statusValue = enriched.state.name;
    } else if (typeof enriched.state === 'string') { // Handle { state: "Done" }
        statusValue = enriched.state;
    }

    let teamId = enriched.teamId; // Keep existing teamId if present

    // Logic to determine teamId (only if a statusValue was found and no explicit teamId was part of the enriched data)
    if (typeof enriched.teamName === 'string') {
        teamId = await resolveTeamNameToId(enriched.teamName, client);
        enriched.teamId = teamId; // Update teamId in the payload if resolved (might be used by other enrichments)
        delete enriched.teamName;
        console.log(`[ENRICHMENT-DEBUG] TeamId resolved from teamName: ${teamId}`);
    } else if (!teamId && typeof statusValue === 'string') { // Only try to fetch team if no explicit teamId AND status is being changed
        console.log(`[ENRICHMENT-DEBUG] Attempting to fetch team context for issue ${enriched.id} because status is being changed to "${statusValue}" and no teamId is present.`);
        try {
            const issue = await client.issue(enriched.id);
            if (!issue) {
                console.error(`[ENRICHMENT-DEBUG] Failed to fetch issue ${enriched.id} for team context. Issue not found.`);
            } else {
                const team = await issue.team;
                if (team?.id) {
                    teamId = team.id as LinearGuid;
                    console.log(`[ENRICHMENT-DEBUG] Successfully fetched team context. Using issue's current team ID ${teamId} for status resolution.`);
                } else {
                    console.warn(`[ENRICHMENT-DEBUG] Could not determine team context for issue ${enriched.id}. Team data missing or no team associated. Status resolution will proceed without team filter.`);
                }
            }
        } catch (fetchError: any) {
            console.error(`[ENRICHMENT-DEBUG] Error during fetch of issue ${enriched.id} for team context: ${fetchError.message}`, fetchError);
        }
    } else if (teamId && typeof statusValue === 'string') {
        console.log(`[ENRICHMENT-DEBUG] Using pre-existing teamId: ${teamId} for status resolution of "${statusValue}".`);
    } else if (!statusValue) {
        console.log(`[ENRICHMENT-DEBUG] No status change requested (statusValue is undefined). Skipping team context fetch for status.`);
    }

    // Resolve statusValue -> stateId (Linear API standard field)
    if (typeof statusValue === 'string') {
        enriched.stateId = await resolveWorkflowStateNameToId(statusValue, client, teamId); 
        // Delete the original fields that might have contained the status representation
        delete enriched.statusName; 
        delete enriched.status;     
        delete enriched.state; // Delete the whole state object OR the state string field
        console.log(`[ENRICHMENT-DEBUG] Resolved status "${statusValue}" to stateId: ${enriched.stateId}`);
    }
    
    // Resolve assigneeName/Email -> assigneeId
    if (typeof enriched.assigneeIdentifier === 'string') { 
        enriched.assigneeId = await resolveUserToId(enriched.assigneeIdentifier, client);
        delete enriched.assigneeIdentifier;
    } else if (enriched.assigneeIdentifier === null) { // Handle unassigning
        enriched.assigneeId = null;
         delete enriched.assigneeIdentifier;
    }

    // Resolve labelNames -> labelIds (needs careful handling for add/remove/set semantics if needed)
     if (Array.isArray(enriched.labelNames)) { // Assume 'set' semantics for now
        enriched.labelIds = await resolveLabelNamesToIds(enriched.labelNames, client);
        delete enriched.labelNames;
    }

    // TODO: Add resolution for priorityName -> priority
    // TODO: Resolve parentId if friendly ID provided

    // Resolve priorityName -> priority
    if (typeof enriched.priorityName === 'string') {
        enriched.priority = resolvePriorityNameToValue(enriched.priorityName);
        delete enriched.priorityName;
    } else if (enriched.priorityName === null || enriched.priority === 0) { // Handle setting to "No Priority"
        enriched.priority = 0;
        delete enriched.priorityName;
    }

    // Resolve projectName -> projectId
    if (typeof enriched.projectName === 'string') { 
        enriched.projectId = await resolveProjectNameToId(enriched.projectName, client);
        delete enriched.projectName;
    } else if (enriched.projectName === null) { // Handle removing from project
        enriched.projectId = null; // Assuming SDK accepts null for removal
        delete enriched.projectName;
    }

    // Resolve cycleName -> cycleId
    if (typeof enriched.cycleName === 'string') {
        enriched.cycleId = await resolveCycleNameToId(enriched.cycleName, client);
        delete enriched.cycleName;
    } else if (enriched.cycleName === null) { // Handle removing from cycle
        enriched.cycleId = null;
        delete enriched.cycleName;
    }

    // Resolve parentId if it's a friendly ID
    if (typeof enriched.parentId === 'string' && isLinearFriendlyId(enriched.parentId)) {
         if (!isLinearGuid(enriched.parentId)) {
            console.log(`Parent ID ${enriched.parentId} looks like a friendly ID, resolving...`);
            enriched.parentId = await resolveFriendlyIdToGuid(client, enriched.parentId, 'issue');
         }
    } else if (enriched.parentId === null) {
        enriched.parentId = null;
    } else if (typeof enriched.parentId === 'string' && !isLinearGuid(enriched.parentId)) {
        console.warn(`Parent ID "${enriched.parentId}" is not a recognized GUID or friendly ID. Temp ID resolution might be missing.`);
        // throw new EnrichmentError(`Unresolved parent ID: ${enriched.parentId}`);
    }

    console.log('Enriched issue update data:', enriched);
    return enriched;
}


// --- Comment Enrichment ---

async function enrichCommentCreateData(
    data: Record<string, any>, 
    client: LinearClient
): Promise<Record<string, any>> {
     console.log('Enriching comment create data:', data);
    const enriched = { ...data };

    // Ensure issueId exists and is resolved (should happen via tempId resolution before this)
     if (!enriched.issueId || typeof enriched.issueId !== 'string') { // Add isLinearGuid check later
        throw new EnrichmentError('Missing or invalid required "issueId" for comment create.');
    }
    
    // Comments usually just need the issueId and body, less enrichment needed here typically.

    console.log('Enriched comment create data:', enriched);
    return enriched;
}


// --- Resolver Functions ---

export async function resolveWorkflowStateNameToId(
    name: string, 
    client: LinearClient,
    teamId?: string // Optional team context
): Promise<LinearGuid> {
    console.log(`Resolving workflow state name "${name}"${teamId ? ` within team ${teamId}` : ''} to ID...`);
    try {
        // Build the filter dynamically
        let filter: any = { name: { eqIgnoreCase: name } }; // Use any for now
        if (teamId && isLinearGuid(teamId)) { // Ensure teamId is a valid GUID if provided
            filter = { 
                ...filter,
                team: { id: { eq: teamId } } 
            };
        } else if (teamId) {
            console.warn(`Invalid teamId format provided for status resolution: "${teamId}". Proceeding without team filter.`);
            // Optionally, could throw an error here if team context is strictly required
        }

        const states = await client.workflowStates({ filter });
        if (!states || !states.nodes || states.nodes.length === 0) {
            throw new EnrichmentError(`Workflow state with name "${name}"${teamId ? ` in team ${teamId}` : ''} not found.`);
        }
        if (states.nodes.length > 1) {
            // This should be less likely if teamId is provided and valid
            console.warn(`Multiple workflow states found with name "${name}"${teamId ? ` in team ${teamId}` : ''}. Using the first one found.`);
        }
        const stateId = states.nodes[0].id as LinearGuid;
        console.log(`Resolved workflow state name "${name}" to ID "${stateId}"`);
        return stateId;
    } catch (error) {
        console.error(`Error resolving workflow state name "${name}":`, error);
        if (error instanceof EnrichmentError) throw error;
        throw new EnrichmentError(`Failed to resolve status "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function resolveUserToId(
    identifier: string, // Can be name or email
    client: LinearClient
): Promise<LinearGuid> {
     console.log(`Resolving user identifier "${identifier}"...`);
     try {
         // Try email first, then name, then display name
         let users = await client.users({ filter: { email: { eq: identifier } } });
         if (!users?.nodes || users.nodes.length === 0) {
            users = await client.users({ filter: { name: { eq: identifier } } });
         }
         if (!users?.nodes || users.nodes.length === 0) {
            users = await client.users({ filter: { displayName: { eq: identifier } } });
         }

         if (!users?.nodes || users.nodes.length === 0) {
            // Throw specific error if not found after all attempts
            throw new EnrichmentError(`User with identifier "${identifier}" not found.`);
        }

         if (users.nodes.length > 1) {
            console.warn(`Multiple users found for identifier "${identifier}". Using the first one.`);
        }
        const userId = users.nodes[0].id as LinearGuid;
        console.log(`Resolved user identifier "${identifier}" to ID: ${userId}`);
        return userId;
     } catch (error) {
        console.error(`Error resolving user identifier "${identifier}":`, error);
        // Re-throw EnrichmentErrors directly
        if (error instanceof EnrichmentError) throw error; 
        // Wrap other errors (like network/API errors) in EnrichmentError
        throw new EnrichmentError(`Failed to resolve user "${identifier}": ${error instanceof Error ? error.message : String(error)}`);
     }
}

export async function resolveLabelNamesToIds(
    names: string[], 
    client: LinearClient
): Promise<LinearGuid[]> {
    if (!names || names.length === 0) {
        return [];
    }
    console.log(`Resolving label names: ${names.join(', ')}...`);
    
    try {
        // Optimized: Use 'in' filter for a single query
        const labels = await client.issueLabels({
            filter: { name: { in: names } }
        });

        if (!labels?.nodes || labels.nodes.length === 0) {
            throw new EnrichmentError(`No labels found matching names: ${names.join(', ')}`);
        }

        // Map found labels by name for easy lookup and validation
        const foundLabelsMap = new Map<string, LinearGuid>();
        labels.nodes.forEach(label => {
            // Handle potential name case differences if needed, though 'in' filter is often case-insensitive
            foundLabelsMap.set(label.name, label.id as LinearGuid); 
        });

        // Validate that all requested names were found
        const resolvedIds: LinearGuid[] = [];
        const missingNames: string[] = [];
        for (const name of names) {
            // Find the ID, potentially checking case-insensitively if the map uses original case
            let foundId: LinearGuid | undefined;
            if (foundLabelsMap.has(name)) {
                foundId = foundLabelsMap.get(name);
            } else {
                // Case-insensitive fallback check (might be redundant depending on API filter behavior)
                for (const [key, value] of foundLabelsMap.entries()) {
                    if (key.toLowerCase() === name.toLowerCase()) {
                        foundId = value;
                        break;
                    }
                }
            }
            
            if (foundId) {
                resolvedIds.push(foundId);
            } else {
                missingNames.push(name);
            }
        }

        if (missingNames.length > 0) {
            throw new EnrichmentError(`Label(s) not found: ${missingNames.join(', ')}`);
        }

        console.log(`Resolved label names ${names.join(', ')} to IDs: ${resolvedIds.join(', ')}`);
        return resolvedIds;
    } catch (error) {
        console.error(`Error resolving label names "${names.join(', ')}":`, error);
        // Re-throw EnrichmentErrors directly
        if (error instanceof EnrichmentError) throw error;
        // Wrap other errors (like network/API errors) in EnrichmentError
        throw new EnrichmentError(`Failed to resolve labels "${names.join(', ')}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

// TODO: Add resolvers for:
// - Priority Name -> Priority Number (0-4)
// - Project Name/ID -> Project GUID
// - Team Name/ID -> Team GUID
// - Cycle Name/ID -> Cycle GUID
// - Parent Issue Friendly ID -> Parent Issue GUID (maybe use the existing resolveFriendlyIdToGuid?)

// --- NEW RESOLVERS ---

const PRIORITY_MAP: { [key: string]: number } = {
    'urgent': 4,
    'high': 3,
    'medium': 2,
    'low': 1,
    'none': 0,
    'no priority': 0,
};

export function resolvePriorityNameToValue(name: string): number {
    const lowerCaseName = name.toLowerCase().trim();
    const value = PRIORITY_MAP[lowerCaseName];
    if (value === undefined) {
        throw new EnrichmentError(`Invalid priority name: "${name}". Valid names are: ${Object.keys(PRIORITY_MAP).join(', ')}.`);
    }
    console.log(`Resolved priority name "${name}" to value: ${value}`);
    return value;
}

export async function resolveProjectNameToId(
    identifier: string, // Name or friendly ID like PRO-123
    client: LinearClient
): Promise<LinearGuid> {
    console.log(`Resolving project identifier "${identifier}"...`);
    
    try {
        // TODO: Check if identifier is a friendly ID (PRO-123) and use resolveFriendlyIdToGuid if implemented for projects

        // Try resolving by name first
        const projects = await client.projects({ filter: { name: { eq: identifier } } });

        if (!projects?.nodes || projects.nodes.length === 0) {
             // TODO: Fallback to check if identifier is a GUID? Unlikely needed if handled upstream.
             // TODO: Fallback to checking by friendly ID using resolveFriendlyIdToGuid once it's updated.
             throw new EnrichmentError(`Project with identifier "${identifier}" not found.`);
        }

        if (projects.nodes.length > 1) {
             console.warn(`Multiple projects found for identifier "${identifier}". Using the first one.`);
             // Consider fetching more details or using team context to disambiguate if necessary
        }

        const projectId = projects.nodes[0].id as LinearGuid;
        console.log(`Resolved project identifier "${identifier}" to ID: ${projectId}`);
        return projectId;
    } catch (error) {
        console.error(`Error resolving project identifier "${identifier}":`, error);
        // Re-throw EnrichmentErrors directly
        if (error instanceof EnrichmentError) throw error;
        // Wrap other errors
        throw new EnrichmentError(`Failed to resolve project "${identifier}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Resolves a team name to its Linear GUID.
 * Throws EnrichmentError if the team is not found.
 * 
 * @param name The name of the team
 * @param client LinearClient instance
 * @returns The Linear GUID of the team
 */
export async function resolveTeamNameToId(
    name: string,
    client: LinearClient
): Promise<LinearGuid> {
    console.log(`Resolving team name "${name}" to ID...`);
    try {
        const teams = await client.teams({ filter: { name: { eqIgnoreCase: name } } });
        if (!teams || !teams.nodes || teams.nodes.length === 0) {
            throw new EnrichmentError(`Team with name "${name}" not found.`);
        }
        if (teams.nodes.length > 1) {
            // Handle ambiguity if needed, e.g., require more specific input
            console.warn(`Multiple teams found with name "${name}". Using the first one found.`);
        }
        const teamId = teams.nodes[0].id as LinearGuid;
        console.log(`Resolved team name "${name}" to ID "${teamId}"`);
        return teamId;
    } catch (error) {
        console.error(`Error resolving team name "${name}":`, error);
        if (error instanceof EnrichmentError) throw error;
        throw new EnrichmentError(`Failed to resolve team "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Resolves a cycle name to its Linear GUID.
 * Throws EnrichmentError if the cycle is not found or inactive.
 * 
 * @param name The name of the cycle
 * @param client LinearClient instance
 * @returns The Linear GUID of the cycle
 */
export async function resolveCycleNameToId(
    name: string,
    client: LinearClient
): Promise<LinearGuid> {
    console.log(`Resolving cycle name "${name}" to ID...`);
    try {
        // Fetch active or future cycles matching the name
        const cycles = await client.cycles({
            filter: { 
                name: { eqIgnoreCase: name },
                // Only consider current or planned cycles
                // isPast: { eq: false } // Filter for active/future might need adjustment
            }
        });
        if (!cycles || !cycles.nodes || cycles.nodes.length === 0) {
            throw new EnrichmentError(`Active or future cycle with name "${name}" not found.`);
        }
        if (cycles.nodes.length > 1) {
            // Handle ambiguity - maybe filter by closest start date or require more specifics?
            console.warn(`Multiple active/future cycles found with name "${name}". Using the first one found.`);
            // Potentially sort by startDate and pick the latest non-past one?
        }
        const cycleId = cycles.nodes[0].id as LinearGuid;
        console.log(`Resolved cycle name "${name}" to ID "${cycleId}"`);
        return cycleId;
    } catch (error) {
        console.error(`Error resolving cycle name "${name}":`, error);
        if (error instanceof EnrichmentError) throw error;
        throw new EnrichmentError(`Failed to resolve cycle "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

// TODO: Add resolvers for:
// - Team Name/ID -> Team GUID
// - Cycle Name/ID -> Cycle GUID
// --- END NEW RESOLVERS ---

// --- Project Enrichment ---

/**
 * Enriches data specific to project update operations.
 * Resolves friendly names for state, lead, and members.
 */
async function enrichProjectUpdateData(
   data: Record<string, any>,
   client: LinearClient
): Promise<Record<string, any>> {
   console.log('Enriching project update data:', data);
   const enriched = { ...data };

   // Ensure 'id' exists and is a GUID (should be resolved before enrichment ideally)
   if (!data.id || !isLinearGuid(data.id)) { // Check if it's a valid GUID
       throw new EnrichmentError(`Missing or invalid required Linear GUID "id" for project update.`);
   }

   // Resolve stateName -> state (Project states are strings, not GUIDs)
   if (typeof enriched.stateName === 'string') {
       const validStates = ['planned', 'started', 'paused', 'completed', 'canceled'];
       const lowerCaseState = enriched.stateName.toLowerCase();
       if (validStates.includes(lowerCaseState)) {
           enriched.state = lowerCaseState; // Use the validated, lower-cased state name
           console.log(`Resolved stateName "${enriched.stateName}" to state "${enriched.state}"`);
       } else {
           throw new EnrichmentError(`Invalid project state name: "${enriched.stateName}". Must be one of: ${validStates.join(', ')}`);
       }
       delete enriched.stateName;
   }

   // Resolve leadIdentifier -> leadId
   if (typeof enriched.leadIdentifier === 'string') {
       enriched.leadId = await resolveUserToId(enriched.leadIdentifier, client);
       console.log(`Resolved leadIdentifier "${enriched.leadIdentifier}" to leadId "${enriched.leadId}"`);
       delete enriched.leadIdentifier;
   } else if (enriched.leadIdentifier === null) { // Handle unassigning lead
       enriched.leadId = null;
       console.log('Set leadId to null (unassigned)');
       delete enriched.leadIdentifier;
   }

   // Resolve memberIdentifiers -> memberIds
   if (Array.isArray(enriched.memberIdentifiers)) {
       try {
           const memberIds = await Promise.all(
               enriched.memberIdentifiers.map(async (identifier: any) => {
                   if (typeof identifier !== 'string') {
                       throw new Error(`Invalid member identifier type: ${typeof identifier}`);
                   }
                   const userId = await resolveUserToId(identifier, client);
                   console.log(`Resolved memberIdentifier "${identifier}" to userId "${userId}"`);
                   return userId;
               })
           );
           enriched.memberIds = memberIds;
           console.log(`Resolved memberIdentifiers to memberIds: ${JSON.stringify(memberIds)}`);
       } catch (error) {
            // Catch errors during individual user resolution
            throw new EnrichmentError(`Failed to resolve one or more member identifiers: ${(error as Error).message}`);
       }
       delete enriched.memberIdentifiers;
   } else if (enriched.memberIdentifiers === null) { // Handle removing all members? Check SDK behavior
       // Linear API might require an empty array `[]` to remove all members,
       // or maybe doesn't support removing all at once via `null`.
       // Assuming `[]` is safer for now if the intent is to clear members.
       enriched.memberIds = [];
       console.log('Set memberIds to [] (attempting to remove all members)');
       delete enriched.memberIdentifiers;
   }

   console.log('Enriched project update data:', enriched);
   return enriched;
}

// --- Common Resolvers ---