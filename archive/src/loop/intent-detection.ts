import { AgentState } from '../state/types';
import { AgentIntent } from '../types/agent-output';

export function determineIntentFromToolCall(
  toolName: string | undefined,
  isPreExecution: boolean = true,
  agentState: AgentState,
  hasError: boolean = false
): AgentIntent {
  if (hasError) return 'TOOL_ERROR';

  const hasPlan = !!agentState.current_plan;
  const planIsAwaitingConfirmation = hasPlan && agentState.current_plan.overall_status === 'confirmation_awaited';
  const hasStagedChanges = agentState.staged_changes.length > 0;

  if (isPreExecution) {
    switch (toolName) {
      case 'apply_staged_changes':
        return 'AWAITING_CONFIRMATION';
      case 'linear_search':
      case 'linear_get_details':
        return hasPlan ? 'TOOL_CALLED' : 'INFORMATION_PROVIDED';
      case 'stage_add':
      case 'stage_update':
      case 'stage_remove':
        return 'TOOL_CALLED';
      case 'stage_list':
        return 'INFORMATION_PROVIDED';
      default:
        return 'TOOL_CALLED';
    }
  } else {
    switch (toolName) {
      case 'apply_staged_changes':
        return 'ACTION_COMPLETED';
      case 'linear_search':
      case 'linear_get_details':
        if (hasPlan) {
          if (planIsAwaitingConfirmation) return 'AWAITING_CONFIRMATION';
          return 'ACTION_COMPLETED';
        }
        return 'INFORMATION_PROVIDED';
      case 'stage_add':
      case 'stage_update':
        return hasStagedChanges ? 'AWAITING_CONFIRMATION' : 'ACTION_COMPLETED';
      case 'stage_remove':
        return 'ACTION_COMPLETED';
      case 'stage_list':
        return hasStagedChanges ? 'AWAITING_CONFIRMATION' : 'INFORMATION_PROVIDED';
      default:
        return 'ACTION_COMPLETED';
    }
  }
}

export function determineIntentFromUserInput(userInput: string, agentState: AgentState): AgentIntent {
  const lowerInput = userInput.toLowerCase().trim();
  const isConfirmation =
    lowerInput === 'yes' ||
    lowerInput === 'ok' ||
    lowerInput === 'okay' ||
    lowerInput === 'go' ||
    lowerInput === 'confirm' ||
    lowerInput.includes('go ahead') ||
    lowerInput.includes('sounds good') ||
    (lowerInput.includes('apply') && lowerInput.includes('stage'));
  const isRejection =
    lowerInput === 'no' ||
    lowerInput === 'cancel' ||
    lowerInput === 'stop' ||
    lowerInput.includes("don't") ||
    lowerInput.includes('do not');
  const isQuestion =
    lowerInput.includes('?') ||
    lowerInput.startsWith('what') ||
    lowerInput.startsWith('how') ||
    lowerInput.startsWith('why') ||
    lowerInput.startsWith('when') ||
    lowerInput.startsWith('where') ||
    lowerInput.startsWith('who') ||
    lowerInput.startsWith('which') ||
    lowerInput.startsWith('can you') ||
    lowerInput.startsWith('could you');
  const hasStagedChanges = agentState.staged_changes.length > 0;
  const hasPlan = !!agentState.current_plan;

  if (isRejection && (hasStagedChanges || hasPlan)) {
    return 'CLARIFICATION_NEEDED';
  } else if (isConfirmation && hasStagedChanges) {
    return 'AWAITING_CONFIRMATION';
  } else if (isQuestion) {
    return 'CLARIFICATION_NEEDED';
  } else if (hasPlan) {
    return 'ACTION_COMPLETED';
  } else {
    return 'INFORMATION_PROVIDED';
  }
}

export function determinePendingActionType(toolName: string | undefined): string {
  switch (toolName) {
    case 'apply_staged_changes':
      return 'APPLY_STAGED_CHANGES';
    case 'stage_add':
    case 'stage_update':
    case 'stage_remove':
      return 'STAGING_CHANGE';
    case 'linear_search':
      return 'SEARCHING_LINEAR';
    case 'linear_get_details':
      return 'FETCHING_DETAILS';
    default:
      return 'CALL_TOOL';
  }
} 