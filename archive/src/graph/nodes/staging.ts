import type { VocaAgentStateType } from '@/graph/graph';
import type { GraphQLMutation } from '../../linear/staging-transformer';
import type { StagedChange } from '../../linear/changes';
import type { NodeDependencies } from '@/graph/types'; // Assuming MutationConverter is now in types
import type { ConvertToStagedChangesStateOutput, StagingSubgraphStateType } from '../graph'; // Assuming these are in graph.ts

// const PROPOSED_CHANGES_SEPARATOR = '--- PROPOSED CHANGES ---'; // <<< Removed, unused

// Helper function (if needed by staging nodes, otherwise remove)
function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}


/**
 * Node: generatePlainTextNode (Updated)
 * Generates conversational response and potential changes text.
 * Separates conversational part from proposed changes.
 * NOTE: Temporarily adding back `hasProposedChanges` for conditional edge routing.
 * Uses VocaAgentStateType.
 */
export async function generatePlainTextNode(
  state: VocaAgentStateType,
  dependencies: Pick<NodeDependencies, 'plainTextGenerator'>
): Promise<Partial<VocaAgentStateType & { hasProposedChanges: boolean }>> {
  const { plainTextGenerator } = dependencies;
  try {
    const { userInput, linearContext } = state;
    console.log(`[Node: generatePlainText] Generating response for: "${userInput}"`);

    const parsedContext = linearContext ? JSON.parse(linearContext) : {};

    // Call generator and get structured response
    const generatorResponse = await plainTextGenerator.generatePlainTextStaging(userInput, parsedContext);

    const conversationalPart = generatorResponse.conversationalResponse;
    // Use let for rawProposedChanges to allow modification
    let rawProposedChanges = generatorResponse.proposedChanges; // Array<any> | null

    let hasProposedChanges = false; // Important for routing

    // Check if proposed changes exist AND contain valid objects
    if (rawProposedChanges && rawProposedChanges.length > 0 && 
        rawProposedChanges.some(change => typeof change === 'object' && change !== null && Object.keys(change).length > 0)) {
      hasProposedChanges = true;
      console.log('[Node: generatePlainText] Proposed changes identified.');
    } else {
      console.log('[Node: generatePlainText] No valid proposed changes identified (array empty or contains only empty objects).');
      // Ensure rawProposedChanges is set to null or empty array if invalid
      rawProposedChanges = null; 
    }
    // Removed separator logic entirely

    // Return updated state fields
    return {
      conversationalPart: conversationalPart || undefined,
      rawProposedChanges: rawProposedChanges, // ADDED structured changes
      hasProposedChanges: hasProposedChanges, // For conditional routing
      error: null
    };
  } catch (error: any) {
    const errorMessage = `Error in generatePlainTextNode: ${error.message}`;
    console.error(errorMessage);
    // Ensure the return type matches Promise<Partial<VocaAgentStateType>>
    const errorState: Partial<VocaAgentStateType> = { error: errorMessage };
    return errorState;
  }
}


/**
 * Node: convertToStagedChangesNode (Replaces convertToGraphQLNode)
 * Converts plain text proposed changes into structured GraphQL mutations and then StagedChanges.
 * Now uses specific input/output state types.
 */
export async function convertToStagedChangesNode(
  state: StagingSubgraphStateType,
  dependencies: Pick<NodeDependencies, 'graphQLConverter' | 'mutationConverter' | 'plainTextGenerator' | 'linearChangeManager' | 'idMapper' | 'linearClient'>
): Promise<ConvertToStagedChangesStateOutput> {
  // Destructure dependencies
  const { /*graphQLConverter,*/ mutationConverter, /*plainTextGenerator,*/ linearChangeManager, /*idMapper, linearClient*/ } = dependencies;
  // Destructure relevant fields directly from StagingSubgraphStateType
  const { rawProposedChanges, focusedProjectId, activeEntityId, activeEntityType } = state;

  // Rename focusedProjectId for clarity within the node if needed
  const stateFocusedProjectId = focusedProjectId; 

  try {
    if (!rawProposedChanges || rawProposedChanges.length === 0) {
      console.warn('[Node: convertToStagedChanges] No raw proposed changes found in state (or array is empty).');
      // Return the full expected output structure even on early exit
      return { 
          graphQLMutations: [], 
          stagedChanges: [], 
          confirmationNeeded: false, 
          responseToUser: "No proposed changes text was found to convert.", 
          error: null 
      };
    }

    console.log('[Node: convertToStagedChanges] Mapping raw proposed changes to GraphQLMutation format...');
    
    // --- MAP rawProposedChanges to GraphQLMutation[] --- 
    const mutationsToConvert: GraphQLMutation[] = rawProposedChanges.map((change: any) => {
        // Basic validation of the raw change object
        if (!change.operation || !change.entityType || !change.id) {
            console.warn(`[MutationConverter] Invalid raw change object received: ${JSON.stringify(change)}`);
            // Return a placeholder or skip? Returning null/undefined and filtering later might be safer.
            // For now, let's create a potentially invalid mutation and let MutationConverter handle it.
            return { mutation: 'invalidFormat', variables: change }; 
        }

        const operation = change.operation.toLowerCase();
        const entityType = change.entityType.toLowerCase();

        // Construct the mutation name (e.g., issueUpdate, projectCreate)
        const mutationName = `${entityType}${capitalize(operation)}`;

        // Prepare variables, excluding operation and entityType
        const variables: Record<string, any> = { ...change };
        delete variables.operation;
        delete variables.entityType;
        // The 'id' field is already correctly placed within variables here

        console.log(`[Node: convertToStagedChanges] Mapped: ${mutationName}, Variables: ${JSON.stringify(variables)}`);
        return { 
            mutation: mutationName, 
            variables: variables 
            // result_id handling could be added if needed from raw changes
        };
    });
    // --- End Mapping ---

    console.log('[Node: convertToStagedChanges] Converting mapped mutations...');
    console.log(`[Node: convertToStagedChanges] Input to MutationConverter: ${JSON.stringify(mutationsToConvert, null, 2)}`);

    let stagedChanges: StagedChange[] | null = null;
    let confirmationNeeded = false;

    // Use the correctly scoped focused project ID
    const runtimeProjectId = (stateFocusedProjectId ??
                             (activeEntityType === 'project' ? activeEntityId : null)) ?? null;

    // Pass the CORRECTLY FORMATTED mutationsToConvert
    stagedChanges = await mutationConverter.convertMutationsToStagedChanges(
        mutationsToConvert, 
        runtimeProjectId
    );

    console.log(`[Node: convertToStagedChanges] Output from MutationConverter: ${JSON.stringify(stagedChanges, null, 2)}`);

    if (!stagedChanges || stagedChanges.length === 0) {
        console.warn('[Node: convertToStagedChanges] Mutations generated, but no staged changes produced.');
        // Ensure an error is thrown or handled consistently
        // Option 1: Throw an error to be caught by the outer try/catch
        throw new Error("Internal error: Failed to convert generated mutations to staged changes."); 
        // Option 2: Return an error state (matches current structure better)
        /* return { 
            graphQLMutations: mutationsToConvert, 
            stagedChanges: null, 
            confirmationNeeded: false, 
            error: "Internal error: Failed to convert generated mutations to staged changes."
        }; */
    } else {
        console.log(`[Node: convertToStagedChanges] Converted to ${stagedChanges.length} staged change(s).`);
        // Add changes to the manager *here* if this node is solely responsible for conversion AND staging
        // If applyChangesNode reads from linearChangeManager, this is necessary.
        // If applyChangesNode reads from state.stagedChanges, this might be redundant.
        // For now, let's assume the manager holds the state.
        stagedChanges.forEach(change => linearChangeManager.addChange(change));
        confirmationNeeded = true; 
    }

    // Return the full expected output structure
    return {
      graphQLMutations: mutationsToConvert,
      stagedChanges,
      confirmationNeeded,
      error: null // Clear error on success
    };

  } catch (err: any) {
      const errorMessage = `Error in convertToStagedChangesNode: ${err.message}`;
      console.error(errorMessage);
      // Return the full expected output structure with the error
      return { 
          graphQLMutations: undefined, // Or potentially the input mutations if available
          stagedChanges: undefined,
          confirmationNeeded: false,
          error: errorMessage 
      };
  }
} 