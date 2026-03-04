import type { PlainTextGenerator, GraphQLConverter } from '../linear/staging-transformer';
import type { FocusManager } from '../linear/focus-manager';
import type { LinearChangeManager } from '../linear/changes';
import type { IdMapper } from '../linear/id-mapper';
import type { LinearHandler } from '../cli/handlers/LinearHandler';
import type { LinearClient } from '@linear/sdk';
import type { GraphQLMutation } from '../linear/staging-transformer';
import type { StagedChange } from '../linear/changes';
import type { GeminiClient } from '@/api';

// --- Placeholder Types (Copied from original nodes.ts) --- 
// Replace with actual imports when modules are properly defined/exported
export interface MutationConverter {
    convertMutationsToStagedChanges(mutations: GraphQLMutation[], focusedProjectId: string | null): Promise<StagedChange[]>;
}
// export interface ConversationManager { // <<< REMOVED
//     getHistory(): Array<{ userCommand: string, assistantResponse: string }>; // <<< REMOVED
// } // <<< REMOVED
// --- End Placeholder Types --- 

/**
 * Defines the dependencies required by various graph nodes.
 * This is typically injected during graph setup.
 */
export interface NodeDependencies {
    plainTextGenerator: PlainTextGenerator;
    graphQLConverter: GraphQLConverter;
    mutationConverter: MutationConverter;
    focusManager: FocusManager;
    linearChangeManager: LinearChangeManager;
    idMapper: IdMapper;
    linearHandler: LinearHandler;
    // conversationManager: ConversationManager; // <<< REMOVED
    linearClient: LinearClient;
    llmClient: GeminiClient; // <<< ADDED GeminiClient dependency
} 