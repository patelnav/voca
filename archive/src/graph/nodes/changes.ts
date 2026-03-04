import type { NodeDependencies } from '../types';
import type { VocaAgentStateType } from '../graph'; // Import the internal state type
import { type ApplyChangesResult, ApplyOutcome } from '@/linear/changes/change-applier'; // <-- Import new types
import chalk from 'chalk'; // <-- For better logging

/**
 * Node: displayChangesNode
 * Formats and displays the currently staged changes from the LinearChangeManager.
 */
export async function displayChangesNode(
    state: VocaAgentStateType, // Removed underscore, state.conversationalPart is used
    dependencies: Pick<NodeDependencies, 'linearChangeManager'>
): Promise<Partial<VocaAgentStateType>> { // Changed from AgentState
    const { linearChangeManager } = dependencies;
    const { conversationalPart } = state; // Get conversational part from state

    console.log("[Node: displayChanges] Formatting staged changes from manager for display.");

    try {
      const currentStagedChanges = linearChangeManager.getChanges();

      if (!currentStagedChanges || currentStagedChanges.length === 0) {
          return { responseToUser: "No changes are currently staged.", error: null };
      }

      // TODO: Replace with actual formatting logic from LinearHandler
      // const formattedChanges = await linearHandler.formatStagedChangesForDisplay(currentStagedChanges);
      const formattedChanges = JSON.stringify(currentStagedChanges, null, 2); // Placeholder formatting
      
      // Construct the confirmation message using conversational part and formatted changes
      const responseToUser = `${conversationalPart || 'Okay, here are the proposed changes:'}\n\n${formattedChanges}\n\nDo you want to apply these changes? (confirm/cancel)`;

      console.log("[Node: displayChanges] Formatted changes successfully (using placeholder).");
      return { responseToUser, error: null };

    } catch (error: any) {
        const errorMessage = `Error in displayChangesNode: ${error.message}`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
}

/**
 * Node: applyChangesNode
 * Applies the staged changes held by LinearChangeManager.
 */
export async function applyChangesNode(
    state: VocaAgentStateType, // Changed from AgentState
    dependencies: Pick<NodeDependencies, 'linearChangeManager'>
): Promise<Partial<VocaAgentStateType>> { // Changed from AgentState
    const { confirmationNeeded } = state; // Read confirmation flag from state
    const { linearChangeManager } = dependencies;
    
    try {
        const changesToApply = linearChangeManager.getChanges(); // Get changes from manager
        console.log(`[Node: applyChanges] Received apply request. Confirmation needed: ${confirmationNeeded}, Manager changes count: ${changesToApply?.length ?? 0}`);

        if (!confirmationNeeded) {
            return { responseToUser: "No changes were staged or confirmation was not pending. Please propose changes first.", stagedChanges: null, confirmationNeeded: false, error: null };
        }
        if (!changesToApply || changesToApply.length === 0) {
             return { responseToUser: "No changes found in the manager to apply.", stagedChanges: null, confirmationNeeded: false, error: null };
        }

        console.log(chalk.blue(`[Node: applyChanges] Applying ${changesToApply.length} staged changes from manager...`));
        // Call applyChanges - it now returns the structured ApplyChangesResult
        const applyResult: ApplyChangesResult = await linearChangeManager.applyChanges(); 

        console.log(chalk.blue(`[Node: applyChanges] Application process finished. Outcome: ${applyResult.outcome}, Success: ${applyResult.success}`));
        console.log(chalk.gray(`[Node: applyChanges] Detailed results: ${JSON.stringify(applyResult.results, null, 2)}`));

        // --- Format a user-friendly response based on ApplyChangesResult --- 
        let formattedResponseParts: string[] = [];
        const numAttempted = applyResult.results.length;
        const numSucceeded = applyResult.results.filter(r => r.status === 'succeeded').length;
        const numFailed = applyResult.results.filter(r => r.status === 'failed').length;
        const numSkipped = applyResult.results.filter(r => r.status === 'skipped').length;

        // Overall Summary
        if (applyResult.outcome === ApplyOutcome.SUCCESS_ALL_APPLIED) {
            formattedResponseParts.push(`Successfully applied all ${numSucceeded} change(s).`);
        } else if (applyResult.outcome === ApplyOutcome.SUCCESS_PARTIAL_APPLIED) {
            formattedResponseParts.push(`Partially applied changes: ${numSucceeded} succeeded, ${numFailed} failed, ${numSkipped} skipped.`);
        } else if (applyResult.outcome === ApplyOutcome.FAILURE_NONE_APPLIED) {
            formattedResponseParts.push(`Failed to apply any changes: ${numFailed} failed, ${numSkipped} skipped.`);
        } else if (applyResult.outcome === ApplyOutcome.ERROR_DEPENDENCY) {
             formattedResponseParts.push(`Could not apply changes due to dependency issues. ${numSkipped} skipped, ${numFailed} failed.`);
        } else if (applyResult.outcome === ApplyOutcome.ERROR_PRECONDITION && applyResult.message) {
            // Already handled above, but as a fallback
            formattedResponseParts.push(`Could not apply changes: ${applyResult.message}`);
        } else {
             formattedResponseParts.push(`An unexpected issue occurred during change application. Outcome: ${applyResult.outcome}.`);
             if (applyResult.message) formattedResponseParts.push(`Details: ${applyResult.message}`);
        }

        // Add details for failures/skips if there were any
        if (numFailed > 0 || numSkipped > 0) {
            formattedResponseParts.push("\nDetails:");
            applyResult.results.forEach(item => {
                if (item.status === 'failed') {
                    formattedResponseParts.push(`- Failed: [${item.change.id}] ${item.change.description} - Reason: ${item.reason || 'Unknown error'}`);
                } else if (item.status === 'skipped') {
                    formattedResponseParts.push(`- Skipped: [${item.change.id}] ${item.change.description} - Reason: ${item.reason || 'Unknown reason'}`);
                }
            });
        }

        let responseToUser = formattedResponseParts.join('\n');
        // --- End formatting --- 

        console.log(chalk.blue(`[Node: applyChanges] Generated response: ${responseToUser}`));

        // Clear state *only* if the operation was considered successful overall (meaning at least one change applied)
        // And reset confirmation flag regardless of success/failure, as the apply *attempt* happened.
        const stateUpdate: Partial<VocaAgentStateType> = {
            responseToUser,
            confirmationNeeded: false, // Reset confirmation flag after attempt
            error: null // Clear previous errors
        };

        if (applyResult.success) {
            // If partially successful, the manager already removed the *successful* changes.
            // We need to get the remaining changes from the manager to update the state accurately.
            const remainingChanges = linearChangeManager.getChanges();
            stateUpdate.stagedChanges = remainingChanges.length > 0 ? remainingChanges : null;
             console.log(chalk.green(`[Node: applyChanges] Apply successful (partially or fully). Updating state. Remaining staged changes: ${remainingChanges.length}`));
        } else {
            // If the overall operation failed (no changes applied), keep the existing staged changes in the state.
             console.log(chalk.yellow(`[Node: applyChanges] Apply failed. Keeping existing staged changes in state.`));
             // stateUpdate.stagedChanges = state.stagedChanges; // No need to set, state remains unchanged
              if (applyResult.message) {
                  stateUpdate.error = `Apply Changes Failed: ${applyResult.message}`; // Report top-level error if available
              } else {
                  stateUpdate.error = `Apply Changes Failed. Outcome: ${applyResult.outcome}. See details above.`;
              }
        }

        return stateUpdate;

    } catch (error: any) {
        const errorMessage = `Error in applyChangesNode: ${error.message}`;
        console.error(errorMessage);
        // Don't clear state on error, just return the error message
        return { error: errorMessage };
    }
}


/**
 * Node: clearChangesNode
 * Clears staged changes in the LinearChangeManager and the AgentState.
 */
export async function clearChangesNode(
    _state: VocaAgentStateType, // Prefix unused parameter
    dependencies: Pick<NodeDependencies, 'linearChangeManager'> // Manager dependency needed now
): Promise<Partial<VocaAgentStateType>> { // Changed from AgentState
    const { linearChangeManager } = dependencies;
    console.log("[Node: clearChanges] Clearing staged changes in manager and state.");

    // <<< Added try/catch block >>>
    try {
        // <<< Removed inner try/catch >>>
        /*
        try {
        */
            // Clear manager's internal list first
            await linearChangeManager.clearChanges();
            console.log("[Node: clearChanges] Changes cleared successfully from manager.");

            const responseToUser = "Staged changes cleared.";

            // Clear state as well
            return {
                responseToUser,
                stagedChanges: null, // Ensure state reflects clearance
                confirmationNeeded: false, // Reset flag
                error: null
            };
        /*
         } catch (error: any) {
             const errorMessage = `Error in clearChangesNode: ${error.message}`;
             console.error(errorMessage);
             // If manager failed, don't clear state?
             return { responseToUser: errorMessage, error: errorMessage };
         }
         */ // <<< Restore original comment block end
    } catch (error: any) {
        const errorMessage = `Error in clearChangesNode: ${error.message}`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
}