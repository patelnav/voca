import type { AgentState, StagedChange } from '@/state/types';
import { Logger } from '@/utils/logger';
import type { TemporaryFriendlyId } from '@/types/linear-ids';
import { isTemporaryFriendlyId } from '@/types/linear-ids';
import { produce } from 'immer';
import { type FunctionDeclaration, Type } from '@google/genai';

const logger = Logger.getInstance();

// --- New Structured Return Type ---
export enum StageAddOutcome {
  SUCCESS_ADDED = 'SUCCESS_ADDED',
  SUCCESS_REPLACED_EXISTING = 'SUCCESS_REPLACED_EXISTING',
  ERROR_INVALID_TEMP_ID_FORMAT = 'ERROR_INVALID_TEMP_ID_FORMAT',
  ERROR_DUPLICATE_TEMP_ID = 'ERROR_DUPLICATE_TEMP_ID',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
}

export interface StageAddResult {
  success: boolean;
  newState: AgentState; // Still need to return the updated state
  outcome: StageAddOutcome;
  tempId?: TemporaryFriendlyId; // Include the tempId if one was assigned/used
  message?: string; // Optional field for the raw error message in case of failure
}
// --- End New Structured Return Type ---

// --- New Structured Return Type for stage_list ---
export interface StageListResult {
  success: boolean;
  stagedChanges: readonly StagedChange[]; // Use readonly array type
  message?: string; // Optional field for errors
}
// --- End New Structured Return Type ---

// --- New Structured Return Type for stage_remove ---
export enum StageRemoveOutcome {
  SUCCESS_REMOVED = 'SUCCESS_REMOVED',
  ERROR_NOT_FOUND = 'ERROR_NOT_FOUND',
  ERROR_INVALID_TEMP_ID_FORMAT = 'ERROR_INVALID_TEMP_ID_FORMAT',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
}

export interface StageRemoveResult {
  success: boolean;
  newState: AgentState;
  outcome: StageRemoveOutcome;
  removedTempId?: TemporaryFriendlyId; // Include the ID if successful
  message?: string; // For errors
}
// --- End New Structured Return Type ---

// --- New Structured Return Type for stage_update ---
export enum StageUpdateOutcome {
  SUCCESS_UPDATED = 'SUCCESS_UPDATED',
  ERROR_NOT_FOUND = 'ERROR_NOT_FOUND',
  ERROR_MISSING_TEMP_ID = 'ERROR_MISSING_TEMP_ID',
  ERROR_INVALID_TEMP_ID_FORMAT = 'ERROR_INVALID_TEMP_ID_FORMAT',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
}

export interface StageUpdateResult {
  success: boolean;
  newState: AgentState;
  outcome: StageUpdateOutcome;
  updatedTempId?: TemporaryFriendlyId; // Include the ID if successful
  message?: string; // For errors
}
// --- End New Structured Return Type ---

// --- BEGIN TOOL SCHEMA: stage_add ---
export const stageAddToolSchema: FunctionDeclaration = {
  name: 'stage_add',
  description: 
      'Adds a single proposed change (e.g., create issue, update issue) to a staging area. ' +
      'Requires a \'change\' object containing the operation type (opType) and data. ' +
      'If the change is for a new entity, provide a temporary ID (e.g., TMP-123) in \'tempId\'. ' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      change: {
        type: Type.OBJECT,
        description: 'The StagedChange object representing the operation to stage.'
        // Note: We cannot easily define the nested StagedChange structure here.
        // The LLM will need to construct this based on the StagedChange type definition.
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Okay, I\'ll stage that new issue.'",
        nullable: true,
      },
    },
    required: ['change']
  }
};
// --- END TOOL SCHEMA: stage_add ---

/**
 * Adds a new proposed change to the agent's staged changes list.
 * Modifies the state object directly.
 */
export function stage_add(
  currentState: AgentState,
  change: StagedChange,
): StageAddResult {
  logger.logCli(`Tool: stage_add called for session ${currentState.sessionId}`);
  try {
    // Log the full change object to help debug LLM issues
    logger.logCli(`Tool: stage_add received change object: ${JSON.stringify(change)}`);
    
    let mutableChange = { ...change }; // Create a mutable copy for validation logic

    // For update operations on existing entities (where data.id exists), tempId is optional
    // If provided but invalid, warn and remove it rather than rejecting
    if (mutableChange.tempId && !isTemporaryFriendlyId(mutableChange.tempId)) {
      const isExistingEntityUpdate = mutableChange.opType?.includes('update') && mutableChange.data?.id;
      
      if (isExistingEntityUpdate) {
        logger.logCli(`Warning: Invalid tempId format "${mutableChange.tempId}" provided for ${mutableChange.opType}. Ignoring tempId as it's not needed for updates to existing entities.`);
        mutableChange.tempId = undefined; // Remove the invalid tempId
      } else {
        const errorMessage = `Invalid temporary ID format provided: ${mutableChange.tempId}. Must be in format TMP-123.`;
        logger.logCli(`Tool: stage_add error - ${errorMessage}`);
        return {
          success: false,
          newState: currentState,
          outcome: StageAddOutcome.ERROR_INVALID_TEMP_ID_FORMAT,
          message: errorMessage,
        };
      }
    }

    const finalChange = mutableChange; // Use the (potentially modified) mutableChange
    let outcome: StageAddOutcome = StageAddOutcome.SUCCESS_ADDED; // Default success outcome

    const newState = produce(currentState, draftState => {
      // Prevent adding duplicate tempIds
      if (finalChange.tempId && draftState.staged_changes.some(c => c.tempId === finalChange.tempId)) {
        // This error case should ideally be caught before produce, or handled by returning original state + error string
        // For now, we will throw an error that will be caught by the try/catch block
        throw new Error(`A staged change with temporary ID ${finalChange.tempId} already exists. Use stage_update to modify it.`);
      }

      // --- BEGIN ENHANCEMENT: Prevent duplicate updates for the same entity ---
      if (finalChange.opType?.includes('update') && finalChange.data?.id) {
        const newChangeTargetId = finalChange.data.id as string;
        let newChangeTargetGuid: string | undefined = undefined;

        if (isTemporaryFriendlyId(newChangeTargetId)) {
          newChangeTargetGuid = draftState.id_map[newChangeTargetId];
          if (!newChangeTargetGuid) {
            logger.logCli(`Tool: stage_add - New update change targets unmapped tempId ${newChangeTargetId}. Proceeding to add.`);
          }
        } else {
          newChangeTargetGuid = newChangeTargetId;
        }

        if (newChangeTargetGuid) {
          const existingChangeIndex = draftState.staged_changes.findIndex(existingChange => {
            if (existingChange.opType === finalChange.opType && existingChange.data?.id) {
              const existingChangeTargetId = existingChange.data.id as string;
              let currentExistingChangeTargetGuid: string | undefined = undefined;
              if (isTemporaryFriendlyId(existingChangeTargetId)) {
                currentExistingChangeTargetGuid = draftState.id_map[existingChangeTargetId];
              } else {
                currentExistingChangeTargetGuid = existingChangeTargetId;
              }
              return currentExistingChangeTargetGuid && currentExistingChangeTargetGuid === newChangeTargetGuid;
            }
            return false;
          });

          if (existingChangeIndex !== -1) {
            logger.logCli(`Tool: stage_add - Replacing existing staged ${draftState.staged_changes[existingChangeIndex].opType} for entity ${newChangeTargetGuid} with new update (new tempId: ${finalChange.tempId}, old tempId: ${draftState.staged_changes[existingChangeIndex].tempId}).`);
            draftState.staged_changes[existingChangeIndex] = finalChange; // Replace existing change in draft
            outcome = StageAddOutcome.SUCCESS_REPLACED_EXISTING; // Update outcome
          } else {
            draftState.staged_changes.push(finalChange); // Add new change to draft
          }
        } else {
          draftState.staged_changes.push(finalChange); // Add new change if target GUID couldn't be resolved (e.g. update for a new temp item)
        }
      } else {
        draftState.staged_changes.push(finalChange); // Add new change to draft for non-update ops or updates without data.id
      }
    });

    logger.logCli(`Tool: stage_add success for session ${newState.sessionId}. Outcome: ${outcome}. Change: ${JSON.stringify(finalChange)}`);
    return {
      success: true,
      newState,
      outcome: outcome,
      tempId: finalChange.tempId,
    };
  } catch (error: any) {
    logger.logError(error, `Tool: stage_add error for session ${currentState.sessionId}`);
    let specificOutcome = StageAddOutcome.ERROR_UNKNOWN;
    if (error.message?.includes('already exists')) {
      specificOutcome = StageAddOutcome.ERROR_DUPLICATE_TEMP_ID;
    }
    return {
      success: false,
      newState: currentState,
      outcome: specificOutcome,
      message: error.message || 'An unknown error occurred during staging.',
    };
  }
}

// --- BEGIN TOOL SCHEMA: stage_list ---
export const stageListToolSchema: FunctionDeclaration = {
  name: 'stage_list',
  description: 
      'Lists all changes currently in the staging area. Does not take any parameters.',
  parameters: { 
    type: Type.OBJECT, 
    properties: {
        pre_execution_narration: {
            type: Type.STRING,
            description: "Optional. Short message before execution. Example: 'Let me check what\'s staged.'",
            nullable: true,
        },
    }, 
    required: [] 
  }
};
// --- END TOOL SCHEMA: stage_list ---

/**
 * Lists the currently staged changes from the agent state.
 */
export function stage_list(state: AgentState): StageListResult {
  logger.logCli(`Tool: stage_list called for session ${state.sessionId}`);
  try {
    logger.logCli(`Tool: stage_list success for session ${state.sessionId}. Found ${state.staged_changes.length} changes.`);
    return {
      success: true,
      stagedChanges: state.staged_changes,
    };
  } catch (error: any) {
    logger.logError(error, `Tool: stage_list error for session ${state.sessionId}`);
    return {
      success: false,
      stagedChanges: [],
      message: `Error listing staged changes: ${error.message}`,
    };
  }
}

// --- BEGIN TOOL SCHEMA: stage_remove ---
export const stageRemoveToolSchema: FunctionDeclaration = {
  name: 'stage_remove',
  description: 
      'Removes a previously staged change using its temporary ID (tempId, e.g., TMP-123).' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tempId: {
        type: Type.STRING,
        description: 'The temporary ID (e.g., TMP-123) of the change to remove.'
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Sure, I\'ll remove that staged item.'",
        nullable: true,
      },
    },
    required: ['tempId']
  }
};
// --- END TOOL SCHEMA: stage_remove ---

/**
 * Removes a staged change identified by its temporary ID.
 * Modifies the state object directly.
 */
export function stage_remove(
  currentState: AgentState,
  tempId: TemporaryFriendlyId,
): StageRemoveResult {
  logger.logCli(`Tool: stage_remove called for session ${currentState.sessionId}, tempId: ${tempId}`);

  if (!isTemporaryFriendlyId(tempId)) {
    const message = `Invalid temporary ID format provided: ${tempId}. Must be in format TMP-123.`;
    logger.logCli(`Tool: stage_remove error - ${message}`);
    return {
      success: false,
      newState: currentState,
      outcome: StageRemoveOutcome.ERROR_INVALID_TEMP_ID_FORMAT,
      message: message,
    };
  }

  try {
    let foundAndRemoved = false;
    const newState = produce(currentState, draftState => {
      const initialLength = draftState.staged_changes.length;
      draftState.staged_changes = draftState.staged_changes.filter(
        (change) => change.tempId !== tempId,
      );
      if (draftState.staged_changes.length < initialLength) {
        foundAndRemoved = true;
      }
    });

    if (!foundAndRemoved) {
      logger.logCli(`[WARN] Tool: stage_remove - No change found with tempId ${tempId} for session ${currentState.sessionId}.`);
      return {
        success: false,
        newState: currentState,
        outcome: StageRemoveOutcome.ERROR_NOT_FOUND,
        message: `No staged change found with temporary ID: ${tempId}.`,
      };
    }

    logger.logCli(`Tool: stage_remove success for session ${currentState.sessionId}, removed tempId: ${tempId}.`);
    return {
      success: true,
      newState,
      outcome: StageRemoveOutcome.SUCCESS_REMOVED,
      removedTempId: tempId,
    };
  } catch (error: any) {
    logger.logError(error, `Tool: stage_remove error for session ${currentState.sessionId}, tempId: ${tempId}`);
    return {
      success: false,
      newState: currentState,
      outcome: StageRemoveOutcome.ERROR_UNKNOWN,
      message: `Error removing staged change: ${error.message}`,
    };
  }
}

// --- BEGIN TOOL SCHEMA: stage_update ---
export const stageUpdateToolSchema: FunctionDeclaration = {
  name: 'stage_update',
  description: 
      'Updates an existing staged change identified by its temporary ID (tempId). ' +
      'Requires a \'changeToUpdate\' object which includes the \'tempId\' and the new data for the change. ' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      changeToUpdate: {
        type: Type.OBJECT,
        description: 'The StagedChange object containing the tempId to identify the change and the new data to apply.'
        // Note: Similar to stage_add, nested StagedChange structure is complex for schema.
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Okay, let me update that staged change.'",
        nullable: true,
      },
    },
    required: ['changeToUpdate']
  }
};
// --- END TOOL SCHEMA: stage_update ---

/**
 * Updates an existing staged change identified by its temporary ID.
 * Modifies the state object directly.
 */
export function stage_update(
  currentState: AgentState,
  changeToUpdate: StagedChange,
): StageUpdateResult {
  logger.logCli(`Tool: stage_update called for session ${currentState.sessionId}, tempId: ${changeToUpdate.tempId}`);

  const tempId = changeToUpdate.tempId;

  if (!tempId) {
    const message = 'stage_update requires a temporary ID (tempId) in the change object.';
    logger.logCli(`Tool: stage_update error - ${message}`);
    return {
      success: false,
      newState: currentState,
      outcome: StageUpdateOutcome.ERROR_MISSING_TEMP_ID,
      message: message,
    };
  }

  if (!isTemporaryFriendlyId(tempId)) {
    const message = `Invalid temporary ID format provided: ${tempId}. Must be in format TMP-123.`;
    logger.logCli(`Tool: stage_update error - ${message}`);
    return {
      success: false,
      newState: currentState,
      outcome: StageUpdateOutcome.ERROR_INVALID_TEMP_ID_FORMAT,
      message: message,
    };
  }

  try {
    let foundAndUpdated = false;
    const newState = produce(currentState, draftState => {
      const changeIndex = draftState.staged_changes.findIndex(
        (change) => change.tempId === tempId,
      );

      if (changeIndex === -1) {
        // Will be handled outside produce by checking foundAndUpdated
      } else {
        draftState.staged_changes[changeIndex] = changeToUpdate;
        foundAndUpdated = true;
      }
    });

    if (!foundAndUpdated) {
      logger.logCli(`[WARN] Tool: stage_update - No change found with tempId ${tempId} for session ${currentState.sessionId}.`);
      return {
        success: false,
        newState: currentState,
        outcome: StageUpdateOutcome.ERROR_NOT_FOUND,
        message: `No staged change found with temporary ID: ${tempId}. Cannot update.`,
      };
    }

    logger.logCli(`Tool: stage_update success for session ${currentState.sessionId}, updated tempId: ${tempId}. New data: ${JSON.stringify(changeToUpdate)}`);
    return {
      success: true,
      newState,
      outcome: StageUpdateOutcome.SUCCESS_UPDATED,
      updatedTempId: tempId,
    };
  } catch (error: any) {
    logger.logError(error, `Tool: stage_update error for session ${currentState.sessionId}, tempId: ${tempId}`);
    return {
      success: false,
      newState: currentState,
      outcome: StageUpdateOutcome.ERROR_UNKNOWN,
      message: `Error updating staged change: ${error.message}`,
    };
  }
} 