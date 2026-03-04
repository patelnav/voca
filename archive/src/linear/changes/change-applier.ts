import type { LinearClient } from '@linear/sdk';
import type { ChangeResult, StagedChange } from './types';
import type { TemporaryIdMapper } from './temporary-id-mapper';
import type { IdRegistry } from './id-registry';
import { executeOperation } from '@/linear/operations';
import chalk from 'chalk';
import { asLinearGuid, asLinearFriendlyId, type TemporaryFriendlyId, isTemporaryFriendlyId, type LinearGuid } from '@/types/linear-ids'; // Needed for executeChange
import type { IdMapper, EntityType } from '@/linear/id-mapper'; // Needed for executeChange and type checking

// --- BEGIN NEW STRUCTURED RETURN TYPE DEFINITIONS ---
// Mirroring the structure from linear_apply.ts for consistency

export enum ApplyOutcome {
  SUCCESS_ALL_APPLIED = 'SUCCESS_ALL_APPLIED',
  SUCCESS_PARTIAL_APPLIED = 'SUCCESS_PARTIAL_APPLIED', // Some succeeded, some failed/skipped
  FAILURE_NONE_APPLIED = 'FAILURE_NONE_APPLIED',     // All failed or were skipped (excluding dependency failures)
  ERROR_DEPENDENCY = 'ERROR_DEPENDENCY',             // At least one failed *due to* a dependency issue
  ERROR_PRECONDITION = 'ERROR_PRECONDITION',         // e.g., sorting error, no changes
  ERROR_UNKNOWN = 'ERROR_UNKNOWN'                    // Catch-all for unexpected issues
}

// Simplified detail based on ChangeResult
export interface ApplyChangeDetail {
  status: 'succeeded' | 'failed' | 'skipped'; // 'skipped' could be due to dependency failure
  change: StagedChange;       // The original staged change attempt
  newId?: LinearGuid;          // The Linear ID if created (casting from ChangeResult's string)
  reason?: string;             // Reason for failure/skip (casting from ChangeResult's any)
}

export interface ApplyChangesResult {
  success: boolean;            // Overall success indicator (true if at least one change succeeded *directly*)
  outcome: ApplyOutcome;       // Detailed outcome category
  results: ApplyChangeDetail[];// Detailed results for each attempted change
  message?: string;            // Optional message for overall errors (like precondition failures)
}
// --- END NEW STRUCTURED RETURN TYPE DEFINITIONS ---

/**
 * Handles the application of staged changes to the Linear API.
 * Orchestrates dependency sorting, execution, and ID mapping.
 */
export class ChangeApplier {
    private linearClient: LinearClient;
    private temporaryIdMapper: TemporaryIdMapper;
    private idRegistry: IdRegistry;
    private idMapper: IdMapper; // Direct access might be needed if not fully handled by TempIdMapper
    private getStagedChanges: () => StagedChange[];
    private updateStagedChanges: (remainingChanges: StagedChange[]) => void;
    private refreshCachesCallback: () => Promise<void>; 
    private getNextIssueCounter: () => number; // Needed for executeChange internalId generation

    constructor(
        linearClient: LinearClient,
        temporaryIdMapper: TemporaryIdMapper,
        idRegistry: IdRegistry,
        idMapper: IdMapper, // Pass main IdMapper
        getStagedChanges: () => StagedChange[],
        updateStagedChanges: (remainingChanges: StagedChange[]) => void,
        refreshCachesCallback: () => Promise<void>,
        getNextIssueCounter: () => number // Pass counter getter
    ) {
        this.linearClient = linearClient;
        this.temporaryIdMapper = temporaryIdMapper;
        this.idRegistry = idRegistry;
        this.idMapper = idMapper; 
        this.getStagedChanges = getStagedChanges;
        this.updateStagedChanges = updateStagedChanges;
        this.refreshCachesCallback = refreshCachesCallback;
        this.getNextIssueCounter = getNextIssueCounter;
    }

    /**
     * Apply all staged changes to Linear.
     * @returns Results of all change operations.
     */
    async applyChanges(): Promise<ApplyChangesResult> {
        const stagedChanges = this.getStagedChanges(); // Get current changes
        const allResults: ApplyChangeDetail[] = []; // <-- Stores detailed results
        const changeMap = new Map<string, ChangeResult>(); // Keep original ChangeResult map for internal dependency checks

        if (!stagedChanges || stagedChanges.length === 0) {
            return {
                success: true, // No changes, considered successful pre-condition
                outcome: ApplyOutcome.ERROR_PRECONDITION,
                results: [],
                message: 'No staged changes to apply.'
            };
        }

        // Group changes by type:
        const entityCreationChanges: StagedChange[] = [];
        const relationshipChanges: StagedChange[] = [];
        
        for (const change of stagedChanges) {
            if (change.entityType === 'relationship' && change.operation === 'link') {
                relationshipChanges.push(change);
            } else {
                // All non-link relationship ops go in the entity phase
                entityCreationChanges.push(change);
            }
        }
        
        console.log(`Executing in two phases: ${entityCreationChanges.length} entity/other ops, ${relationshipChanges.length} relationships`);

        // Clear the temporary ID map at the start of each apply operation
        this.temporaryIdMapper.clear();
        
        // Sort entity/other changes based on dependencies
        let orderedEntityChanges: StagedChange[];
        try {
             orderedEntityChanges = this.sortChangesByDependencies(entityCreationChanges);
        } catch (e: any) {
             const errorMessage = `Error sorting entity changes: ${e instanceof Error ? e.message : String(e)}`;
             console.error(chalk.red(errorMessage));
             return {
                 success: false,
                 outcome: ApplyOutcome.ERROR_PRECONDITION,
                 results: [],
                 message: errorMessage
             };
        }

        const failedChangeIds = new Set<string>();
        const successfulChangeIds = new Set<string>();

        // PHASE 1: Create/update/delete entities and other ops
        console.log(chalk.yellow(`=== PHASE 1: ENTITY OPERATIONS ===`));
        for (const change of orderedEntityChanges) {
            try {
                if (change.dependsOn && change.dependsOn.some((id: string) => failedChangeIds.has(id))) {
                    console.warn(
                        chalk.gray(`Skipping change ${change.id} (${change.description}) because a dependency failed`)
                    );
                    const detail: ApplyChangeDetail = { change, status: 'skipped', reason: 'Dependency failed' }; // <-- Store skip detail
                    allResults.push(detail);
                    changeMap.set(change.id, { change, success: false, error: 'Dependency failed' }); // Add placeholder
                    failedChangeIds.add(change.id); // Treat dependency failure as a failure for subsequent checks
                    continue;
                }

                const result: ChangeResult = await this.executeChange(change, changeMap); // Use internal executeChange
                const detail: ApplyChangeDetail = {
                    change: result.change,
                    status: result.success ? 'succeeded' : 'failed',
                    newId: result.newId ? asLinearGuid(result.newId) : undefined,
                    reason: result.error ? String(result.error) : undefined
                };
                allResults.push(detail); // <-- Store result detail
                changeMap.set(change.id, result); // Keep original ChangeResult for dependency checks
                
                if (result.success) {
                    successfulChangeIds.add(change.id);
                    // Store ID mappings for created entities (handled within executeChange now)
                } else {
                    failedChangeIds.add(change.id);
                    const errorResultFromCatch: ChangeResult = { change, success: false, error: result.error };
                    const detail: ApplyChangeDetail = { change, status: 'failed', reason: String(errorResultFromCatch.error) };
                    allResults.push(detail); // <-- Store error detail
                    changeMap.set(change.id, errorResultFromCatch);
                }
            } catch (error) {
                console.error(chalk.red(`Unhandled error during entity change ${change.id}:`), error);
                failedChangeIds.add(change.id);
                const errorResultFromCatch: ChangeResult = { change, success: false, error: error instanceof Error ? error.message : String(error) };
                const detail: ApplyChangeDetail = { change, status: 'failed', reason: String(errorResultFromCatch.error) };
                allResults.push(detail); // <-- Store error detail
                changeMap.set(change.id, errorResultFromCatch);
            }
        }

        // PHASE 2: Process relationship links
        console.log(chalk.yellow(`\n=== PHASE 2: RELATIONSHIPS ===`));
        // Sort relationship changes (though often dependencies are on Phase 1 changes)
        let orderedRelationshipChanges: StagedChange[];
         try {
             orderedRelationshipChanges = this.sortChangesByDependencies(relationshipChanges);
         } catch (e: any) {
              const errorMessage = `Error sorting relationship changes: ${e instanceof Error ? e.message : String(e)}`;
              console.error(chalk.red(errorMessage));
             // Note: We don't return immediately, Phase 1 might have succeeded.
             // We'll factor this into the final outcome calculation.
             relationshipChanges.forEach(change => {
                 allResults.push({ change, status: 'skipped', reason: `Dependency sort error: ${errorMessage}`});
                 failedChangeIds.add(change.id); // Mark as failed for removal purposes
             });
             orderedRelationshipChanges = []; // Prevent further processing
         }

        for (const change of orderedRelationshipChanges) {
            try {
                if (change.dependsOn && change.dependsOn.some((id: string) => failedChangeIds.has(id) || !changeMap.get(id)?.success)) {
                    console.warn(
                       chalk.gray( `Skipping relationship ${change.id} (${change.description}) because a dependency failed or was skipped`)
                    );
                     const detail: ApplyChangeDetail = { change, status: 'skipped', reason: 'Dependency failed' }; // <-- Store skip detail
                     allResults.push(detail);
                     changeMap.set(change.id, { change, success: false, error: 'Dependency failed' }); // Add placeholder
                     failedChangeIds.add(change.id); // Treat as failure for subsequent checks
                    continue;
                }

                const result: ChangeResult = await this.executeChange(change, changeMap); // Use internal executeChange
                const detail: ApplyChangeDetail = {
                    change: result.change,
                    status: result.success ? 'succeeded' : 'failed',
                    newId: result.newId ? asLinearGuid(result.newId) : undefined,
                    reason: result.error ? String(result.error) : undefined
                };
                allResults.push(detail); // <-- Store result detail
                changeMap.set(change.id, result); // Keep original ChangeResult
                
                 if (result.success) {
                    successfulChangeIds.add(change.id);
                } else {
                    failedChangeIds.add(change.id);
                    const errorResultFromCatch: ChangeResult = { change, success: false, error: result.error };
                    const detail: ApplyChangeDetail = { change, status: 'failed', reason: String(errorResultFromCatch.error) };
                    allResults.push(detail); // <-- Store error detail
                    changeMap.set(change.id, errorResultFromCatch);
                }
            } catch (error) {
                 console.error(chalk.red(`Unhandled error during relationship change ${change.id}:`), error);
                failedChangeIds.add(change.id);
                const errorResultFromCatch: ChangeResult = { change, success: false, error: error instanceof Error ? error.message : String(error) };
                const detail: ApplyChangeDetail = { change, status: 'failed', reason: String(errorResultFromCatch.error) };
                allResults.push(detail); // <-- Store error detail
                changeMap.set(change.id, errorResultFromCatch);
            }
        }

        // Update the main list of staged changes by removing successful and dependency-failed ones
        // Successful changes are definitely removed.
        // Changes that were skipped due to direct dependency failure (not sort error) are also effectively "processed" and should be removed.
        const idsToRemove = new Set<string>();
        allResults.forEach(r => {
            if (r.status === 'succeeded' || (r.status === 'skipped' && r.reason === 'Dependency failed')) {
                idsToRemove.add(r.change.id);
            }
        });
        const remainingChanges = stagedChanges.filter(change => !idsToRemove.has(change.id));
        this.updateStagedChanges(remainingChanges);
        
        // After applying changes, refresh the ID mapper and focus manager caches via callback
        await this.refreshCachesCallback();
        
        console.log(chalk.green(`\nChange application finished. Results: ${allResults.length}, Successful: ${successfulChangeIds.size}, Failed/Skipped: ${allResults.length - successfulChangeIds.size}`));
        
        // Determine final outcome
        const numSucceeded = successfulChangeIds.size;
        const numAttempted = stagedChanges.length; // Total changes we started with
        const numDependencyFailedOrSkippedSort = allResults.filter(r => r.status === 'skipped' && (r.reason === 'Dependency failed' || r.reason?.startsWith('Dependency sort error:'))).length;
        const numDirectFailed = allResults.filter(r => r.status === 'failed').length;

        let finalOutcome: ApplyOutcome;
        let finalSuccess: boolean;

        if (numAttempted === 0 && allResults.length === 0) { // Should have been caught by pre-condition check
            finalOutcome = ApplyOutcome.ERROR_PRECONDITION;
            finalSuccess = true; // No changes to apply, vacuously true.
        } else if (numSucceeded === numAttempted && numAttempted > 0) {
            finalOutcome = ApplyOutcome.SUCCESS_ALL_APPLIED;
            finalSuccess = true;
        } else if (numSucceeded > 0) {
            finalOutcome = ApplyOutcome.SUCCESS_PARTIAL_APPLIED;
            finalSuccess = true; // Considered overall success if *something* applied directly
        } else if (numAttempted > 0) { // No successes, but attempts were made
            if (numDependencyFailedOrSkippedSort > 0) {
                 finalOutcome = ApplyOutcome.ERROR_DEPENDENCY;
            } else if (numDirectFailed > 0) {
                 finalOutcome = ApplyOutcome.FAILURE_NONE_APPLIED; // Failed for reasons other than dependency
            } else { // All were skipped for reasons not yet categorized, or no attempts actually ran.
                 finalOutcome = ApplyOutcome.ERROR_UNKNOWN; 
            }
            finalSuccess = false;
        } else { // Fallback for any unhandled case, e.g. numAttempted=0 but allResults has items (should not happen)
             finalOutcome = ApplyOutcome.ERROR_UNKNOWN; 
             finalSuccess = false;
        }

        return {
            success: finalSuccess,
            outcome: finalOutcome,
            results: allResults,
            message: allResults.find(r => r.reason?.startsWith('Error sorting'))?.reason // Propagate sort error message
        };
    }
  
    /**
     * Sort changes based on dependencies using topological sort.
     * @param changes Array of changes to sort.
     * @returns Sorted array of changes.
     */
    private sortChangesByDependencies(changes: StagedChange[]): StagedChange[] {
        const changeMap = new Map<string, StagedChange>();
        changes.forEach((change) => changeMap.set(change.id, change));

        const sorted: StagedChange[] = [];
        const visited = new Set<string>(); // Tracks nodes permanently visited
        const visiting = new Set<string>(); // Tracks nodes currently in recursion stack (for cycle detection)

        const visit = (changeId: string) => {
            if (visited.has(changeId)) return; // Already processed
            if (visiting.has(changeId)) { // Cycle detected
                console.warn(chalk.red(`Dependency cycle detected involving change ${changeId}. Skipping dependent chain.`));
                // Mark as visited to prevent further processing in this cycle path
                // Note: This might skip valid changes if the cycle is complex.
                 visited.add(changeId);
                 // Consider how to handle cycles more gracefully if needed.
                return;
            }

            const change = changeMap.get(changeId);
            if (!change) {
                 console.warn(chalk.yellow(`Dependency ${changeId} not found in the current batch of changes to sort. Skipping.`));
                 visited.add(changeId); // Mark as visited so we don't try again
                 return;
            }

            visiting.add(changeId);

            if (change.dependsOn) {
                for (const depId of change.dependsOn) {
                    // Only visit if the dependency exists in the current batch
                    if (changeMap.has(depId)) {
                         visit(depId);
                    } else {
                        // Dependency is likely from a previous batch or phase - assume it's met
                         console.log(chalk.blue(`Dependency ${depId} for change ${changeId} not in current sort batch, assuming met.`));
                    }
                }
            }
            
            visiting.delete(changeId); // Remove from recursion stack
            visited.add(changeId);     // Mark as permanently visited
            sorted.push(change);       // Add to sorted list
        };

        for (const change of changes) {
            if (!visited.has(change.id)) {
                visit(change.id);
            }
        }

        return sorted;
    }

    /**
     * Execute a single change: resolve references, call Linear API, handle result/errors.
     * @param change Change object
     * @param processedChanges Map of previously processed changes (used for reference resolution)
     * @returns Result of the operation
     */
    private async executeChange(
        change: StagedChange,
        processedChanges: Map<string, ChangeResult>
    ): Promise<ChangeResult> {
        try {
            console.log(chalk.blueBright(`\n--- EXECUTING CHANGE ${change.id} ---`));
            console.log(`  Operation: ${change.operation}, Entity Type: ${change.entityType}`);
            console.log(`  Original payload: ${JSON.stringify(change.payload, null, 2)}`);
            
            // Resolve references using the TemporaryIdMapper
            console.log(chalk.cyan("  Resolving references..."));
            const resolvedPayload = await this.temporaryIdMapper.resolveReferences(change.payload, processedChanges);
            console.log(chalk.cyan("  Reference resolution complete."));
            console.log(`  Resolved payload: ${JSON.stringify(resolvedPayload, null, 2)}`);

            // Remove temporary ID from create payloads if present
            let finalPayload = { ...resolvedPayload };
            if (change.operation === 'create' && finalPayload.id && (typeof finalPayload.id === 'string' && (finalPayload.id.startsWith('TMP-') || finalPayload.id.startsWith('TMPC-')))) {
                console.log(chalk.yellow(`  Removing temporary ID '${finalPayload.id}' from create payload.`));
                delete finalPayload.id;
            }

            // Special handling/validation for relationship links
            if (change.entityType === 'relationship' && change.operation === 'link') {
                 try {
                     this.temporaryIdMapper.validateRelationshipIds(finalPayload);
                 } catch (validationError) {
                     console.error(chalk.red(`  Relationship validation failed for change ${change.id}:`), validationError);
                     return { change, success: false, error: validationError };
                 }
            }

            console.log(chalk.magenta(`  Making API call: ${change.entityType}.${change.operation}(...)`));

            // Execute the operation using the resolved payload
            const result = await executeOperation(
                this.linearClient,
                change.entityType,
                change.operation,
                finalPayload
            );
            console.log(chalk.green(`  API call successful for ${change.id}. Result ID: ${result?.id || 'N/A'}`));

            // Handle post-creation steps (ID mapping, registration)
            if (change.operation === 'create' && (change.entityType === 'issue' || change.entityType === 'project') && result?.id && result?.identifier) {
                console.log(`  Post-creation steps for ${change.entityType} ${result.id} (${result.identifier})...`);
                
                // FIRST: Ensure the internal temporary ID exists/is generated by IdRegistry
                // This also injects it into change.payload.internalId if generated.
                const internalId = this.idRegistry.extractInternalIdFromChange(change, () => `TMP-${this.getNextIssueCounter()}`);
                console.log(`  (Internal/Temporary ID ensured/generated: ${internalId || 'none'})`);

                // SECOND: Store mapping in TemporaryIdMapper (for resolving dependencies within *this* batch)
                this.temporaryIdMapper.storeIdMapping(change, result);

                // THIRD: Use the (now guaranteed) internalId to update the persistent IdMapper
                const originalTemporaryId = change.payload?.internalId as TemporaryFriendlyId | undefined;

                if (originalTemporaryId && isTemporaryFriendlyId(originalTemporaryId)) {
                    console.log(`  Original temporary ID found in payload: ${originalTemporaryId}`);
                    // Update the main IdMapper with the new Linear IDs using the original temporary ID
                    console.log(chalk.cyan(`  Updating main IdMapper for ${originalTemporaryId} -> ${result.identifier} (${result.id})`));
                    const updateSuccess = this.idMapper.updateWithLinearIds(
                        change.entityType as EntityType, // Cast to EntityType after checking
                        originalTemporaryId, 
                        asLinearGuid(result.id), 
                        asLinearFriendlyId(result.identifier)
                    );
                    if (!updateSuccess) {
                        console.warn(chalk.yellow(`  Warning: Failed to update main IdMapper for temporary ID ${originalTemporaryId}. Mapping might be inconsistent.`));
                    } else {
                         console.log(chalk.cyan(`  Main IdMapper updated successfully.`));
                    }
                } else {
                     // This branch should ideally not be hit now if extractInternalIdFromChange works
                     console.warn(chalk.red(`  Error: Could not determine original temporary ID even after calling extractInternalIdFromChange for ${change.id}. Main IdMapper not updated.`)); 
                     console.warn(chalk.red(`  Payload was: ${JSON.stringify(change.payload)}`));
                }
            }

            console.log(chalk.blueBright(`--- CHANGE ${change.id} EXECUTION COMPLETE ---`));

            return {
                change,
                success: true,
                result
            };
        } catch (error) {
            console.error(chalk.red(`  Failed to execute change ${change.id}: ${change.operation} ${change.entityType}`));
            console.error(chalk.red(error));
            console.log(chalk.blueBright(`--- CHANGE ${change.id} EXECUTION FAILED ---`));
            return {
                change,
                success: false,
                error: error instanceof Error ? error : new Error(String(error)) // Ensure error is Error type
            };
        }
    }
} 