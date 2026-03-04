import { type LinearClient, type LinearRawResponse } from '@linear/sdk';
import { 
  type LinearFriendlyId, 
  type LinearGuid, 
  asLinearGuid 
} from '../types/linear-ids';

interface ProjectsData {
  projects: {
    nodes: Array<{
      id: string;
      name: string;
      slugId: string;
      description?: string;
      state?: {
        name: string;
        color?: string;
        type?: string;
      };
      createdAt?: string;
      updatedAt?: string;
      lead?: unknown;
      teams?: unknown;
    }>;
  };
}

/**
 * Fetches all projects from Linear
 * @param linearClient An initialized Linear client
 * @param activeOnly If true, only returns active projects
 * @returns Array of Linear projects
 */
export async function fetchProjects(linearClient: LinearClient, _activeOnly: boolean = true) {
  try {
    // Use raw GraphQL query to ensure we get all the fields we need
    const result = await linearClient.client.rawRequest<LinearRawResponse<ProjectsData>, Record<string, never>>(
      `
      query Projects {
        projects {
          nodes {
            id
            name
            slugId
          }
        }
      }
      `,
      {}
    );
    
    if (result.data?.data?.projects?.nodes) {
      return result.data.data.projects.nodes;
    }
    
    // Fallback to the standard SDK method if the raw query fails
    const projects = await linearClient.projects();
    return projects.nodes;
  } catch (error) {
    console.error('Error fetching projects:', error);
    throw error;
  }
}

/**
 * Fetches a project by ID from Linear
 * @param linearClient An initialized Linear client
 * @param projectId The project ID (GUID)
 * @returns The project if found, null otherwise
 */
export async function fetchProjectById(linearClient: LinearClient, projectId: LinearGuid) {
  try {
    return await linearClient.project(projectId);
  } catch (error) {
    console.error(`Error fetching project ${projectId}:`, error);
    return null;
  }
}

/**
 * Creates a new project in Linear (for testing)
 * @param linearClient An initialized Linear client
 * @param name Project name
 * @param description Project description
 * @returns The created project
 */
export async function createProject(linearClient: LinearClient, name: string, description: string) {
  try {
    const teamId = await getDefaultTeamId(linearClient);
    if (!teamId) {
      throw new Error('No team available to create project');
    }

    console.log(`Creating project "${name}" with teamId: ${teamId}`);

    const response = await linearClient.createProject({
      name,
      description,
      teamIds: [teamId],
    });

    console.log(`Project creation response:`, JSON.stringify(response, null, 2));

    if (!response.success) {
      throw new Error('Failed to create project');
    }

    console.log(`Created project successfully:`, JSON.stringify(response.project, null, 2));

    return response.project;
  } catch (error) {
    console.error('Error creating project:', error);
    throw error;
  }
}

/**
 * Gets the ID of the first available team (helper function)
 * @param linearClient An initialized Linear client
 * @returns The ID of the first team or null if none exists
 */
async function getDefaultTeamId(linearClient: LinearClient): Promise<LinearGuid | null> {
  const teams = await linearClient.teams();
  if (teams.nodes.length === 0) {
    return null;
  }
  return asLinearGuid(teams.nodes[0].id);
}

/**
 * Returns the full structure of a project with its key fields
 * This is useful for understanding the project data structure
 * @param linearClient An initialized Linear client
 * @returns Detailed project information for the first project
 */
export async function inspectProjectStructure(linearClient: LinearClient) {
  try {
    const projects = await fetchProjects(linearClient, false);

    if (projects.length === 0) {
      return null;
    }

    // Get the first project to inspect
    const project = projects[0];

    // Return important fields from the project
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      state: project.state,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      // Use optional chaining and type assertion for potentially missing properties
      lead: (project as any).lead,
      teams: (project as any).teams,
      // Add additional fields as needed
    };
  } catch (error) {
    console.error('Error inspecting project structure:', error);
    throw error;
  }
}

/**
 * Archives a project in Linear
 * @param linearClient An initialized Linear client
 * @param projectId The ID of the project to archive
 * @param archiveIssues Whether to also archive all issues in the project
 * @returns The archived project
 */
export async function archiveProject(
  linearClient: LinearClient,
  projectId: LinearFriendlyId,
  archiveIssues: boolean = true
) {
  try {
    const project = await linearClient.project(projectId);
    if (!project) {
      throw new Error(`Project with ID ${projectId} not found`);
    }

    // If requested, first archive all issues in the project
    if (archiveIssues) {
      // Fetch issues in the project
      const issues = await linearClient.issues({
        filter: {
          project: { id: { eq: projectId } },
        },
      });

      // Archive each issue
      for (const issue of issues.nodes) {
        try {
          await issue.archive();
          console.log(`Archived issue ${issue.id}`);
        } catch (error) {
          console.warn(`Failed to archive issue ${issue.id}:`, error);
        }
      }
    }

    // Now archive the project
    const archivedProject = await project.archive();
    return archivedProject;
  } catch (error) {
    console.error(`Error archiving project ${projectId}:`, error);
    throw error;
  }
}

/**
 * Finds an existing project by name
 * @param linearClient An initialized Linear client
 * @param name The name of the project to find
 * @returns The found project or null if not found
 */
export async function findProjectByName(linearClient: LinearClient, name: string) {
  try {
    const projects = await linearClient.projects({
      filter: {
        name: { eqIgnoreCase: name },
      },
    });

    if (projects.nodes.length === 0) {
      return null;
    }

    return projects.nodes[0];
  } catch (error) {
    console.error(`Error finding project by name "${name}":`, error);
    throw error;
  }
}

/**
 * Gets an existing test project or creates a new one if none exists
 * @param linearClient An initialized Linear client
 * @param testProjectName The name for the test project
 * @returns The test project
 */
export async function getOrCreateTestProject(
  linearClient: LinearClient,
  testProjectName: string = 'Voca Test Project'
) {
  try {
    console.log(`Looking for existing test project: ${testProjectName}`);

    // Try to find an existing project first
    const existingProject = await findProjectByName(linearClient, testProjectName);

    if (existingProject) {
      console.log(`Found existing test project with ID: ${existingProject.id}`);
      return existingProject;
    }

    // If no existing project found, create a new one
    console.log('No existing test project found. Creating a new one...');
    const newProject = await createProject(
      linearClient,
      testProjectName,
      'A test project for Voca-Linear integration'
    );

    if (!newProject) {
      throw new Error('Failed to create new test project');
    }

    console.log(`Created new test project with ID: ${newProject.id}`);
    return newProject;
  } catch (error) {
    console.error('Error getting or creating test project:', error);
    throw error;
  }
}
