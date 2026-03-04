import { getLinearClient } from '../linear/client';
import { AgentState, TeamWorkflowContext } from '../state/types'; // May need state for context like focus
import { Project,  Issue, LinearDocument } from '@linear/sdk'; // Import necessary entity types
import type { LinearGuid } from '@/types/linear-ids'; // Import LinearGuid
import { type FunctionDeclaration, Type } from '@google/genai';

// Attempt to use types from LinearDocument if not top-level
type IssueFilter = LinearDocument.IssueFilter;

// Define the output structure for linear_search and linear_get_details
export interface LinearReadToolOutput {
  toolOutput: string;
  updatedIdMap?: Record<string, LinearGuid>;
  updatedTeamWorkflows?: Record<string, TeamWorkflowContext>; // Added for linear_get_details later
  updatedIssueTeamMap?: Record<LinearGuid, LinearGuid>;     // Added for linear_get_details later
}

// --- New Structured Return Type for linear_search ---
export enum SearchOutcome {
  FOUND_RESULTS = 'FOUND_RESULTS',
  NO_RESULTS = 'NO_RESULTS',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
}

// Define a union type for possible search results
// For now, linear_search only returns Issues, but this could be expanded.
type SearchResultEntity = Issue;

export interface LinearSearchResult {
  success: boolean;
  outcome: SearchOutcome;
  results: readonly SearchResultEntity[]; // Return the actual array of found entities (readonly)
  updatedIdMap?: Record<string, LinearGuid>; // Keep the ID map update
  message?: string; // For errors
}
// --- End New Structured Return Type ---

// --- New Structured Return Type for linear_get_details ---
export enum DetailsOutcome {
  FOUND_DETAILS = 'FOUND_DETAILS',
  NOT_FOUND = 'NOT_FOUND',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
  // Could add more specific errors, e.g., ERROR_INVALID_ID
}

// Union type for the entity whose details were fetched
// For now, only Issue and Project seem fully supported, add others if needed
type DetailedEntity = Issue | Project;

export interface LinearDetailsResult {
  success: boolean;
  outcome: DetailsOutcome;
  entity?: DetailedEntity; // The actual fetched entity object
  updatedIdMap?: Record<string, LinearGuid>;
  updatedTeamWorkflows?: Record<string, TeamWorkflowContext>;
  updatedIssueTeamMap?: Record<LinearGuid, LinearGuid>;
  message?: string; // For errors
}
// --- End New Structured Return Type ---

/**
 * Parses a query string to extract structured filters (title, project) and general search terms.
 * @param query The input query string.
 * @returns An object containing parsed filters and the remaining general search term.
 */
function parseQueryFilters(query: string): { title?: string; projectId?: string; generalSearchTerm: string } {
    const filters: { title?: string; projectId?: string; generalSearchTerm: string } = { generalSearchTerm: query };
    let remainingQuery = query;

    const titleMatch = query.match(/title:"([^"]*)"/);
    if (titleMatch) {
        filters.title = titleMatch[1].replace(/^"|"$/g, '');
        remainingQuery = remainingQuery.replace(titleMatch[0], '').trim();
    }

    const projectMatch = query.match(/project:"([^"]*)"/);
    if (projectMatch) {
        filters.projectId = projectMatch[1].replace(/^"|"$/g, '');
        remainingQuery = remainingQuery.replace(projectMatch[0], '').trim();
    }
    // Add more filter extractions here if needed (e.g., status, assignee)

    filters.generalSearchTerm = remainingQuery;

    // NEW: If generalSearchTerm is now just a quoted string, unquote it.
    // This handles cases where the LLM provides a quoted search term without a specific "title:" prefix,
    // but after other filters (like project:) are removed, it's clearly meant to be the main search phrase.
    if (filters.generalSearchTerm.startsWith("\"") && filters.generalSearchTerm.endsWith("\"")) {
        const potentialUnquotedTerm = filters.generalSearchTerm.substring(1, filters.generalSearchTerm.length - 1);
        // Only unquote if the result is not empty and doesn't contain further internal quotes,
        // to avoid breaking intentionally complex quoted strings (though rare for this field).
        if (potentialUnquotedTerm.length > 0 && !potentialUnquotedTerm.includes("\"")) {
             filters.generalSearchTerm = potentialUnquotedTerm;
        }
    }
    return filters;
}

/**
 * Tool function to search for Linear issues.
 * The query can be a general search term (e.g., "fix login bug") or include
 * specific filters using a structured format:
 *  - `title:"<exact title phrase>"`
 *  - `project:"<project_guid>"`
 *  - Combine general terms with filters, e.g., `high priority title:"Urgent Fix" project:"<guid>"`
 * The tool parses these filters and applies them to the search.
 * If only general terms are provided, it performs a broad search.
 *
 * @param query The search term or structured filter query.
 * @param agentState The current agent state, potentially containing focus information.
 * @returns A formatted string with search results or an error message.
 */
export async function linear_search(query: string, agentState: AgentState): Promise<LinearSearchResult> {
    console.info(`Executing linear_search tool with query: ${query}`); // Use console.info
    const linearClient = getLinearClient(); // Get client instance directly
    if (!linearClient) {
        console.error("LinearClient not initialized."); // Use console.error
        return {
            success: false,
            outcome: SearchOutcome.ERROR_UNKNOWN,
            results: [],
            message: "Linear client is not available.",
        };
    }

    const updatedIdMap: Record<string, LinearGuid> = {};

    try {
        // Determine filters based on agentState.focus if needed
        if (agentState?.focus?.type === 'project' && agentState.focus.id) {
            // Example: Add project filter if focus is set
            console.info(`Applying project focus filter: ${agentState.focus.id}`); // Use console.info
            // This will be handled by the new filter logic if projectId is not explicitly in the query
        }

        const parsedFilters = parseQueryFilters(query);
        let issues: Issue[] = [];
        let totalCount = 0;

        if (parsedFilters.title || parsedFilters.projectId) {
            const filter: IssueFilter = {};
            if (parsedFilters.title) {
                filter.title = { containsIgnoreCase: parsedFilters.title };
            }
            if (parsedFilters.projectId) {
                // Assuming projectId is a GUID. If it could be a name, further resolution is needed.
                filter.project = { id: { eq: parsedFilters.projectId as LinearGuid } };
            }
            // If there's a general search term left, combine it with title or description search
            if (parsedFilters.generalSearchTerm && parsedFilters.generalSearchTerm.trim() !== '') {
                if (parsedFilters.title && parsedFilters.projectId) {
                    // Both specific title and project filters are present.
                    // The generalSearchTerm is often residual query parts (e.g., "search for", "issues with")
                    // and including it can make the structured query too restrictive.
                    // Thus, we ignore it in this specific scenario for a more precise search based on title and project.
                    console.info(`Structured query with specific title and project ID; residual generalSearchTerm "${parsedFilters.generalSearchTerm}" will be ignored for this filter.`);
                } else {
                    // One of (or neither of) title/project is specified via direct filters,
                    // and a generalSearchTerm is present. Apply generalSearchTerm to title OR description.
                    filter.or = [
                        { title: { containsIgnoreCase: parsedFilters.generalSearchTerm } },
                        { description: { containsIgnoreCase: parsedFilters.generalSearchTerm } }
                    ];
                }
            }

            console.info(`Searching with structured filters: ${JSON.stringify(filter)}`);
            const result = await linearClient.issues({ filter });
            issues = result.nodes;
            totalCount = result.nodes.length; // Or result.pageInfo.totalCount if available and needed
        } else {
            // Fallback to general search if no specific filters are parsed
            console.info(`Searching with general term: ${parsedFilters.generalSearchTerm}`);
            const searchResults = await linearClient.searchIssues(parsedFilters.generalSearchTerm);
            // searchResults.nodes are IssueSearchResult[], need to fetch full Issue for consistency
            // This part needs careful handling to ensure 'issues' contains full 'Issue' objects
            if (searchResults && searchResults.nodes.length > 0) {
                 const fullIssuesPromises = searchResults.nodes.map(node => linearClient.issue(node.id));
                 issues = await Promise.all(fullIssuesPromises);
                 totalCount = issues.length;
            } else {
                 issues = [];
                 totalCount = 0;
            }
        }

        if (totalCount === 0) {
            return {
                success: true,
                outcome: SearchOutcome.NO_RESULTS,
                results: [],
                updatedIdMap: Object.keys(updatedIdMap).length > 0 ? updatedIdMap : undefined,
            };
        }

        console.info(`linear_search completed successfully. Found ${totalCount} issues.`); // Use console.info

        // Update id_map in agentState
        if (issues.length > 0) {
            const sessionId = agentState.sessionId || 'unknown_session'; // Fallback for logging if sessionId is not on agentState
            issues.forEach((issue: Issue) => { // Changed from IssueSearchResult to Issue
                if (issue.id && issue.identifier) { // issue.id is GUID, issue.identifier is friendly ID
                    updatedIdMap[issue.identifier] = issue.id as LinearGuid;
                    updatedIdMap[issue.id] = issue.id as LinearGuid; // Map GUID to itself for consistency
                    console.log(`[${sessionId}] Staging id_map update via linear_search for ${issue.identifier}: ${issue.id}`);
                }
            });
        }

        return {
            success: true,
            outcome: SearchOutcome.FOUND_RESULTS,
            results: issues, // Return the raw issue objects
            updatedIdMap: Object.keys(updatedIdMap).length > 0 ? updatedIdMap : undefined
        };

    } catch (error: any) {
        console.error(`Error executing linear_search: ${error.message}`, error); // Use console.error, pass error object
        return {
            success: false,
            outcome: SearchOutcome.ERROR_UNKNOWN,
            results: [],
            message: `An error occurred while searching Linear: ${error.message}`,
        };
    }
}

/**
 * Tool function to get details for a specific Linear entity (Issue or Project).
 * @param entityId The identifier of the entity (e.g., "PRO-123", "project-guid").
 * @returns A structured result with entity details or an error message.
 */
export async function linear_get_details(entityId: string, agentState: AgentState): Promise<LinearDetailsResult> {
    console.info(`Executing linear_get_details tool with entityId: ${entityId}`); // Use console.info
    const linearClient = getLinearClient();
    if (!linearClient) {
        console.error("LinearClient not initialized.");
        return {
            success: false,
            outcome: DetailsOutcome.ERROR_UNKNOWN,
            message: "Linear client is not available.",
        };
    }

    // Initialize local maps for collecting updates
    const updatedIdMap: Record<string, LinearGuid> = {};
    const updatedTeamWorkflows: Record<string, TeamWorkflowContext> = {};
    const updatedIssueTeamMap: Record<LinearGuid, LinearGuid> = {};

    try {
        const isIssueIdentifier = /^[a-zA-Z]+-\d+$/.test(entityId);
        const isGuid = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(entityId);

        if (isIssueIdentifier) {
            console.info(`Fetching details for Issue by identifier: ${entityId}`);
            const searchResult = await linearClient.searchIssues(entityId, { first: 1 });
            const issueNode = searchResult.nodes[0];

            if (!issueNode) {
                return {
                    success: false,
                    outcome: DetailsOutcome.NOT_FOUND,
                    message: `Issue with identifier "${entityId}" not found.`,
                };
            }
            const issue = await linearClient.issue(issueNode.id);

            if (!issue) {
                 return {
                     success: false,
                     outcome: DetailsOutcome.ERROR_UNKNOWN,
                     message: `Could not fully retrieve issue details for identifier "${entityId}" (GUID: ${issueNode.id}).`,
                 };
            }
            // Fetch related data and context
            const team = await issue.team;
            if (team && team.id ) {
                updatedIssueTeamMap[issue.id as LinearGuid] = team.id as LinearGuid;
                if (!agentState.team_workflows[team.id]) {
                    try {
                       const workflowStates = await linearClient.workflowStates({ filter: { team: { id: { eq: team.id } } } });
                       if (workflowStates.nodes) {
                           updatedTeamWorkflows[team.id] = { name: team.name, states: workflowStates.nodes.map(s => ({ id: s.id as LinearGuid, name: s.name })) };
                       }
                    } catch (wfError: any) {
                       console.error(`Failed to fetch workflow states for team ${team.id}:`, wfError);
                    }
                }
            }
            if (issue.id && issue.identifier) {
               updatedIdMap[issue.identifier] = issue.id as LinearGuid;
               updatedIdMap[issue.id] = issue.id as LinearGuid;
            }

            // Return successful issue result
            return {
               success: true,
               outcome: DetailsOutcome.FOUND_DETAILS,
               entity: issue, // Return the full issue object
               updatedIdMap: Object.keys(updatedIdMap).length > 0 ? updatedIdMap : undefined,
               updatedTeamWorkflows: Object.keys(updatedTeamWorkflows).length > 0 ? updatedTeamWorkflows : undefined,
               updatedIssueTeamMap: Object.keys(updatedIssueTeamMap).length > 0 ? updatedIssueTeamMap : undefined,
            };

        } else if (isGuid) {
            console.info(`Attempting to fetch details for GUID: ${entityId}`);
            let project: Project | undefined;
            try {
                project = await linearClient.project(entityId as LinearGuid);
            } catch (e) {
                console.warn(`Failed to fetch project by GUID ${entityId}, attempting issue fetch...`);
            }
            
            if (project) {
                console.info(`Fetched Project by GUID: ${entityId}`);
                // Fetch related project data (less context than issues)
                if (project.id && project.slugId) { // Projects use slugId as identifier
                    updatedIdMap[project.slugId] = project.id as LinearGuid;
                    updatedIdMap[project.id] = project.id as LinearGuid;
                }

                // Return successful project result
                return {
                   success: true,
                   outcome: DetailsOutcome.FOUND_DETAILS,
                   entity: project, // Return the full project object
                   updatedIdMap: Object.keys(updatedIdMap).length > 0 ? updatedIdMap : undefined,
                   // No team/issue context updates for projects
                   updatedTeamWorkflows: undefined,
                   updatedIssueTeamMap: undefined,
                };
            }

            // If project fetch failed or wasn't found, try fetching as an Issue GUID
            console.info(`GUID ${entityId} not found as Project, attempting fetch as Issue GUID...`);
            try {
                const issue = await linearClient.issue(entityId as LinearGuid); // Fetch issue by GUID
                if (issue) {
                   console.info(`Fetched Issue by GUID: ${entityId}`);
                   // Replicate fetching related data & context updates for the issue
                   const team = await issue.team;
                   if (team && team.id) {
                      updatedIssueTeamMap[issue.id as LinearGuid] = team.id as LinearGuid;
                      if (!agentState.team_workflows[team.id]) {
                          try {
                              const workflowStates = await linearClient.workflowStates({ filter: { team: { id: { eq: team.id } } } });
                              if (workflowStates.nodes) {
                                  updatedTeamWorkflows[team.id] = { name: team.name, states: workflowStates.nodes.map(s => ({ id: s.id as LinearGuid, name: s.name })) };
                              }
                          } catch (wfError: any) {
                              console.error(`Failed to fetch workflow states for team ${team.id}:`, wfError);
                          }
                      }
                   }
                   if (issue.id && issue.identifier) {
                      updatedIdMap[issue.identifier] = issue.id as LinearGuid;
                      updatedIdMap[issue.id] = issue.id as LinearGuid;
                   }

                   // Return successful issue result (fetched by GUID)
                   return {
                      success: true,
                      outcome: DetailsOutcome.FOUND_DETAILS,
                      entity: issue,
                      updatedIdMap: Object.keys(updatedIdMap).length > 0 ? updatedIdMap : undefined,
                      updatedTeamWorkflows: Object.keys(updatedTeamWorkflows).length > 0 ? updatedTeamWorkflows : undefined,
                      updatedIssueTeamMap: Object.keys(updatedIssueTeamMap).length > 0 ? updatedIssueTeamMap : undefined,
                   };
                }
                // If linearClient.issue(GUID) resolves but returns null/undefined somehow
                 console.warn(`Fetch for Issue GUID ${entityId} succeeded but returned no entity.`);
             } catch (e: any) {
                 // Issue fetch by GUID failed
                 console.warn(`Failed to fetch issue by GUID ${entityId}: ${e.message}`);
             }

            // If neither project nor issue fetch succeeded by GUID
            return {
               success: false,
               outcome: DetailsOutcome.NOT_FOUND,
               message: `Could not find Project or Issue with GUID "${entityId}".`,
           };

        } else {
            // ID is not an issue identifier and not a GUID
            return {
               success: false,
               outcome: DetailsOutcome.ERROR_UNKNOWN, // Or a more specific ERROR_INVALID_ID_FORMAT
               message: `Provided ID "${entityId}" is not a valid Linear issue identifier (e.g., TEAM-123) or GUID.`,
           };
        }
    } catch (error: any) {
        console.error(`Error executing linear_get_details for ${entityId}: ${error.message}`, error);
        return {
            success: false,
            outcome: DetailsOutcome.ERROR_UNKNOWN,
            message: `An error occurred while fetching details for ${entityId}: ${error.message}`,
        };
    }
}

// --- Tool Schema for linear_search ---
export const linearSearchToolSchema: FunctionDeclaration = {
  name: 'linear_search',
  description: 'Searches for Linear issues using a query string. Returns matching issues and updates the agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search term or structured filter query.'
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Let me look up those issues for you.'",
        nullable: true,
      },
    },
    required: ['query']
  }
};
// --- End Tool Schema for linear_search ---

// --- Tool Schema for linear_get_details ---
export const linearGetDetailsToolSchema: FunctionDeclaration = {
  name: 'linear_get_details',
  description: 'Fetches details for a specific Linear entity (Issue or Project) by ID or identifier.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      entityId: {
        type: Type.STRING,
        description: 'The identifier of the entity (e.g., PRO-123, project-guid).'
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Fetching details for that ticket now.'",
        nullable: true,
      },
    },
    required: ['entityId']
  }
};
// --- End Tool Schema for linear_get_details ---

// Implementation for linear_get_details will go here later. 