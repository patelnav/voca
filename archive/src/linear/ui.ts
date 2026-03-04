import { type LinearChangeManager, type StagedChange /*, type ChangeResult */ } from '@/linear/changes'; // Commented out ChangeResult
import { type ApplyChangesResult, ApplyOutcome } from '@/linear/changes/change-applier'; // Import new types

/**
 * Format a staged change for display in a user interface
 * @param change The staged change to format
 * @param index The index of the change in the list
 * @returns A string representation of the change
 */
export function formatChangeForDisplay(change: StagedChange, index: number): string {
  const { operation, entityType, payload } = change;

  let details = '';

  switch (entityType) {
    case 'issue':
      if (operation === 'create') {
        details = `Create issue "${payload.title}" in project ${payload.projectId}`;
        if (payload.description) {
          details += `\n   Description: ${truncateText(payload.description, 50)}`;
        }
      } else if (operation === 'update') {
        details = `Update issue ${payload.issueId}`;
        if (payload.title) {
          details += `\n   New title: "${payload.title}"`;
        }
        if (payload.description) {
          details += `\n   New description: ${truncateText(payload.description, 50)}`;
        }
      } else if (operation === 'delete') {
        details = `Delete issue ${payload.issueId}`;
      }
      break;

    case 'relationship':
      if (operation === 'link') {
        details = `Link issue ${payload.childId} as a subtask of ${payload.parentId}`;
      }
      break;

    case 'project':
      if (operation === 'create') {
        details = `Create project "${payload.name}"`;
      } else if (operation === 'update') {
        details = `Update project ${payload.projectId}`;
      }
      break;

    case 'comment':
      if (operation === 'create') {
        details = `Add comment to issue ${payload.issueId}`;
      }
      break;
  }

  return `${index + 1}. [${operation.toUpperCase()} ${entityType.toUpperCase()}] ${details}`;
}

/**
 * Format a list of staged changes for display
 * @param changes The list of staged changes
 * @returns A formatted string representation of all changes
 */
export function formatChangesForDisplay(changes: StagedChange[]): string {
  if (changes.length === 0) {
    return 'No staged changes.';
  }

  return changes.map((change, index) => formatChangeForDisplay(change, index)).join('\n');
}

/**
 * Format the results of applying changes for display
 * @param applyResult The results of applying changes
 * @returns A formatted string representation of the results
 */
export function formatChangeResultsForDisplay(applyResult: ApplyChangesResult): string {
  const { success, outcome, results, message } = applyResult;

  if (results.length === 0 && outcome === ApplyOutcome.ERROR_PRECONDITION) {
    return message || 'No changes were staged to apply.';
  }
  if (results.length === 0) { // Should not happen if precondition didn't catch it
    return 'No results to display.';
  }

  const numAttempted = results.length;
  const numSucceeded = results.filter(r => r.status === 'succeeded').length;
  const numFailed = results.filter(r => r.status === 'failed').length;
  const numSkipped = results.filter(r => r.status === 'skipped').length;

  let outputParts: string[] = [];

  // Overall Summary based on outcome
  if (outcome === ApplyOutcome.SUCCESS_ALL_APPLIED) {
    outputParts.push(`✅ Successfully applied all ${numSucceeded} change(s).`);
  } else if (outcome === ApplyOutcome.SUCCESS_PARTIAL_APPLIED) {
    outputParts.push(`⚠️ Partially applied changes: ${numSucceeded} succeeded, ${numFailed} failed, ${numSkipped} skipped.`);
  } else if (outcome === ApplyOutcome.FAILURE_NONE_APPLIED) {
    outputParts.push(`❌ Failed to apply any changes: ${numFailed} failed, ${numSkipped} skipped.`);
  } else if (outcome === ApplyOutcome.ERROR_DEPENDENCY) {
      outputParts.push(`❌ Could not apply changes due to dependency issues. ${numSkipped} skipped, ${numFailed} failed.`);
  } else if (outcome === ApplyOutcome.ERROR_PRECONDITION && message) {
      outputParts.push(`❌ Could not apply changes: ${message}`);
  } else {
      outputParts.push(`❌ An unexpected issue occurred. Outcome: ${outcome}.`);
      if (message) outputParts.push(`   Details: ${message}`);
  }

  // Add details for individual items (especially failures/skips)
  if (numFailed > 0 || numSkipped > 0 || numSucceeded < numAttempted) { // Show details unless *all* succeeded
     outputParts.push('\n--- Details ---');
     results.forEach((item, index) => {
         const { change, status, reason, newId } = item;
         const prefix = status === 'succeeded' ? '✅' : (status === 'failed' ? '❌' : '➖');
         const baseText = formatChangeForDisplay(change, index);

         let detailLine = `${prefix} ${baseText}`;
         if (status === 'succeeded' && newId) {
             // Optionally add new ID info for success cases
             // detailLine += ` (New ID: ${newId})`; 
         }
         if (status === 'failed' || status === 'skipped') {
           detailLine += `\n   Reason: ${reason || 'Unknown'}`;
         }
         outputParts.push(detailLine);
     });
  }

  return outputParts.join('\n');
}

/**
 * Generate a request for LLM to process using Linear
 * @param userInput The user's natural language request
 * @param changeManager The LinearChangeManager instance
 * @param llmResponse The LLM's JSON response string
 * @returns A formatted result for display
 */
export async function processLLMResponse(
  changeManager: LinearChangeManager,
  llmResponse: string
): Promise<string> {
  try {
    // This would call parseLLMResponseToChanges in a real integration
    const { changes, explanation } = JSON.parse(llmResponse);

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return 'No changes to apply from LLM response.';
    }

    // Add the changes to the change manager
    changeManager.addChanges(changes);

    // Return a formatted confirmation
    return `
Proposed changes from your request (${changes.length} total):

${formatChangesForDisplay(changeManager.getChanges())}

Explanation: ${explanation || 'No explanation provided.'}

You can review these changes and apply them when ready.
`;
  } catch (error) {
    return `Error processing LLM response: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Apply staged changes and format the results
 * @param changeManager The LinearChangeManager instance
 * @returns A formatted string with the results
 */
export async function applyAndFormatChanges(changeManager: LinearChangeManager): Promise<string> {
  try {
    const results: ApplyChangesResult = await changeManager.applyChanges(); // <-- results is ApplyChangesResult
    return formatChangeResultsForDisplay(results); // <-- Pass the structured result
  } catch (error) {
    return `Error applying changes: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Helper function to truncate text to a specified length
 * @param text The text to truncate
 * @param maxLength The maximum length
 * @returns Truncated text
 */
function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}
