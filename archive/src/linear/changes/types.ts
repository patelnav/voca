/**
 * Represents a temporary ID used for referencing changes that haven't been applied yet
 * Format: "TMPC-" followed by a change ID
 * Example: "TMPC-123abc"
 *
 * Note: This is used for type checking and validation of temporary IDs, though
 * most temporary IDs are created directly with string concatenation rather than createTemporaryId.
 */
export type TemporaryId = string & { readonly __brand: 'temporary' };

/**
 * Types of operations that can be performed
 */
export type LinearChangeOperation =
    | 'create'
    | 'update'
    | 'delete'
    | 'link'
    | 'archive'
    | 'addLabel'
    | 'addComment';

/**
 * Types of entities that can be modified
 */
export type LinearEntityType =
    | 'issue'
    | 'project'
    | 'relationship'
    | 'comment'
    | 'state'
    | 'label'
    | 'milestone';

/**
 * Interface for staged changes
 */
export interface StagedChange {
  id: string; // Unique identifier for this change
  operation: LinearChangeOperation;
  entityType: LinearEntityType;
  payload: any; // The data for the change
  description: string; // Human-readable description
  dependsOn?: string[]; // IDs of changes this depends on
}

/**
 * Result of applying a change
 */
export interface ChangeResult {
  change: StagedChange;
  result?: any;
  error?: any;
  success: boolean;
  newId?: string;
} 