// Export core interfaces and implementations
export type { 
  ILLMClient,
  RawResponse,
  FunctionCallResponse,
  ChatResponse,
  FunctionDeclaration,
  ChatMessage,
  GenerationConfig 
} from '@/api/core/interfaces';
export { GeminiClient } from '@/api/core/gemini-client';

// Export domain-specific adapters
export { GraphQLProcessor } from '@/api/adapters/graphql-processor';
export type { GraphQLMutation } from '@/api/adapters/graphql-processor';
export { LinearCommandProcessor } from '@/api/adapters/linear-command-processor';
export type { LinearCommandResponse } from '@/api/adapters/linear-command-processor'; 