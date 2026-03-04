import { type GeminiClient } from '@/api';
import { type LinearClient } from '@linear/sdk';
import { type IdMapper } from '@/linear/id-mapper';
import { type FocusManager } from '@/linear/focus-manager';
import { type GraphQLMutation, type StagingTransformation } from '@/linear/staging-transformer/types';
import { type StagedChange } from '@/linear/changes';
import { PlainTextGenerator } from '@/linear/staging-transformer/plain-text-generator';
import { GraphQLConverter } from '@/linear/staging-transformer/graphql-converter';
import { MutationConverter } from '@/linear/staging-transformer/mutation-converter';
import { type LinearGuid, asLinearGuid } from '@/types/linear-ids';

/**
 * Class that handles the two-stage LLM process for Linear changes
 * 1. Generate plain-text staging intent
 * 2. Convert plain-text to GraphQL mutations with symbolic IDs
 */
export class StagingTransformer {
  private linearClient: LinearClient;
  private idMapper: IdMapper;
  private focusManager?: FocusManager;
  private plainTextGenerator: PlainTextGenerator;
  private graphQLConverter: GraphQLConverter;
  private mutationConverter: MutationConverter;

  constructor(client: GeminiClient, linearClient: LinearClient, idMapper: IdMapper, focusManager?: FocusManager) {
    this.linearClient = linearClient;
    this.idMapper = idMapper;
    this.focusManager = focusManager;
    
    // Initialize helper classes
    const focusedProjectId = this.getFocusedProjectId();
    const focusedProjectName = this.getFocusedProjectName();
    
    // Initialize converters with null project ID if no focus
    this.plainTextGenerator = new PlainTextGenerator(
      client,
      focusedProjectId || null,
      focusedProjectName || '',
      this.idMapper
    );
    
    this.graphQLConverter = new GraphQLConverter(
      client,
      focusedProjectId || null,
      focusedProjectName || ''
    );
    
    this.mutationConverter = new MutationConverter(
      this.linearClient,
      this.idMapper
    );
  }

  /**
   * Check if the last response had changes
   * @returns True if the last response contained changes
   */
  public hasChanges(): boolean {
    return this.plainTextGenerator.hasChanges();
  }

  /**
   * Generate a plain-text representation of the changes and conversational response
   * @param userCommand The natural language command from the user
   * @param context Additional context for the LLM
   * @returns Plain text staging result with conversational elements
   */
  public async generatePlainTextStaging(
    userCommand: string, 
    context: string
  ): Promise<{ conversationalResponse: string; proposedChanges: Array<any> | null; }> {
    return this.plainTextGenerator.generatePlainTextStaging(userCommand, { context });
  }

  /**
   * Convert natural language changes to GraphQL mutations
   * @param plainTextStaging The plain-text staging input
   * @returns Array of GraphQL mutations
   */
  public async convertToGraphQLMutations(plainTextStaging: string): Promise<GraphQLMutation[]> {
    return this.graphQLConverter.convertToGraphQLMutations(
      plainTextStaging,
    );
  }

  /**
   * Process the full two-stage transformation
   * @param userCommand The user's natural language command
   * @param context Additional context for the LLM
   * @returns Staging transformation with plain text and mutations
   */
  public async processStaging(userCommand: string, context: string): Promise<StagingTransformation> {
    // Stage 1: Generate plain-text staging object
    const stagingResult = await this.generatePlainTextStaging(userCommand, context);
    
    // Extract the plain text part (assuming conversational response)
    // TODO: Verify if convertToGraphQLMutations expects conversational response or formatted proposed changes
    const plainTextResponse = stagingResult.conversationalResponse;
    
    // Stage 2: Convert the plain text part to GraphQL mutations
    const mutations = await this.convertToGraphQLMutations(plainTextResponse);
    
    return {
      // Return the plain text part and the mutations
      plainText: plainTextResponse, 
      mutations
    };
  }

  /**
   * Convert GraphQL mutations to StagedChanges
   * @param mutations GraphQL mutations from the second stage
   * @returns StagedChanges ready for the LinearChangeManager
   */
  public async convertMutationsToStagedChanges(mutations: GraphQLMutation[]): Promise<StagedChange[]> {
    // Get the focused project ID
    const focusedProjectId = this.getFocusedProjectId();
    // Await the async call and pass the focused project ID
    return await this.mutationConverter.convertMutationsToStagedChanges(mutations, focusedProjectId);
  }

  /**
   * Get the focused project ID if available
   * @returns The focused project ID or null
   */
  private getFocusedProjectId(): LinearGuid | null {
    try {
      if (this.focusManager && this.focusManager.hasFocus()) {
        const projectId = this.focusManager.getFocusedProjectId();
        return projectId ? asLinearGuid(projectId) : null;
      }
    } catch (error) {
      console.log('Error getting focused project ID:', error);
    }
    return null;
  }
  
  /**
   * Get the focused project name if available
   * @returns The focused project name or null
   */
  private getFocusedProjectName(): string | null {
    try {
      if (this.focusManager && this.focusManager.hasFocus()) {
        return this.focusManager.getFocusedProjectName();
      }
    } catch (error) {
      console.log('Error getting focused project name:', error);
    }
    return null;
  }

  /**
   * Get the PlainTextGenerator instance
   * @returns The PlainTextGenerator instance
   */
  public getPlainTextGenerator(): PlainTextGenerator {
    return this.plainTextGenerator;
  }
} 