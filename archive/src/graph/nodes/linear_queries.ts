import { type VocaAgentStateType } from '@/graph/graph';
import { type LinearClient } from '@linear/sdk';
import { type NodeDependencies } from '@/graph/types';
import { type FocusManager } from '@/linear/focus-manager';
import { fetchProjects } from '../../linear/projects';
import { type BaseMessage } from '@langchain/core/messages';
import type { FocusOptions } from '../../linear/focus-manager';

// Placeholder for actual formatting function - replace with real implementation
const displayHierarchicalIssues = (issues: any[]): string => JSON.stringify(issues, null, 2);
const formatProjectsForDisplay = (projects: any[]): string => JSON.stringify(projects, null, 2);
// const formatHistoryForDisplay = (history: any[]): string => JSON.stringify(history, null, 2); // <<< Removed, unused

// <<< ADDED: Formatter for BaseMessage array >>>
const formatMessagesForDisplay = (messages: BaseMessage[]): string => {
    return messages.map((msg, i) => {
        const type = msg._getType();
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return `${i + 1}. [${type}]: ${content}`;
    }).join('\n');
};

// --- Placeholder: Linear Client Search Functionality --- 
// Assume LinearClient has a method like this, or we need a wrapper
interface SearchableLinearClient extends LinearClient {
    // Define the method signature more accurately if possible
    searchEntities(query: string, options?: { projectId?: string }): Promise<Array<{ id: string; title: string; identifier: string; project?: { id: string; name: string; }; }>>; // Example return type
    // Add other potential search methods if the original nodes.ts used them implicitly
}
// --- End Placeholder --- 

/**
 * Node: fetchContextAndDisplayNode
 * Fetches and formats data for 'issues', 'projects', 'history'.
 */
export async function fetchContextAndDisplayNode(
    state: VocaAgentStateType,
    dependencies: Pick<NodeDependencies, 'focusManager' | 'linearClient'>
): Promise<Partial<VocaAgentStateType>> {
    const { intent, isFocused, focusedProjectId, activeEntityType, fetchAction, messages } = state;
    const { focusManager, linearClient } = dependencies;

    console.log(`[Node: fetchContextAndDisplay] Handling intent: ${intent}, Type: ${activeEntityType}, Action: ${fetchAction}, Focused: ${isFocused}`);

    try {
        let displayData: any = null;
        let responseToUser: string = "";

        // This node should primarily handle LIST actions based on state
        // The router should have already directed based on intent and fetchAction
        if (intent === 'fetch_details' && fetchAction === 'list') {
            if (activeEntityType === 'issue') {
                if (!isFocused || !focusedProjectId) {
                    responseToUser = "Please focus on a project first using 'focus <project-id>' to list its issues.";
                    return { displayData: null, responseToUser, error: null };
                } else {
                    console.log(`[Node: fetchContextAndDisplay] Fetching issues for project: ${focusedProjectId}`);
                    // TODO: Apply fetchFilters from state if they exist
                    const focusOptions: FocusOptions = { 
                        forceRefresh: true, 
                        // Pass filters here later: statuses: state.fetchFilters?.state, etc.
                    }; 
                    const issues = await focusManager.getFocusedIssues(focusOptions);
                    displayData = issues; // Store the raw list
                    responseToUser = `Issues in ${state.focusedProjectName || 'focused project'}:\\n${displayHierarchicalIssues(issues)}`;
                    console.log(`[Node: fetchContextAndDisplay] Fetched ${issues?.length ?? 0} issues.`);
                }
            } else if (activeEntityType === 'project') {
                console.log("[Node: fetchContextAndDisplay] Fetching projects...");
                 // TODO: Apply fetchFilters from state if they exist
                const projects = await fetchProjects(linearClient /*, filters: state.fetchFilters */);
                displayData = projects;
                responseToUser = `Available Projects:\\n${formatProjectsForDisplay(projects)}`;
                console.log(`[Node: fetchContextAndDisplay] Fetched ${projects.length} projects.`);
            } else if (state.userInput.trim().toLowerCase() === 'history') { // Special case: Check original input ONLY for history
                console.log("[Node: fetchContextAndDisplay] Fetching history...");
                let historyData: BaseMessage[] = []; // Use BaseMessage type
                let formattedHistory: string = "";

                if (messages && messages.length > 0) {
                    console.log("[Node: fetchContextAndDisplay] Using history from state.messages.");
                    historyData = messages;
                    formattedHistory = formatMessagesForDisplay(messages);
                } else {
                    console.log("[Node: fetchContextAndDisplay] No history found in state.messages.");
                    historyData = [];
                    formattedHistory = "(No history available)";
                }
                displayData = historyData;
                responseToUser = `Command History:\\n${formattedHistory}`;
                console.log(`[Node: fetchContextAndDisplay] Fetched ${historyData.length} history entries.`);
            } else {
                // Intent was fetch_details and action was list, but no valid entityType or history command found
                const errorMessage = `Error in fetchContextAndDisplayNode: Cannot list - missing specific entity type (issue/project) or 'history' command. State: ${JSON.stringify({ activeEntityType, fetchAction, userInput: state.userInput })}`;
                console.warn(errorMessage);
                return { error: errorMessage, responseToUser: "Sorry, I'm not sure what you want to list. Please specify 'issues', 'projects', or 'history'." };
            }
        } else {
            // This node was called with an unexpected intent/action combination
            const errorMessage = `Error in fetchContextAndDisplayNode: Called with unexpected state. Expected intent 'fetch_details' and fetchAction 'list'. Received: ${JSON.stringify({ intent, fetchAction, activeEntityType })}`;
            console.error(errorMessage);
            // Return error but maybe a generic response to user
            return { error: errorMessage, responseToUser: "Sorry, I encountered an internal error processing that request." }; 
        }

        // Return successful results
        return { displayData, responseToUser, error: null };

    } catch (err: any) {
        const errorMessage = `Error in fetchContextAndDisplayNode for intent '${intent}': ${err.message}`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
}


/**
 * Node: searchLinearNode
 * Searches Linear for entities (issues, projects) based on the query.
 * Uses focus information if available.
 */
export async function searchLinearNode(
    state: VocaAgentStateType,
    dependencies: { linearClient: SearchableLinearClient; focusManager: FocusManager } // Use Searchable type
): Promise<Partial<VocaAgentStateType>> {
    const { searchQuery, isFocused, focusedProjectId } = state;
    // Cast linearClient from NodeDependencies if necessary, or adjust dependencies structure
    const { linearClient /*, focusManager*/ } = dependencies; 

    if (!searchQuery) {
        return { searchResults: [], responseToUser: "No search query provided." , error: "Missing search query" };
    }

    console.log(`[Node: searchLinear] Searching for: "${searchQuery}", Focused: ${isFocused}, ProjectId: ${focusedProjectId}`);
    const lowerSearchQuery = searchQuery.trim().toLowerCase();

    try {
        let searchResults: Array<{ id: string; name: string; type: 'project' | 'issue' }> = [];

        // --- Handle specific query types --- 
        if (lowerSearchQuery === 'projects') {
            console.log("[Node: searchLinear] Detected 'projects' query, fetching project list.");
            const projects = await linearClient.projects(); // Fetch all projects
            searchResults = projects.nodes.map(proj => ({
                id: proj.id,
                name: proj.name,
                type: 'project' as const
            }));
        } else {
             // --- Default: Search issues ---
            const projectFilter = isFocused && focusedProjectId ? { project: { id: { eq: focusedProjectId } } } : {};

            // --- MODIFIED: Search title OR description --- 
            console.log(`[Node: searchLinear] Searching issues with title OR description containing '${searchQuery}'. Filter:`, projectFilter);
            const issues = await linearClient.issues({
                filter: {
                    ...projectFilter,
                    or: [
                        { title: { containsIgnoreCase: searchQuery } },
                        { description: { containsIgnoreCase: searchQuery } }
                    ]
                    // Removed the simple title filter
                    // title: { containsIgnoreCase: searchQuery }
                },
                first: 10 // Limit results
            });
            // --- END MODIFICATION ---

            // Map issue results
            searchResults = issues.nodes.map(issue => ({
                id: issue.id,
                name: `${issue.identifier}: ${issue.title}`,
                type: 'issue' as const
            }));
            
            // Optionally add project search here too for general queries if desired
        }

        console.log(`[Node: searchLinear] Raw results count: ${searchResults.length}`);
        return {
            searchResults,
            error: null,
            responseToUser: '' // Clear response, router will handle display/clarification
        };

    } catch (error: any) {
        const errorMessage = `Error in searchLinearNode: ${error.message}`;
        console.error(errorMessage, error);
        return {
            searchResults: [],
            error: errorMessage,
            responseToUser: "Sorry, I encountered an error during the search."
        };
    }
}

/**
 * Node: fetchDetailsNode (Phase 2)
 * Fetches detailed information for a specific Linear entity (issue or project).
 * <<< MODIFIED: Also fetches related entity context if `relatedEntityId` is present. >>>
 */
export async function fetchDetailsNode(
    state: VocaAgentStateType,
    dependencies: { linearClient: LinearClient } // Use base LinearClient type
): Promise<Partial<VocaAgentStateType>> {
    // Remove relatedEntityId from destructuring
    const { activeEntityId, activeEntityType } = state; 
    const { linearClient } = dependencies;

    let primaryContext: any = null;
    // let relatedContext: any = null; // Remove related context variable
    let finalContextString: string | null = null;
    let errorMsg: string | null = null;

    // --- Fetch Primary Entity --- 
    if (activeEntityId && activeEntityType) {
        console.log(`[Node: fetchDetails] Fetching primary details for ${activeEntityType} ID: ${activeEntityId}`);
        try {
            if (activeEntityType === 'issue') {
                primaryContext = await linearClient.issue(activeEntityId);
            } else if (activeEntityType === 'project') {
                primaryContext = await linearClient.project(activeEntityId);
            }
            if (!primaryContext) throw new Error(`Primary ${activeEntityType} not found.`);
            console.log(`[Node: fetchDetails] Successfully fetched primary context for ${activeEntityId}.`);
        } catch (err: any) {
            errorMsg = `Error fetching primary entity ${activeEntityType} ${activeEntityId}: ${err.message}`;
            console.error(errorMsg, err);
        }
    } else {
        console.warn("[Node: fetchDetails] Missing activeEntityId or activeEntityType for primary fetch.");
        errorMsg = "Missing entity ID or type to fetch details."; // Set error if primary info is missing
    }

    // --- Remove Related Entity Fetch Logic --- 
    /*
    if (relatedEntityId && !errorMsg) { // Only fetch if primary fetch succeeded (or wasn't needed) and related ID exists
        console.log(`[Node: fetchDetails] Fetching related entity details for ID: ${relatedEntityId}`);
        try {
            // Attempt to fetch as issue first (most common case for parent/child)
            // TODO: Infer related entity type more robustly if possible
            let potentialIssue = null;
            try {
                potentialIssue = await linearClient.issue(relatedEntityId);
            } catch (issueErr: any) {
                if (!issueErr.message?.includes('not found')) { // Re-throw unexpected errors
                    throw issueErr;
                }
                 console.log(`[Node: fetchDetails] Related ID ${relatedEntityId} not found as issue, trying project...`);
            }

            if (potentialIssue) {
                relatedContext = potentialIssue;
            } else {
                // If not found as issue, try fetching as project
                const potentialProject = await linearClient.project(relatedEntityId);
                 if (!potentialProject) throw new Error(`Related entity ${relatedEntityId} not found as issue or project.`);
                relatedContext = potentialProject;
            }
            console.log(`[Node: fetchDetails] Successfully fetched related context for ${relatedEntityId}.`);
        } catch (err: any) {
            errorMsg = `Error fetching related entity ${relatedEntityId}: ${err.message}`;
            console.error(errorMsg, err);
        }
    }
    */

    // --- Prepare Final Context --- 
    if (!errorMsg && primaryContext) {
        // Combine contexts if both fetched successfully (Removed related context logic)
        // const combinedContext = { primary: primaryContext, related: relatedContext };
        // finalContextString = JSON.stringify(combinedContext);
        finalContextString = JSON.stringify({ primary: primaryContext }); // Only include primary
        console.log("[Node: fetchDetails] Final context prepared.");
    } else if (!errorMsg && !primaryContext) {
        // This case should be handled by the initial check, but defensively:
        errorMsg = "No primary entity context could be fetched.";
        console.warn("[Node: fetchDetails] No primary context fetched and no error previously set.")
    }

    // --- Return State --- 
    if (errorMsg) {
        return { error: errorMsg, linearContext: null };
    } else {
        return { linearContext: finalContextString, error: null };
    }
}

// Node to execute aggregate queries (e.g., count issues)
export async function executeAggregateQueryNode(
    state: VocaAgentStateType, // Already correct?
    dependencies: Pick<NodeDependencies, 'focusManager' | 'linearClient'>
): Promise<Partial<VocaAgentStateType>> { // Already correct?
    const { activeEntityType, fetchAction, isFocused, focusedProjectId, focusedProjectName } = state;
    const { linearClient } = dependencies;

    if (!isFocused || !focusedProjectId) {
        return { error: "Cannot execute aggregate query: No project is focused.", responseToUser: "Please focus on a project first." };
    }

    let count: number = 0;
    let responseToUser: string = "";
    let errorMsg: string | null = null;

    console.log(`[Node: executeAggregateQuery] Action: ${fetchAction}, Type: ${activeEntityType}, Project: ${focusedProjectId}`);

    try {
        if (activeEntityType === 'issue' && fetchAction === 'count') {
            // --- Reverted Issue Count Logic (using nodes.length) ---
            console.log(`[Node: executeAggregateQuery] Fetching all issues for count in project: ${focusedProjectId}`);
            // Re-introduce the 'filter' key nesting
            const issues = await linearClient.issues({
                filter: { // Correct nesting
                    project: { id: { eq: focusedProjectId } } // Correct key and structure
                }
                // Removed first: 1, fetch all matching nodes
            });
            // --- End Reverted Issue Count Logic ---

            // Use nodes.length for the count
            count = issues.nodes.length;
            responseToUser = `There are ${count} issues in the focused project (${focusedProjectName || focusedProjectId}).`;
            console.log(`[Node: executeAggregateQuery] Counted ${count} issues.`);
        } else if (activeEntityType === 'project' && fetchAction === 'count') {
            // Project count remains the same: fetch all and use length
            console.log("[Node: executeAggregateQuery] Fetching all projects to count...");
            const projects = await linearClient.projects(); // Fetch all
            count = projects.nodes.length;
            responseToUser = `There are ${count} projects in the workspace.`;
            console.log(`[Node: executeAggregateQuery] Counted ${count} projects.`);
        } else {
            errorMsg = `Unsupported aggregate query: Action '${fetchAction}' for type '${activeEntityType}'`;
            console.warn(`[Node: executeAggregateQuery] ${errorMsg}`);
            responseToUser = "Sorry, I can only count 'issues' within the focused project or all 'projects'.";
        }
    } catch (err: any) {
        errorMsg = `Error executing aggregate query for ${activeEntityType}: ${err.message}`;
        console.error(errorMsg, err);
        responseToUser = "Sorry, I encountered an error while trying to count.";
    }

    return {
        displayData: count, // Store count in displayData
        responseToUser,
        error: errorMsg,
    };
} 