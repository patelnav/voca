import { type ILLMClient, type FunctionDeclaration } from '@/api/core/interfaces';
import { type ConversationEntry } from '@/types/api';
// import { type FocusManager } from '@/linear/focus-manager';
import { type StagedChange } from '@/linear/changes';

/**
 * Response structure for the Linear command processor
 */
export interface LinearCommandResponse {
  tts_response: string;
  patches: any[];
  conversation_summary?: string[];
  linearChanges?: StagedChange[];
  conversationalResponse?: string;
  proposedChanges?: Array<{
    operation: string;
    entityType?: string;
    id: string;
    title?: string;
    parentId?: string;
    targetId?: string;
  }>;
}

/**
 * Adapter for processing Linear commands using an LLM client
 */
export class LinearCommandProcessor {
  private llmClient: ILLMClient;
  private conversationHistory: ConversationEntry[] = [];
  private conversationSummary: string[] = [];
  private lastRawResponse: string | null = null;

  /**
   * Create a new LinearCommandProcessor
   * @param llmClient The LLM client to use
   */
  constructor(llmClient: ILLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Process a command with Linear context
   * @param command The user command
   * @param linearContext The Linear API context
   * @returns Response with both text and Linear changes
   */
  async processCommand(
    command: string,
    linearContext: any
  ): Promise<LinearCommandResponse> {
    try {
      // Define the function declaration for Linear changes
      const functionDeclaration: FunctionDeclaration = {
        name: "generateLinearChanges",
        description: "Generate structured changes for Linear entities (projects, issues, etc.)",
        parameters: {
          type: "object",
          properties: {
            conversationalResponse: {
              type: "string",
              description: "Natural language response to the user's query"
            },
            proposedChanges: {
              type: "array",
              description: "List of changes to be made to Linear entities (projects, issues)",
              items: {
                type: "object",
                properties: {
                  operation: {
                    type: "string",
                    description: "Type of operation (CREATE, UPDATE, DELETE, LINK)"
                  },
                  entityType: {
                    type: "string",
                    description: "Type of entity (PROJECT, ISSUE, CYCLE, etc.)",
                    enum: ["PROJECT", "ISSUE"]
                  },
                  id: {
                    type: "string",
                    description: "ID of the entity (e.g., TMP-1 for new, NP-123 or project ID for existing)"
                  },
                  title: {
                    type: "string",
                    description: "Title of the issue (for CREATE/UPDATE operations on issues)"
                  },
                  name: {
                    type: "string",
                    description: "Name of the project (for CREATE/UPDATE operations on projects)"
                  },
                  parentId: {
                    type: "string",
                    description: "ID of the parent issue (for UPDATE operations with parent assignment)"
                  },
                  targetId: {
                    type: "string",
                    description: "ID of the target for LINK operations"
                  },
                  description: {
                    type: "string",
                    description: "Description of the issue (for CREATE/UPDATE operations on issues)"
                  },
                  status: {
                    type: "string",
                    description: "Target status name (e.g., 'Todo', 'Done', 'In Progress') for UPDATE operations on issues. Use stateId if possible."
                  },
                  stateId: {
                     type: "string",
                     description: "Target workflow state UUID for UPDATE operations on issues."
                  },
                  priority: {
                    type: "string",
                    description: "Target priority name (e.g., 'High', 'Low') or number (0-4) as a string for UPDATE operations on issues."
                  }
                },
                required: ["operation", "id", "entityType"]
              }
            }
          },
          required: ["conversationalResponse", "proposedChanges"]
        }
      };

      // Build context from Linear data and conversation history
      let prompt = command;
      
      // Only add Linear context if the prompt isn't already well-formed
      if (!command.includes("generateLinearChanges") && Object.keys(linearContext).length > 0) {
        const historyContext = this.conversationHistory.length > 1 
          ? `\nRecent conversation:\n${this.conversationHistory.slice(0, 3).map(entry => entry.userCommand).join('\n')}`
          : '';

        prompt = `${historyContext}\n${JSON.stringify(linearContext, null, 2)}\n\nUser Query: ${command}`;
      }

      // Make the function call
      const response = await this.llmClient.sendFunctionCall(prompt, functionDeclaration);
      
      // Extract Linear changes from the function arguments
      if (response.functionArgs) {
        const args = response.functionArgs;
        return {
          tts_response: args.conversationalResponse || "I processed your request.",
          patches: [],
          linearChanges: [],
          conversationalResponse: args.conversationalResponse,
          proposedChanges: args.proposedChanges || []
        };
      }
      
      // Fallback if function call doesn't return expected format
      return {
        tts_response: "I couldn't process your request properly.",
        patches: [],
        linearChanges: [],
        conversationalResponse: "I couldn't process your request properly.",
        proposedChanges: []
      };
    } catch (error: any) {
      console.error("Error in processCommand:", error);
      return {
        tts_response: `There was an error processing your request: ${error.message}`,
        patches: [],
        linearChanges: [],
        conversationalResponse: `There was an error processing your request: ${error.message}`,
        proposedChanges: []
      };
    }
  }

  /**
   * Get the last raw response from the LLM
   */
  getLastRawResponse(): string | null {
    return this.lastRawResponse;
  }

  /**
   * Clear conversation history and summary
   */
  clearConversationHistory(): void {
    this.conversationHistory = [];
    this.conversationSummary = [];
  }

  /**
   * Get the current conversation history
   */
  getConversationHistory(): ConversationEntry[] {
    return [...this.conversationHistory];
  }

  /**
   * Get the current conversation summary
   */
  getConversationSummary(): string[] {
    return [...this.conversationSummary];
  }
}