import type { LinearClient } from '@linear/sdk';
import type { LinearGuid, TemporaryFriendlyId } from '@/types/linear-ids';
import type { ExecuteLinearOperationResult, ResolveIdentifiersResult } from './linear_sdk_helpers.types';
import { formatSdkFailureReason } from './linear_apply'; // Assuming this will be available or moved
import type { StagedChange } from '@/state/types';

// --- Local helper functions for formatting reasons (moved from linear_apply.ts) ---
function _formatTempIdResolutionFailureReason(tempIdWithValuePrefix: string, opType: string): string {
    return `Failed to resolve temporary ID ${tempIdWithValuePrefix} needed for ${opType}. This ID was not found in the current ID map.`;
};

function _formatGuidResolutionFailureReason(identifier: string, opType: string): string {
    return `Failed to resolve identifier "${identifier}" to a valid Linear GUID for ${opType}.`;
};

function _formatMissingIdFailureReason(opType: string): string {
    return `Missing identifier ('id' or 'identifier' field) in data for ${opType}, which requires an existing entity.`;
};
// --- End of moved formatting functions ---

export async function resolveIdentifiers(
  changeData: Record<string, any>,
  opType: string,
  internalIdMap: Map<string, LinearGuid>
): Promise<ResolveIdentifiersResult> {
  console.log(`[DEBUG resolveIdentifiers] Start. opType: ${opType}, changeData: ${JSON.stringify(changeData)}, internalIdMap keys: ${JSON.stringify(Array.from(internalIdMap.keys()))}`);
  const dataWithResolvedIds = { ...changeData };

  // 1. Resolve temporary IDs with "temp:" prefix
  for (const key in dataWithResolvedIds) {
    const value = dataWithResolvedIds[key];
    if (typeof value === 'string' && value.startsWith('temp:')) {
      console.log(`[DEBUG resolveIdentifiers] Found temp ID: ${key} = ${value}`);
      const actualTempId = value.substring(5) as TemporaryFriendlyId;
      const resolvedId = internalIdMap.get(actualTempId);
      if (resolvedId) {
        console.log(`[DEBUG resolveIdentifiers] Resolved temp ID ${actualTempId} to ${resolvedId}`);
        dataWithResolvedIds[key] = resolvedId;
      } else {
        const reason = _formatTempIdResolutionFailureReason(value, opType);
        console.log(`[DEBUG resolveIdentifiers] Failed to resolve temp ID. Reason: ${reason}. Returning false.`);
        return { success: false, reason };
      }
    }
  }

  // 2. Resolve specific known temporary ID fields (e.g., comment.create.issueId)
  // This handles cases where the ID is temporary but not "temp:" prefixed.
  if (opType === 'comment.create' && dataWithResolvedIds.issueId && typeof dataWithResolvedIds.issueId === 'string') {
    const issueIdVal = dataWithResolvedIds.issueId;
    // Check if it's not already a GUID (it might have been resolved by the first loop if it was temp: prefixed,
    // or it might have been a GUID to begin with).
    if (!isLikelyGuid(issueIdVal)) {
      const resolvedGuidFromMap = internalIdMap.get(issueIdVal as TemporaryFriendlyId);
      if (resolvedGuidFromMap && isLikelyGuid(resolvedGuidFromMap)) {
        console.log(`[DEBUG resolveIdentifiers] Resolved non-prefixed temp ID ${issueIdVal} to ${resolvedGuidFromMap} for ${opType}`);
        dataWithResolvedIds.issueId = resolvedGuidFromMap;
      } else {
        // If it's not a GUID and couldn't be resolved from the map, it's an error for comment.create
        const reason = `Failed to resolve required field 'issueId' ('${issueIdVal}') for ${opType}. It was not found in the internalIdMap or was not a valid GUID.`;
        console.log(`[DEBUG resolveIdentifiers] Failed to resolve non-prefixed temp ID for ${opType}. Reason: ${reason}. Returning false.`);
        return { success: false, reason };
      }
    }
  }

  const operationsRequiringEntityGuid = [
    'issue.update', 'project.update', 'issue.delete',
    'comment.update', 'comment.delete', 'project.delete'
  ];

  console.log(`[DEBUG resolveIdentifiers] Checking if opType ${opType} requires entity GUID: ${operationsRequiringEntityGuid.includes(opType)}`);
  if (operationsRequiringEntityGuid.includes(opType)) {
    let entityIdentifierValue: string | undefined = undefined;
    let originalIdField: string | undefined = undefined;

    if (dataWithResolvedIds.id && typeof dataWithResolvedIds.id === 'string') {
      entityIdentifierValue = dataWithResolvedIds.id;
      originalIdField = 'id';
      console.log(`[DEBUG resolveIdentifiers] Found entityIdentifierValue in data.id: ${entityIdentifierValue}`);
    } else if (dataWithResolvedIds.identifier && typeof dataWithResolvedIds.identifier === 'string') {
      entityIdentifierValue = dataWithResolvedIds.identifier;
      originalIdField = 'identifier';
      console.log(`[DEBUG resolveIdentifiers] Found entityIdentifierValue in data.identifier: ${entityIdentifierValue}`);
    } else {
      console.log(`[DEBUG resolveIdentifiers] No entityIdentifierValue found in data.id or data.identifier.`);
    }

    if (entityIdentifierValue) {
      console.log(`[DEBUG resolveIdentifiers] entityIdentifierValue: ${entityIdentifierValue}, isLikelyGuid: ${isLikelyGuid(entityIdentifierValue)}`);
      if (!isLikelyGuid(entityIdentifierValue)) {
        console.log(`[DEBUG resolveIdentifiers] entityIdentifierValue is NOT a GUID. Trying to resolve from internalIdMap.`);
        const resolvedGuid = internalIdMap.get(entityIdentifierValue);
        console.log(`[DEBUG resolveIdentifiers] Resolved from map: ${resolvedGuid}`);
        if (resolvedGuid && isLikelyGuid(resolvedGuid)) {
          dataWithResolvedIds.id = resolvedGuid;
          // If id was resolved, and an identifier field exists, remove identifier as id takes precedence.
          if (typeof dataWithResolvedIds.identifier !== 'undefined') {
            delete dataWithResolvedIds.identifier;
          }
          console.log(`[DEBUG resolveIdentifiers] Successfully resolved friendly ID to GUID. Returning true. Data: ${JSON.stringify(dataWithResolvedIds)}`);
          return { success: true, resolvedData: dataWithResolvedIds };
        } else {
          const reason = _formatGuidResolutionFailureReason(entityIdentifierValue, opType);
          console.log(`[DEBUG resolveIdentifiers] Failed to resolve friendly ID or result was not a GUID. Reason: ${reason}. Returning false.`);
          return { success: false, reason };
        }
      } else { // entityIdentifierValue IS already a GUID
        console.log(`[DEBUG resolveIdentifiers] entityIdentifierValue IS a GUID.`);
        dataWithResolvedIds.id = entityIdentifierValue;
        // If id is a GUID (either originally or moved from identifier), remove any separate identifier field.
        if (originalIdField === 'identifier' || typeof dataWithResolvedIds.identifier !== 'undefined') {
          // Ensure we delete if originalIdField was 'identifier' (it's now in 'id')
          // OR if 'identifier' exists as a separate field alongside 'id'.
          if (typeof dataWithResolvedIds.identifier !== 'undefined') { // Add this check to prevent error if originalIdField was 'identifier' and it was the only one
            console.log(`[DEBUG resolveIdentifiers] Deleting original identifier field: ${dataWithResolvedIds.identifier}`);
            delete dataWithResolvedIds.identifier;
          }
        }
        console.log(`[DEBUG resolveIdentifiers] Already a GUID. Standardized to id. Returning true. Data: ${JSON.stringify(dataWithResolvedIds)}`);
        return { success: true, resolvedData: dataWithResolvedIds };
      }
    } else { // No entityIdentifierValue found
      // This 'else' corresponds to 'if (entityIdentifierValue)'
      // If it's not a create op, it's an error. Create ops can proceed without an ID.
      if (!['issue.create', 'comment.create', 'project.create'].includes(opType)) {
        const reason = _formatMissingIdFailureReason(opType);
        console.log(`[DEBUG resolveIdentifiers] No entityIdentifierValue and not a create op. Reason: ${reason}. Returning false.`);
        return { success: false, reason };
      }
      console.log(`[DEBUG resolveIdentifiers] No entityIdentifierValue, but it IS a create op. Proceeding.`);
    }
  }

  console.log(`[DEBUG resolveIdentifiers] Reached end of function or opType did not require entity GUID. Returning true. Data: ${JSON.stringify(dataWithResolvedIds)}`);
  return { success: true, resolvedData: dataWithResolvedIds };
}

export async function executeLinearOperation(
  opType: string,
  input: any, // Consider more specific types later if possible
  idForUpdate: string | undefined,
  linearClient: LinearClient,
): Promise<ExecuteLinearOperationResult> {
  let newId: LinearGuid | undefined;
  let operationSuccess = false;
  let operationReason = 'Unknown error during SDK operation.';

  // The switch block will be moved here from apply_staged_changes
  // For now, this is a placeholder structure
  switch (opType) {
    case 'issue.create': {
      const response = await linearClient.createIssue(input as Parameters<LinearClient['createIssue']>[0]);
      // console.log(`[E2E DEBUG executeLinearOperation issue.create] Response success: ${response.success}`); // Keep or remove debug logs as needed
      const sdkIssue = await response.issue;
      // console.log(`[E2E DEBUG executeLinearOperation issue.create] SDK Issue ID: ${sdkIssue?.id}`);
      if (response.success) {
        if (sdkIssue?.id) {
          newId = sdkIssue.id as LinearGuid;
          operationSuccess = true;
          operationReason = ''; // Clear reason on success
        } else {
          operationReason = 'SDK createIssue succeeded but no issue or issue ID found in payload.';
          // console.warn(`[executeLinearOperation] ${operationReason}`, { payload: response });
        }
      } else {
        operationReason = formatSdkFailureReason(opType) + ((response as any).error ? ` Details: ${(response as any).error}` : '');
      }
      break;
    }
    case 'issue.update': {
      if (!idForUpdate || !isLikelyGuid(idForUpdate)) { // isLikelyGuid will need to be available here too
        operationReason = `Invalid or missing GUID for ${opType}. Received: ${idForUpdate}.`;
      } else {
        const response = await linearClient.updateIssue(idForUpdate, input);
        if (response.success) {
          newId = idForUpdate as LinearGuid;
          operationSuccess = true;
          operationReason = '';
        } else { 
          operationReason = formatSdkFailureReason(opType) + ((response as any).error ? ` Details: ${(response as any).error}` : ''); 
        }
      }
      break;
    }
    case 'issue.delete': {
      if (!idForUpdate || !isLikelyGuid(idForUpdate)) { 
        operationReason = `Invalid or missing GUID for ${opType}. Received: ${idForUpdate}.`;
      } else {
        try {
          const issueEntity = await linearClient.issue(idForUpdate);
          if (!issueEntity) { 
            operationReason = `Issue ${idForUpdate} not found for deletion.`;
          } else {
            console.log(`Attempting to archive issue ${idForUpdate}...`);
            const deleteResponse = await issueEntity.archive(); 
            console.log(`Archive response for ${idForUpdate}:`, deleteResponse);
            if (deleteResponse.success) {
              console.log(`Successfully archived issue ${idForUpdate}.`);
              // newId = idForUpdate as LinearGuid; // DO NOT set newId for delete operations
              operationSuccess = true;
              operationReason = '';
            } else { 
              console.warn(`Failed to archive issue ${idForUpdate}. SDK success=false.`);
              operationReason = formatSdkFailureReason(opType) + ((deleteResponse as any).error ? ` Details: ${(deleteResponse as any).error}` : '');
            }
          }
        } catch (sdkError: any) {
          console.error(`SDK Error during issue lookup/archive for ${idForUpdate}:`, sdkError);
          operationReason = `SDK Error during ${opType} for ${idForUpdate}: ${sdkError.message}`;
        }
      }
      break;
    }
    case 'comment.create': {
      const response = await linearClient.createComment(input);
      if (response.success) {
        const sdkComment = await response.comment;
        if (sdkComment?.id) {
          newId = sdkComment.id as LinearGuid;
          operationSuccess = true;
          operationReason = '';
        } else {
          operationReason = 'SDK createComment succeeded but no comment or comment ID found in payload.';
          // console.warn(`[executeLinearOperation] ${operationReason}`, { payload: response });
        }
      } else {
        operationReason = formatSdkFailureReason(opType) + ((response as any).error ? ` Details: ${(response as any).error}` : '');
      }
      break;
    }
    // TODO: Add cases for project.create, project.update, project.delete, comment.update, comment.delete
    default: {
      // operationReason = `Operation type ${opType} is not implemented in executeLinearOperation.`;
      // For default, success is false, newId is undefined.
      // This case should ideally be handled before calling, or result in a 'skipped' status upstream.
      const structuredReason = {
        code: 'OPERATION_NOT_IMPLEMENTED',
        message: `Operation type ${opType} is not implemented in executeLinearOperation.`,
        opType: opType
      };
      operationReason = JSON.stringify(structuredReason);
      break;
    }
  }

  return { success: operationSuccess, newId, reason: operationSuccess ? undefined : operationReason };
}

// Helper function (might be moved to a shared utils file)
// For now, defined here to make the above function self-contained with its direct dependencies from the original file.
function isLikelyGuid(id: string): boolean {
  if (typeof id !== 'string') return false;
  const guidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return guidRegex.test(id);
} 