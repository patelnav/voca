import { type WorkflowState } from "@linear/sdk";
import { type LinearClient } from '@linear/sdk';
import { 
  type LinearFriendlyId, 
  type LinearGuid, 
  asLinearGuid 
} from '@/types/linear-ids';

// Define the base issue type using Pick to select only the fields we need
export type BaseIssue = {
  id: LinearGuid;
  identifier?: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  status?: string;
  state?: Pick<WorkflowState, 'id' | 'name' | 'color' | 'type'>;
  parent: { id: LinearGuid } | null;
};

export interface IssuesResponse {
  issues: {
    nodes: BaseIssue[];
  };
}

/**
 * Creates a new issue in Linear
 * @param linearClient An initialized Linear client
 * @param projectId The ID of the project to create the issue in (can be LinearFriendlyId, LinearGuid, or string)
 * @param title The title of the issue
 * @param options Optional object containing additional issue properties (description, parentId, stateId, priority, etc.)
 * @returns The created issue
 */
export async function createIssue(
  linearClient: LinearClient,
  projectId: LinearFriendlyId | LinearGuid | string,
  title: string,
  options?: {
    description?: string;
    parentId?: string;
    stateId?: string;
    priority?: number;
    // Add other valid Linear IssueCreateInput fields here
  }
) {
  try {
    // Validate projectId is provided
    if (!projectId) {
      throw new Error('Project ID is required but was not provided');
    }

    // First, get the team ID associated with the project
    const project = await linearClient.project(projectId.toString());
    if (!project) {
      throw new Error(`Project with ID ${projectId} not found`);
    }

    // Get the teams associated with the project
    const teams = await project.teams();
    if (teams.nodes.length === 0) {
      throw new Error(`No team associated with project ${projectId}`);
    }

    const teamId = teams.nodes[0].id;

    // Prepare the payload for the SDK call
    const issueInput = {
      title,
      projectId: projectId.toString(),
      teamId,
      ...(options || {}), // Spread the optional fields
    };

    // Create the issue using the combined input
    const response = await linearClient.createIssue(issueInput);

    if (!response.success) {
      // Consider logging response.error or providing more details
      throw new Error(`Failed to create issue. Response success: ${response.success}`);
    }

    return response.issue;
  } catch (error) {
    console.error('Error creating issue:', error);
    throw error; // Let errors bubble up
  }
}

/**
 * Fetches active issues for a specific project
 * @param linearClient An initialized Linear client
 * @param projectId The ID of the project to fetch issues for
 * @returns Array of issues
 */
export async function fetchProjectIssues(linearClient: LinearClient, projectId: LinearGuid): Promise<BaseIssue[]> {
  try {
    console.log(`[DEBUG] fetchProjectIssues - Starting to fetch issues for project ID: ${projectId}`);
    
    // Use raw GraphQL query to ensure we get all the fields we need
    console.log(`[DEBUG] Executing GraphQL query with project ID: ${projectId}`);
    const result = await linearClient.client.rawRequest<IssuesResponse, { projectId: string }>(
      `
      query ProjectIssues($projectId: ID!) {
        issues(filter: { project: { id: { eq: $projectId } } }) {
          nodes {
            id
            identifier
            title
            description
            createdAt
            updatedAt
            state {
              id
              name
              color
              type
            }
            parent {
              id
            }
          }
        }
      }
      `,
      { projectId }
    );
    
    // Log the raw response structure for debugging
    if (result) {
      console.log(`[DEBUG] GraphQL query completed. Response structure:`, 
        JSON.stringify({
          hasData: !!result.data,
          hasErrors: !!result.errors,
          errorCount: result.errors?.length
        }, null, 2)
      );
      
      if (result.errors && result.errors.length > 0) {
        console.error(`[ERROR] GraphQL errors:`, JSON.stringify(result.errors, null, 2));
      }
    } else {
      console.log(`[DEBUG] GraphQL query returned undefined result`);
    }
    
    if (result.data && 
        typeof result.data === 'object' && 
        result.data !== null &&
        'issues' in result.data && 
        result.data.issues && 
        'nodes' in result.data.issues) {
      
      console.log(`[DEBUG] Issues found: ${result.data.issues.nodes.length}`);
      
      if (result.data.issues.nodes.length > 0) {
        // Log sample issue to verify structure
        const sampleIssue = result.data.issues.nodes[0];
        console.log(`[DEBUG] Sample issue structure:`, 
          JSON.stringify({
            id: sampleIssue.id,
            identifier: sampleIssue.identifier,
            title: sampleIssue.title,
            hasState: !!sampleIssue.state,
            hasParent: !!sampleIssue.parent
          }, null, 2)
        );
      }
      
      return result.data.issues.nodes.map(node => ({
        ...node,
        id: asLinearGuid(node.id),
        parent: node.parent ? { id: asLinearGuid(node.parent.id) } : null
      }));
    }
    
    // Fallback to the standard SDK method if the raw query fails
    console.log(`[DEBUG] Raw query didn't return expected data structure. Falling back to SDK method.`);
    const issuesQuery = await linearClient.issues({
      filter: {
        project: { id: { eq: projectId } },
      },
    });

    console.log(`[DEBUG] SDK query returned ${issuesQuery.nodes.length} issues`);
    
    // Convert the SDK response to our expected format
    return Promise.all(issuesQuery.nodes.map(async node => {
      const state = await node.state;
      const parent = await node.parent;
      return {
        id: asLinearGuid(node.id),
        identifier: node.identifier,
        title: node.title,
        description: node.description,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
        state: state ? {
          id: state.id,
          name: state.name,
          color: state.color,
          type: state.type
        } : undefined,
        parent: parent ? { id: asLinearGuid(parent.id) } : null
      };
    }));
  } catch (error) {
    console.error(`[ERROR] Error fetching issues for project ${projectId}:`, error);
    
    // Log more details about the error
    if (error instanceof Error) {
      console.error(`[ERROR] Error message: ${error.message}`);
      console.error(`[ERROR] Error stack: ${error.stack}`);
    }
    
    // Fallback to the standard SDK method if the raw query fails
    try {
      console.log(`[DEBUG] Attempting second fallback with SDK method after error`);
      const issuesQuery = await linearClient.issues({
        filter: {
          project: { id: { eq: String(projectId) } },
        },
      });
      
      console.log(`[DEBUG] Second fallback returned ${issuesQuery.nodes.length} issues`);
      
      // Convert the SDK response to our expected format
      return Promise.all(issuesQuery.nodes.map(async node => {
        const state = await node.state;
        const parent = await node.parent;
        return {
          id: asLinearGuid(node.id),
          identifier: node.identifier,
          title: node.title,
          description: node.description,
          createdAt: node.createdAt.toISOString(),
          updatedAt: node.updatedAt.toISOString(),
          state: state ? {
            id: state.id,
            name: state.name,
            color: state.color,
            type: state.type
          } : undefined,
          parent: parent ? { id: asLinearGuid(parent.id) } : null
        };
      }));
    } catch (fallbackError) {
      console.error('[ERROR] Fallback also failed:', fallbackError);
      throw error; // Throw the original error
    }
  }
}

/**
 * Sets an issue as a parent of another issue
 * @param linearClient An initialized Linear client
 * @param childIssueId The ID of the child issue (must be a valid Linear ID)
 * @param parentIssueId The ID of the parent issue (must be a valid Linear ID)
 * @returns The updated child issue
 */
export async function setParentIssue(
  linearClient: LinearClient,
  childIssueId: LinearGuid,
  parentIssueId: LinearGuid
) {
  try {
    // Validate both issues exist
    const parentIssue = await linearClient.issue(parentIssueId);
    if (!parentIssue) {
      throw new Error(`Parent issue with ID ${parentIssueId} not found`);
    }

    const childIssue = await linearClient.issue(childIssueId);
    if (!childIssue) {
      throw new Error(`Child issue with ID ${childIssueId} not found`);
    }

    // Update the child issue with the parent ID
    const updateResponse = await childIssue.update({
      parentId: parentIssueId,
    });

    if (!updateResponse.success) {
      throw new Error('Failed to update parent-child relationship');
    }

    return updateResponse.issue;
  } catch (error) {
    console.error('Error setting parent-child relationship:', error);
    throw error;
  }
}

/**
 * Removes a parent-child relationship between issues
 * @param linearClient An initialized Linear client
 * @param childIssueId The ID of the child issue
 * @returns The updated child issue with no parent
 */
export async function removeParentIssue(linearClient: LinearClient, childIssueId: LinearGuid) {
  try {
    const childIssue = await linearClient.issue(childIssueId);
    if (!childIssue) {
      throw new Error(`Child issue with ID ${childIssueId} not found`);
    }

    // Set parentId to null to remove the relationship
    const updateResponse = await childIssue.update({
      parentId: null,
    });

    if (!updateResponse.success) {
      throw new Error('Failed to remove parent-child relationship');
    }

    return updateResponse.issue;
  } catch (error) {
    console.error('Error removing parent-child relationship:', error);
    throw error;
  }
}

/**
 * Fetches child issues for a specific parent issue
 * @param linearClient An initialized Linear client
 * @param parentIssueId The ID of the parent issue
 * @returns Array of child issues
 */
export async function fetchChildIssues(linearClient: LinearClient, parentIssueId: LinearGuid) {
  try {
    // Use raw GraphQL query to ensure we get all the fields we need
    const result = await linearClient.client.rawRequest<IssuesResponse, { parentId: string }>(
      `
      query ChildIssues($parentId: ID!) {
        issues(filter: { parent: { id: { eq: $parentId } } }) {
          nodes {
            id
            identifier
            title
            description
            createdAt
            updatedAt
            state {
              id
              name
              color
              type
            }
            parent {
              id
            }
          }
        }
      }
      `,
      { parentId: parentIssueId }
    );
    
    if (result.data && 
        typeof result.data === 'object' && 
        result.data !== null &&
        'issues' in result.data && 
        result.data.issues && 
        'nodes' in result.data.issues) {
      
      return result.data.issues.nodes;
    }
    
    // Fallback to the standard SDK method if the raw query fails
    const issuesQuery = await linearClient.issues({
      filter: {
        parent: { id: { eq: parentIssueId } },
      },
    });

    return issuesQuery.nodes;
  } catch (error) {
    console.error(`Error fetching child issues for parent ${parentIssueId}:`, error);
    throw error;
  }
}
