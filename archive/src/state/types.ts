import type { LinearGuid, TemporaryFriendlyId } from '@/types/linear-ids';
import type { Plan } from '../types/agent-output';

/**
 * Defines the structure for a single message in the conversation history.
 */
export interface ConversationMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'system'; // Roles used for storing history
  readonly content: string;
  // Optionally add fields for tool calls/results if needed here
  // readonly tool_calls?: ReadonlyArray<{ readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }>;
  // readonly tool_call_id?: string;
}

/**
 * Defines the structure for representing the agent's current focus.
 */
export interface AgentFocus {
  readonly type: 'project' | 'issue';
  // Consider storing both friendlyId and guid if available
  readonly id: string; // Could be LinearGuid or LinearFriendlyId initially
  // readonly friendlyId?: LinearFriendlyId;
  // readonly guid?: LinearGuid;
}

/**
 * Defines the structure for a change operation that has been proposed
 * but not yet applied to the Linear API.
 */
export interface StagedChange {
  readonly opType: string; // e.g., 'issue.create', 'issue.update', 'issue.link'
  readonly data: Record<string, any>; // Payload with potential friendly names/temp IDs
  readonly tempId?: TemporaryFriendlyId; // Optional temporary ID for dependency tracking
  readonly dependsOn?: string[]; // <-- ADDED THIS LINE
  // Optionally add metadata like timestamp, user who requested, etc.
  // readonly addedAt?: number;
}

/**
 * Defines the possible statuses of the agent.
 */
export type AgentStatus = 'idle' | 'waiting_confirmation' | 'processing' | 'error';

/**
 * Defines the structure for team-specific workflow context.
 */
export interface TeamWorkflowContext {
    readonly name: string; // Name of the team
    readonly states: ReadonlyArray<{ readonly id: LinearGuid; readonly name: string }>;
    // readonly last_fetched_timestamp?: number; // Optional: for cache invalidation later
}

/**
 * Defines the structure for structured LLM response.
 */
export interface StructuredLlmResponse {
  userFacingMessage: string;
  scratchpad: string;
  currentPlan: Plan | null;
}

/**
 * Defines the core state structure for the Voca agent,
 * intended to be persisted between interactions (e.g., in Redis).
 */
export interface AgentState {
  readonly sessionId: string;
  readonly conversation_history: ReadonlyArray<ConversationMessage>;
  readonly focus: AgentFocus | null;
  readonly staged_changes: ReadonlyArray<StagedChange>;
  readonly id_map: Readonly<Record<string, LinearGuid>>; // Maps various ID forms (temp, friendly, guid, slug) to resolved Linear GUIDs
  readonly team_workflows: Readonly<Record<string, TeamWorkflowContext>>; // teamId -> workflow states and other team context
  readonly issue_team_map: Readonly<Record<LinearGuid, LinearGuid>>; // issueGuid -> teamGuid, for quick context lookup
  readonly status: AgentStatus;
  readonly llm_scratchpad?: string; // LLM's working notes, read/written each turn
  readonly current_plan: Plan | null;
  readonly plan_step_outputs: Readonly<Record<string, any>>; // Outputs of executed plan steps
  // Optionally add other state fields like last_error, configuration, etc.
  // readonly last_error?: string | null;
  // readonly user_preferences?: Readonly<Record<string, any>>;
} 