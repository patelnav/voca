import { 
  type LinearFriendlyId, 
  type LinearGuid
} from '@/types/linear-ids';
import { type LinearClient } from '@linear/sdk';

// Define specific payload interfaces for each operation type
export interface IssueCreatePayload {
  projectId: LinearFriendlyId | LinearGuid | string; // Allow both formats and string for testing
  title: string;
  description?: string;
  // Optional fields that can be passed during creation
  parentId?: string;
  stateId?: string;
  priority?: number;
  labelIds?: string[];
  assigneeId?: string;
  dueDate?: string;
}

export interface IssueUpdatePayload {
  id: LinearGuid | LinearFriendlyId | string; // Allow both types since we resolve in the operation
  title?: string;
  description?: string;
  parentId?: string;
  stateId?: string;
  priority?: number;
  labelIds?: string[];
  assigneeId?: string;
  dueDate?: string;
}

export interface IssueDeletePayload {
  id: LinearGuid | LinearFriendlyId | string; // Allow string for raw/temp IDs used in tests
}

export interface ProjectCreatePayload {
  name: string;
  description?: string;
}

export interface ProjectArchivePayload {
  projectId: LinearFriendlyId | string; // Allow string for raw/temp IDs
  archiveIssues?: boolean;
}

export interface RelationshipLinkPayload {
  parentId: LinearGuid | LinearFriendlyId | string; // Allow string for raw/temp IDs
  childId: LinearGuid | LinearFriendlyId | string; // Allow string for raw/temp IDs
  id?: LinearGuid | LinearFriendlyId | string; // Optional alias for childId, used in test fixtures
}

export interface CommentCreatePayload {
  issueId: LinearGuid | LinearFriendlyId | string; // Allow string for raw/temp IDs
  body: string;
}

// TODO: Define payloads for Label, State, Milestone operations if needed
// export interface LabelCreatePayload { ... }
// export interface StateCreatePayload { ... }
// export interface MilestoneCreatePayload { ... }

// Create a union type for all possible payloads
export type EntityOperationPayload = 
  | IssueCreatePayload 
  | IssueUpdatePayload 
  | IssueDeletePayload
  | ProjectCreatePayload
  | ProjectArchivePayload
  | RelationshipLinkPayload
  | CommentCreatePayload;
  // Add other payloads here when defined

/**
 * Generic entity operation interface with proper typing
 */
export interface EntityOperation<T extends EntityOperationPayload> {
  // Execute function that takes a client and properly typed payload
  execute: (client: LinearClient, payload: T) => Promise<any>;
  // Human-readable description of what this operation does
  description: (payload: T) => string;
}

// Type definition for the main operations registry
export type EntityOperationsRegistry = Record<string, Record<string, EntityOperation<any>>>; 