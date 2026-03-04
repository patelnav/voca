import { type LinearClient } from '@linear/sdk';
import { issueOperations } from './issue-operations';
import { projectOperations } from './project-operations';
import { commentOperations } from './comment-operations';
import { relationshipOperations } from './relationship-operations';
import { 
  type EntityOperationsRegistry, 
  type EntityOperationPayload,
  // Re-export specific payload types for convenience
  type IssueCreatePayload,
  type IssueUpdatePayload,
  type IssueDeletePayload,
  type ProjectCreatePayload,
  type ProjectArchivePayload,
  type RelationshipLinkPayload,
  type CommentCreatePayload
} from './types';

// Re-export types from types.ts
export type * from './types';

// Assemble the main operations registry
export const entityOperations: EntityOperationsRegistry = {
  issue: issueOperations,
  project: projectOperations,
  comment: commentOperations,
  relationship: relationshipOperations,
  // TODO: Add label, state, milestone operations when implemented
  // label: { ... },
  // state: { ... },
  // milestone: { ... },
};

// --- Helper Functions (Moved from original entity-operations.ts) ---

/**
 * Helper function to check if an operation exists for a given entity and operation type
 */
export function hasOperation(entityType: string, operation: string): boolean {
  return !!entityOperations[entityType]?.[operation];
}

/**
 * Type guard functions to validate payload types at runtime
 */
export function isIssueCreatePayload(payload: any): payload is IssueCreatePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.title === 'string' && 
         typeof payload.projectId === 'string'; // Basic check, more specific validation below
}

export function isIssueUpdatePayload(payload: any): payload is IssueUpdatePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.id === 'string' &&
         // Check if at least one valid updateable field exists besides ID
         (Object.keys(payload).length > 1 && 
          (typeof payload.title === 'string' ||
           typeof payload.description === 'string' ||
           typeof payload.parentId === 'string' ||
           typeof payload.stateId === 'string' ||
           typeof payload.priority === 'number' || // Changed from !== undefined
           Array.isArray(payload.labelIds) ||
           typeof payload.assigneeId === 'string' ||
           typeof payload.dueDate === 'string'));
}

export function isIssueDeletePayload(payload: any): payload is IssueDeletePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.id === 'string'; // Further validation (GUID/FriendlyID) can happen elsewhere
}

export function isProjectCreatePayload(payload: any): payload is ProjectCreatePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.name === 'string';
}

export function isProjectArchivePayload(payload: any): payload is ProjectArchivePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.projectId === 'string';
}

export function isRelationshipLinkPayload(payload: any): payload is RelationshipLinkPayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.parentId === 'string' &&
         // Either childId or id (alias) must be present and be a string
         (typeof payload.childId === 'string' || typeof payload.id === 'string');
}

export function isCommentCreatePayload(payload: any): payload is CommentCreatePayload {
  return typeof payload === 'object' && 
         payload !== null &&
         typeof payload.issueId === 'string' &&
         typeof payload.body === 'string';
}

/**
 * Validate that a payload broadly matches the expected type for the given entity type and operation.
 * This is a structural check, not a deep validation of field values.
 * @throws Error if the payload doesn't match the expected type guard.
 */
function validatePayloadStructure(entityType: string, operation: string, payload: any): void {
  let isValid = false;
  if (entityType === 'issue') {
    if (operation === 'create') isValid = isIssueCreatePayload(payload);
    else if (operation === 'update') isValid = isIssueUpdatePayload(payload);
    else if (operation === 'delete') isValid = isIssueDeletePayload(payload);
  } else if (entityType === 'project') {
    if (operation === 'create') isValid = isProjectCreatePayload(payload);
    else if (operation === 'archive') isValid = isProjectArchivePayload(payload);
  } else if (entityType === 'relationship') {
    if (operation === 'link') isValid = isRelationshipLinkPayload(payload);
  } else if (entityType === 'comment') {
    if (operation === 'create') isValid = isCommentCreatePayload(payload);
  }
  // Add checks for other entities/operations here

  if (!isValid) {
    throw new Error(`Invalid payload structure for ${entityType}.${operation}: ${JSON.stringify(payload)}`);
  }
}

/**
 * Validate that a payload has all explicitly required fields for the given entity type and operation.
 * Note: This might overlap with type guards but provides more specific error messages.
 */
function validateRequiredFields(entityType: string, operation: string, payload: any): void {
  const errors: string[] = [];

  if (entityType === 'issue') {
    if (operation === 'create') {
      if (!payload.title) errors.push('title');
      if (!payload.projectId) errors.push('projectId');
    } else if (operation === 'update' || operation === 'delete') {
      if (!payload.id) errors.push('id');
    }
  } else if (entityType === 'project') {
    if (operation === 'create') {
      if (!payload.name) errors.push('name');
    } else if (operation === 'archive') {
      if (!payload.projectId) errors.push('projectId');
    }
  } else if (entityType === 'relationship') {
    if (operation === 'link') {
      if (!payload.parentId) errors.push('parentId');
      if (!payload.childId && !payload.id) errors.push('childId or id'); // Check alias too
    }
  } else if (entityType === 'comment') {
    if (operation === 'create') {
      if (!payload.issueId) errors.push('issueId');
      if (!payload.body) errors.push('body');
    }
  }
  // Add checks for other entities/operations here

  if (errors.length > 0) {
    throw new Error(`Missing required field(s) for ${entityType}.${operation}: ${errors.join(', ')}`);
  }
}

/**
 * Execute an operation on an entity after validation.
 */
export async function executeOperation(
  client: LinearClient,
  entityType: string,
  operation: string,
  payload: EntityOperationPayload // Use the union type for better type safety upstream
): Promise<any> {
  console.log(`Executing operation: ${entityType}.${operation}`);
  // console.log(`Payload: ${JSON.stringify(payload)}`); // Avoid logging potentially sensitive data
  
  const operationHandler = entityOperations[entityType]?.[operation];

  if (!operationHandler) {
    throw new Error(`Unsupported operation: ${entityType}.${operation}`);
  }

  // Perform validation before execution
  try {
    validatePayloadStructure(entityType, operation, payload);
    validateRequiredFields(entityType, operation, payload); // Check required fields specifically
  } catch (validationError) {
    console.error(`Payload validation failed for ${entityType}.${operation}:`, validationError);
    throw validationError; // Re-throw validation error
  }

  try {
    // Now execute the specific operation logic
    return await operationHandler.execute(client, payload);
  } catch (executionError) {
    console.error(`Operation failed: ${entityType}.${operation}`);
    // console.error(`Payload: ${JSON.stringify(payload)}`);
    console.error(`Error: ${executionError instanceof Error ? executionError.message : String(executionError)}`);
    // Consider logging stack trace: console.error(executionError)
    throw executionError; // Re-throw execution error
  }
}

/**
 * Get a human-readable description for an operation.
 */
export function getOperationDescription(
  entityType: string,
  operation: string,
  payload: EntityOperationPayload // Use the union type
): string {
  const operationHandler = entityOperations[entityType]?.[operation];

  if (!operationHandler) {
    // Fallback description for unknown operations
    return `Perform ${operation} on ${entityType}`; 
  }

  try {
    return operationHandler.description(payload);
  } catch (descriptionError) {
    console.error(`Failed to generate description for ${entityType}.${operation}:`, descriptionError);
    // Fallback description on error
    return `Operation: ${entityType}.${operation} (description unavailable)`;
  }
} 