import { type ILLMClient, type FunctionDeclaration } from '@/api/core/interfaces';
import { GRAPHQL_CONVERTER_PROMPT } from '@/linear/prompts';
import { type LinearGuid } from '@/types/linear-ids';

/**
 * GraphQL mutation structure with metadata
 */
export interface GraphQLMutation {
  mutation: string;
  variables: Record<string, any>;
  result_id?: string;
}

/**
 * Adapter for processing GraphQL mutations using an LLM client
 */
export class GraphQLProcessor {
  private client: ILLMClient;
  private focusedProjectId: LinearGuid | null;
  private focusedProjectName: string;

  /**
   * Create a new GraphQLProcessor
   * @param client The LLM client to use
   * @param focusedProjectId The current focused project ID
   * @param focusedProjectName The current focused project name
   */
  constructor(
    client: ILLMClient,
    focusedProjectId: LinearGuid | null = null,
    focusedProjectName: string = ''
  ) {
    this.client = client;
    this.focusedProjectId = focusedProjectId;
    this.focusedProjectName = focusedProjectName;
  }

  /**
   * Convert natural language changes to GraphQL mutations
   * @param plainTextStaging The plain-text staging input
   * @param validateFn Optional function to validate/preprocess the input
   * @returns Array of GraphQL mutations
   */
  public async convertToGraphQLMutations(
    plainTextStaging: string,
    validateFn?: (text: string) => string
  ): Promise<GraphQLMutation[]> {
    // Apply validation if provided
    const validatedText = validateFn ? validateFn(plainTextStaging) : plainTextStaging;
    
    // Create context using INSTANCE variables
    const focusedProjectContext = this.focusedProjectId 
      ? `IMPORTANT: You are currently focused on the project "${this.focusedProjectName}" with ID "${this.focusedProjectId}".
All new issues should be created in this project. DO NOT create a new project.
When creating issues, use the project ID: "${this.focusedProjectId}".` 
      : '';
    
    // Build the complete prompt with context
    const prompt = `${GRAPHQL_CONVERTER_PROMPT}

${focusedProjectContext}

Plain-text staging:
"""
${validatedText}
"""

Convert this to a JSON array of GraphQL mutations. Use symbolic references for IDs that will be resolved later.
For example, use {{issue_id}} for existing issues and TMP-1, TMP-2, etc. for new issues.
Make sure to preserve all relationships and metadata.`;

    // Define the function declaration for the GraphQL conversion
    const functionDeclaration: FunctionDeclaration = {
      name: "convertToGraphQLMutations",
      description: "Convert plain text into structured GraphQL mutations",
      parameters: {
        type: "object",
        properties: {
          mutations: {
            type: "array",
            description: "Array of GraphQL mutations to execute",
            items: {
              type: "object",
              properties: {
                mutation: { 
                  type: "string", 
                  description: "GraphQL mutation name (e.g. projectCreate, issueCreate)" 
                },
                variables: { 
                  type: "object", 
                  description: "Mutation variables/parameters",
                  properties: {
                    id: { type: "string", description: "ID for the entity being updated" },
                    title: { type: "string", description: "Title for issues or tasks" },
                    description: { type: "string", description: "Description text" },
                    name: { 
                      type: "string", 
                      description: "The required name for the project being created (when mutation is 'projectCreate') or team."
                    },
                    projectId: { type: "string", description: "Project ID reference" },
                    parentId: { type: "string", description: "Parent issue ID for parent-child relationships" },
                    targetId: { type: "string", description: "Target ID for linking entities" },
                    entityType: { type: "string", description: "Type of entity (issue, project, etc.)" }
                  }
                },
                result_id: { 
                  type: "string", 
                  description: "Optional ID to reference this mutation's result in other mutations"
                }
              },
              required: ["mutation", "variables"]
            }
          }
        },
        required: ["mutations"]
      }
    };

    try {
      // Make the function call
      const response = await this.client.sendFunctionCall(prompt, functionDeclaration);
      
      // Extract mutations from the function arguments
      if (response.functionArgs && Array.isArray(response.functionArgs.mutations)) {
        const mutations = response.functionArgs.mutations as GraphQLMutation[];

        return mutations;
      }
      
      console.warn("[GraphQLProcessor] LLM response did not contain a valid mutations array.");
      return [];
    } catch (error) {
      console.error('Error in GraphQL conversion:', error);
      throw error;
    }
  }
} 