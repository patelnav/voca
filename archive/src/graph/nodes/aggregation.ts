import type { AgentState } from '../state';
import type { FocusOptions } from '../../linear/focus-manager';
import type { NodeDependencies } from '../types';

/**
 * Node: executeAggregateQueryNode
 * Handles 'fetch_details' intents with 'count' action.
 * Fetches issues based on focus and filters, then returns the count.
 */
export async function executeAggregateQueryNode(
    state: AgentState,
    dependencies: Pick<NodeDependencies, 'focusManager' | 'linearClient'>
): Promise<Partial<AgentState>> {
    const { isFocused, focusedProjectId, focusedProjectName, fetchFilters } = state;
    const { focusManager /*, linearClient*/ } = dependencies;

    console.log(`[Node: executeAggregateQuery] Handling count query. Focused: ${isFocused}, Filters: ${JSON.stringify(fetchFilters)}`);

    if (!isFocused || !focusedProjectId) {
        return { 
            responseToUser: "Please focus on a project first using 'focus <project-id>' to count its issues.", 
            error: null 
        }; 
    }

    try {
        // TODO: Implement filter application logic if fetchFilters exist
        // For now, just gets all focused issues and counts them.
        const focusOptions: FocusOptions = { 
            forceRefresh: false, // No need to force refresh just for count
            // Pass filters to FocusManager if implemented there later
        }; 
        
        console.log(`[Node: executeAggregateQuery] Fetching issues for count in project: ${focusedProjectId}`);
        const issues = await focusManager.getFocusedIssues(focusOptions);
        const issueCount = issues?.length ?? 0;

        // TODO: Potentially query Linear API directly for count if more efficient and filters are complex

        const responseToUser = `There are ${issueCount} issues in ${focusedProjectName || 'the focused project'}${fetchFilters ? ' matching the specified criteria' : ''}.`;
        
        console.log(`[Node: executeAggregateQuery] Counted ${issueCount} issues.`);
        return { 
            displayData: issueCount, // Store the count for potential future use
            responseToUser, 
            error: null 
        };

    } catch (err: any) {
        const errorMessage = `Error in executeAggregateQueryNode: ${err.message}`;
        console.error(errorMessage, err);
        return { error: errorMessage };
    }
}

// Placeholder for potential future summary action
// export async function executeSummaryQueryNode(...) {} 