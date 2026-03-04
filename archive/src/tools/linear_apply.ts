import { type LinearClient } from '@linear/sdk';
import { type FunctionDeclaration, Type } from '@google/genai';
import { type AgentState, type StagedChange } from '@/state/types';
import { enrichStagedChangeData, EnrichmentError } from '@/linear/enrichment';
import { Logger } from '@/utils/logger';
import { type LinearGuid, type TemporaryFriendlyId } from '@/types/linear-ids';
import { z } from 'zod';
import { topologicalSort } from '../utils/graph';
import { executeLinearOperation, resolveIdentifiers } from './linear_sdk_helpers';
import type { ExecuteLinearOperationResult, ResolveIdentifiersResult } from './linear_sdk_helpers.types';
import { produce } from 'immer';

// --- BEGIN NEW STRUCTURED RETURN TYPE DEFINITIONS ---

export enum ApplyOutcome {
  SUCCESS_ALL_APPLIED = 'SUCCESS_ALL_APPLIED',
  SUCCESS_PARTIAL_APPLIED = 'SUCCESS_PARTIAL_APPLIED', // Some succeeded, some failed (e.g. enrichment)
  FAILURE_NONE_APPLIED = 'FAILURE_NONE_APPLIED',   // All failed (e.g. enrichment, SDK errors for all)
  ERROR_PRECONDITION = 'ERROR_PRECONDITION',     // e.g., no changes staged
  ERROR_UNKNOWN = 'ERROR_UNKNOWN'               // Unexpected error during the apply process
}

export interface ApplyChangeDetail {
  change: StagedChange;
  status: 'succeeded' | 'failed' | 'skipped';
  newId?: string;        // Populated on success for creations
  reason?: string;       // Populated on failure or skip
}

export interface ApplyStagedChangesResult {
  success: boolean;            // Overall success indicator (true if at least one change succeeded)
  outcome: ApplyOutcome;       // Detailed outcome category
  results: ApplyChangeDetail[];// Detailed results for each attempted change
  message?: string;            // Optional message for overall errors (like precondition failures)
}
// --- END NEW STRUCTURED RETURN TYPE DEFINITIONS ---

interface ApplyResult {
    succeeded: StagedChange[];
    failed: Array<{ change: StagedChange; reason: string }>;
    skipped: Array<{ change: StagedChange; reason: string }>;
}

// --- BEGIN NEW TYPE DEFINITION ---
interface ProcessChangeResult {
    status: 'succeeded' | 'failed' | 'skipped';
    originalChange: StagedChange; // Keep track of the exact change object processed
    newId?: LinearGuid;          // The new Linear GUID if an entity was created
    reason?: string;             // Reason for failure or skip
}
// --- END NEW TYPE DEFINITION ---

const ApplyStagedChangesInput = z.object({});

export const applyStagedChangesToolSchema: FunctionDeclaration = {
    name: 'apply_staged_changes',
    description: 
        'Executes the sequence of staged changes against the Linear API. ' +
        'This should ONLY be called after the user explicitly confirms they want to apply the changes. ' +
        'Reads the current staged changes from the agent state, attempts to apply them in order, ' +
        'and reports the success or failure of the batch operation.',
    parameters: { 
        type: Type.OBJECT, 
        properties: {
            pre_execution_narration: {
                type: Type.STRING,
                description: "Optional. A short, friendly message (1-2 sentences) to display to the user *before* this tool executes, briefly explaining what you are about to do with this tool. Infuse your current persona. Example: 'Alright, I\'ll apply those changes now!'",
                nullable: true,
            },
        }, 
        required: [] 
    },
};

export const formatEnrichmentFailureReason = (message: string): string => {
    return `Enrichment failed: ${message}`;
};

export const formatSdkFailureReason = (opType: string): string => {
    return `Linear SDK reported failure for ${opType}. Success was false.`;
};

export async function apply_staged_changes(
    _input: z.infer<typeof ApplyStagedChangesInput>,
    initialState: AgentState,
    linearClient: LinearClient
): Promise<{ newState: AgentState, output: ApplyStagedChangesResult }> {
    const logger = Logger.getInstance();
    const allResults: ApplyChangeDetail[] = []; // <-- Stores detailed results

    if (!initialState.staged_changes || initialState.staged_changes.length === 0) {
        return {
            newState: initialState, // <-- Return initial state
            output: { // <-- Wrap result in 'output'
                success: true, // Considered success as there was nothing to do
                outcome: ApplyOutcome.ERROR_PRECONDITION,
                results: [],
                message: 'No staged changes found to apply.'
            }
        };
    }

    let sortedChanges: StagedChange[];
    try {
        sortedChanges = sortByDependencies([...initialState.staged_changes]);
    } catch (e: any) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.logError(e, `apply_staged_changes - sortByDependencies encountered an issue: ${errorMessage}`);
        return {
            newState: initialState, // <-- Return initial state
            output: { // <-- Wrap result in 'output'
                success: false,
                outcome: ApplyOutcome.ERROR_PRECONDITION,
                results: [],
                message: `Error: Could not determine a valid order for applying changes. Details: ${errorMessage}`
            }
        };
    }

    // Initialize internalIdMap from the initial state for this batch of operations.
    // This map will be updated as new entities are created and their tempIDs are resolved.
    const internalIdMap = new Map<string, LinearGuid>(Object.entries(initialState.id_map || {}));
    const tempIdsToRemoveOnSuccess = new Set<TemporaryFriendlyId>();

    // Perform all async operations first
    for (const change of sortedChanges) {
        const processResult: ProcessChangeResult = await processSingleChange(
            change,
            internalIdMap, // Pass the mutable map that gets updated in the loop
            linearClient,
            initialState.sessionId // Use sessionId from initial state
        );

        const detail: ApplyChangeDetail = {
            status: processResult.status,
            change: processResult.originalChange,
            newId: processResult.newId?.toString(),
            reason: processResult.reason,
        };
        allResults.push(detail); // <-- Add detailed result

        if (processResult.status === 'succeeded') {
            if (processResult.newId && processResult.originalChange.tempId) {
                internalIdMap.set(processResult.originalChange.tempId, processResult.newId); // Update for subsequent calls in this batch
            }
            // Mark for removal based on tempId if present
            if (processResult.originalChange.tempId) {
                 tempIdsToRemoveOnSuccess.add(processResult.originalChange.tempId);
            }
        }
    }

    // Now, apply the collected changes to the state synchronously using Immer
    const finalState = produce(initialState, draftState => {
        // Update the draftState's id_map with all resolutions from this batch
        internalIdMap.forEach((value, key) => {
            draftState.id_map[key] = value;
        });

        const identifiersToRemove = new Set<string>();

        const getChangeIdentifier = (change: StagedChange): string | undefined => {
            if (change.tempId) {
                return `tempId:${change.tempId}`;
            }
            // Ensure data and id exist for signature-based identification
            // Also ensure opType is present for a complete signature.
            if (change.data && typeof change.data.id === 'string' && change.opType) {
                return `signature:${change.opType}:::${change.data.id}`;
            }
            // Log if a change cannot be uniquely identified for removal purposes.
            // This change might be kept by default if no identifier can be generated.
            console.warn(`[apply_staged_changes] Could not generate a unique removal identifier for change: opType=${change.opType}, tempId=${change.tempId}, data.id=${change.data?.id}`);
            return undefined;
        };

        allResults.forEach(result => {
            const id = getChangeIdentifier(result.change);
            if (!id) return; // Skip if no identifier

            // Remove if succeeded
            if (result.status === 'succeeded') {
                identifiersToRemove.add(id);
            }
            // Remove if failed *during* SDK execution (not during enrichment/prep)
            else if (result.status === 'failed') {
                const reason = result.reason || '';
                if (!reason.startsWith('Enrichment failed:') &&
                    !reason.includes('ID resolution error') &&
                    !reason.startsWith('Unexpected enrichment error:') &&
                    !reason.startsWith('Error preparing GraphQL input')) {
                    identifiersToRemove.add(id);
                }
            }
            // Do not remove skipped items - they remain staged.
        });

        draftState.staged_changes = draftState.staged_changes.filter(stagedChangeInDraft => {
            const currentId = getChangeIdentifier(stagedChangeInDraft);
            // If an identifier could be generated and it's in the set to remove, then filter out (return false).
            if (currentId && identifiersToRemove.has(currentId)) {
                return false; 
            }
            // Otherwise, keep the change (return true).
            return true; 
        });

    }); // End of produce

    // Determine final outcome
    const numSucceeded = allResults.filter(r => r.status === 'succeeded').length;
    const numFailed = allResults.filter(r => r.status === 'failed').length;
    const numSkipped = allResults.filter(r => r.status === 'skipped').length;
    const totalProcessed = numSucceeded + numFailed + numSkipped; // Should match sortedChanges.length

    let finalOutcome: ApplyOutcome;
    let finalSuccess: boolean;

    if (numSucceeded === totalProcessed && totalProcessed > 0) {
        finalOutcome = ApplyOutcome.SUCCESS_ALL_APPLIED;
        finalSuccess = true;
    } else if (numSucceeded > 0) {
        finalOutcome = ApplyOutcome.SUCCESS_PARTIAL_APPLIED;
        finalSuccess = true;
    } else if (totalProcessed > 0) { // No successes, but attempts were made
        finalOutcome = ApplyOutcome.FAILURE_NONE_APPLIED;
        finalSuccess = false;
    } else { // Should ideally be caught by the initial check, but as a fallback
        finalOutcome = ApplyOutcome.ERROR_UNKNOWN; 
        finalSuccess = false; 
    }

    // Construct the final output object (excluding the state)
    const overallResult: ApplyStagedChangesResult = {
        success: finalSuccess,
        outcome: finalOutcome,
        results: allResults, 
        message: !finalSuccess && finalOutcome !== ApplyOutcome.SUCCESS_PARTIAL_APPLIED ? `Apply finished with outcome: ${finalOutcome}` : undefined,
    };

    logger.logCli(`[apply_staged_changes] Overall result for LLM: ${JSON.stringify(overallResult, null, 2)}`);
    logger.logCli(`[apply_staged_changes] Final agent state BEFORE RETURN: ${finalState ? finalState.sessionId : 'UNDEFINED!'} State: ${JSON.stringify(finalState, null, 2)}`); // <-- ADDED LOG

    // Return BOTH the final state and the result object
    return { newState: finalState, output: overallResult };
}

// --- BEGIN NEW HELPER FUNCTION ---
async function processSingleChange(
    change: StagedChange,
    currentIdMap: Map<string, LinearGuid>,
    linearClient: LinearClient,
    sessionId?: string
): Promise<ProcessChangeResult> {
    const logger = Logger.getInstance();

    let resolvedDataForChange: Record<string, any>;
    const idResolutionResult: ResolveIdentifiersResult = await resolveIdentifiers(
        change.data,
        change.opType,
        currentIdMap
    );

    if (!idResolutionResult.success || !idResolutionResult.resolvedData) {
        const reason = idResolutionResult.reason || 'Unknown ID resolution error.';
        logger.logError(new Error(reason), `[${sessionId || 'N/A'}] processSingleChange - ID Resolution Error for ${change.opType}`);
        return { status: 'failed', originalChange: change, reason };
    }
    resolvedDataForChange = idResolutionResult.resolvedData;

    let enrichedData: Record<string, any>;
    try {
        enrichedData = await enrichStagedChangeData({ ...change, data: resolvedDataForChange }, linearClient, currentIdMap);
    } catch (error) {
        const reason = (error instanceof EnrichmentError)
            ? formatEnrichmentFailureReason(error.message)
            : `Unexpected enrichment error: ${(error as Error).message}`;
        logger.logError(error as Error, `[${sessionId || 'N/A'}] processSingleChange - Enrichment Error for ${change.opType}`);
        return { status: 'failed', originalChange: change, reason };
    }
    
    let inputForSdk: Record<string, any>;
    let idForUpdateOp: string | undefined;
    try {
        const prepared = prepareGraphQLInput(change.opType, enrichedData);
        inputForSdk = prepared.input;
        idForUpdateOp = prepared.idForUpdate;
    } catch (error) {
        const reason = `Error preparing GraphQL input for ${change.opType}: ${(error as Error).message}`;
        logger.logError(error as Error, `[${sessionId || 'N/A'}] processSingleChange - GraphQL Input Prep Error for ${change.opType}`);
        return { status: 'failed', originalChange: change, reason };
    }
    
    let operationResult: ExecuteLinearOperationResult;
    try {
        operationResult = await executeLinearOperation(change.opType, inputForSdk, idForUpdateOp, linearClient);

        if (!operationResult.success && operationResult.reason?.includes('not implemented')) {
            return { status: 'skipped', originalChange: change, reason: operationResult.reason };
        } else if (operationResult.success) {
            return { 
                status: 'succeeded', 
                originalChange: change, 
                newId: operationResult.newId
            };
        } else {
            const reason = operationResult.reason || 'Unknown error from executeLinearOperation.';
            logger.logError(new Error(reason), `[${sessionId || 'N/A'}] processSingleChange - SDK Operation Failure for ${change.opType} (TempID: ${change.tempId}) - Reported by executeLinearOperation`);
            return { status: 'failed', originalChange: change, reason };
        }
    } catch (error: any) {
        const reason = `SDK Error during ${change.opType}: ${error.message}`;
        logger.logError(error, `[${sessionId || 'N/A'}] processSingleChange - SDK Exception for ${change.opType} (TempID: ${change.tempId})`);
        return { status: 'failed', originalChange: change, reason };
    }
}
// --- END NEW HELPER FUNCTION ---

// --- BEGIN NEW HELPER FUNCTION for comparing changes ---
export function isEffectivelySameChange(change1: StagedChange, change2: StagedChange): boolean {
    console.log(`[DEBUG isEffectivelySameChange] Comparing: (op1: ${change1.opType}, temp1: ${change1.tempId}, dataId1: ${change1.data?.id}) vs (op2: ${change2.opType}, temp2: ${change2.tempId}, dataId2: ${change2.data?.id})`);
    if (change1.opType !== change2.opType) {
        console.log(`[DEBUG isEffectivelySameChange] Result: opType mismatch -> false`);
        return false; 
    }

    if (change1.opType.endsWith('.create')) {
        const result = (change1.tempId === change2.tempId);
        console.log(`[DEBUG isEffectivelySameChange] Result (create op): (temp1 === temp2) -> ${result}`);
        return result; 
    }

    if (change1.opType.endsWith('.update') || change1.opType.endsWith('.delete')) {
        const result = (change1.data?.id === change2.data?.id);
        console.log(`[DEBUG isEffectivelySameChange] Result (update/delete op): (dataId1 === dataId2) -> ${result}`);
        return result; 
    }

    if (change1.tempId && change2.tempId) {
        const result = change1.tempId === change2.tempId;
        console.log(`[DEBUG isEffectivelySameChange] Result (fallback tempId): ${result}`);
        return result;
    }
    if (change1.tempId || change2.tempId) {
        console.log(`[DEBUG isEffectivelySameChange] Result (fallback one tempId): false`);
        return false;
    }
    if (change1.data?.id && change2.data?.id) {
        const result = change1.data.id === change2.data.id;
        console.log(`[DEBUG isEffectivelySameChange] Result (fallback dataId): ${result}`);
        return result;
    }
    
    console.log(`[DEBUG isEffectivelySameChange] Result: Fallback default -> false`);
    return false;
}
// --- END NEW HELPER FUNCTION for comparing changes ---

export function prepareGraphQLInput(
  op: string,
  enrichedData: Record<string, any>,
): { input: Record<string, any>, idForUpdate?: string } {
    let input: Record<string, any> = { ...enrichedData };
    let idForUpdate: string | undefined = undefined;

    if (op === 'issue.create' && !input.teamId) {
        throw new Error(`'teamId' is required in enrichedData for 'issue.create' but was not found. Input: ${JSON.stringify(input)}`);
    }

    if (input.id && (op.endsWith('.update') || op.endsWith('.delete'))) {
        idForUpdate = input.id as string;
        delete input.id; 
    }
    if (input.identifier && (op.endsWith('.update') || op.endsWith('.delete'))) {
        if (!idForUpdate) idForUpdate = input.identifier as string;
        delete input.identifier;
    }
    if (input.tempId && op.endsWith('.create')) {
        delete input.tempId;
    }
    if (input.opType) {
        delete input.opType;
    }
    return { input, idForUpdate };
}

function sortByDependencies(changes: StagedChange[]): StagedChange[] {
    const nodes = changes.map(change => ({
        id: change.tempId || change.data.id || JSON.stringify(change.data),
        change: change,
        dependencies: [] as string[],
    }));

    const nodeMap = new Map(nodes.map(node => [node.id, node]));

    for (const node of nodes) {
        for (const key in node.change.data) {
            const value = node.change.data[key];
            if (typeof value === 'string' && value.startsWith('temp:')) {
                const depTempId = value.substring(5) as TemporaryFriendlyId;
                const dependentNode = nodes.find(n => n.change.tempId === depTempId);
                if (dependentNode) {
                    node.dependencies.push(dependentNode.id);
                } else {
                    // console.warn(`sortByDependencies: Could not find a staged change with tempId: '${depTempId}' referenced in change for ${node.id}. This may lead to incorrect ordering or runtime errors.`);
                }
            }
        }
    }

    const nodeIds = nodes.map(node => node.id);
    const adjList = new Map<string, string[]>();
    nodes.forEach(node => {
        adjList.set(node.id, node.dependencies);
    });

    const sortedIds = topologicalSort(nodeIds, adjList);

    return sortedIds.map((id: string) => {
        const foundNode = nodeMap.get(id);
        if (!foundNode) {
            throw new Error(`Internal error in sortByDependencies: Node ID '${id}' not found in nodeMap after sort.`);
        }
        return foundNode.change;
    });
}

// Remove or comment out the formatApplyResults function as it's no longer used by apply_staged_changes
/*
function formatApplyResults(results: ApplyResult): string {
    let output = '';
    if (results.succeeded.length > 0) {
        output += `Successfully applied ${results.succeeded.length} change(s).
`;
        // Optionally list details, but keep it concise for now
    }
    if (results.failed.length > 0) {
        output += `Failed to apply ${results.failed.length} change(s):
`;
        results.failed.forEach(f => {
            const id = f.change.tempId ?? f.change.data?.id ?? 'unknown identifier';
            output += `  - ${f.change.opType} (${id}): ${f.reason}
`;
        });
    }
    if (results.skipped.length > 0) {
        output += `Skipped ${results.skipped.length} change(s):
`;
         results.skipped.forEach(s => {
            const id = s.change.tempId ?? s.change.data?.id ?? 'unknown identifier';
            output += `  - ${s.change.opType} (${id}): ${s.reason}
`;
        });
    }

    if (output === '') {
        output = 'No changes were processed.'; // Should not happen if called correctly
    }

    return output.trim();
}
*/ 