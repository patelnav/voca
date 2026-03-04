import chalk from 'chalk';
import { saveDiagnosticData } from './json-utils';
import { GeminiClient } from '../../api/core/gemini-client';
import { GraphQLProcessor, type GraphQLMutation } from '../../api/adapters/graphql-processor';

/**
 * Class responsible for converting plain text to GraphQL mutations
 * Serves as a bridge between existing code and the new architecture
 */
export class GraphQLConverter {
  private processor: GraphQLProcessor;

  constructor(geminiAPI: GeminiClient | { debug?: boolean }) {
    // Use the passed GeminiClient directly if it's an instance, otherwise throw an error
    if (!(geminiAPI instanceof GeminiClient)) {
      throw new Error('GeminiClient instance is required');
    }
    
    // Create the processor with the provided GeminiClient
    this.processor = new GraphQLProcessor(geminiAPI);
  }

  /**
   * Convert natural language changes to GraphQL mutations
   * @param plainTextStaging The plain-text staging input
   * @param validateFn Function to validate the plain text staging
   * @param debugLogPath Optional path to save debug logs
   * @returns Array of GraphQL mutations
   */
  public async convertToGraphQLMutations(
    plainTextStaging: string,
    validateFn?: (text: string) => string,
    debugLogPath?: string
  ): Promise<GraphQLMutation[]> {
    try {
      // Call processor's method WITHOUT passing runtime context args
      const mutations = await this.processor.convertToGraphQLMutations(
        plainTextStaging,
        validateFn
      );
      
      // Save debug logs if path is provided
      if (debugLogPath) {
        saveDiagnosticData(mutations, debugLogPath);
      }
      
      return mutations;
    } catch (error) {
      console.error(chalk.red('Error in GraphQL conversion:'), error);
      throw error;
    }
  }
} 