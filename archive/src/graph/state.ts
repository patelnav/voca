import type { StagedChange } from '@/linear/changes';
import type { GraphQLMutation } from '@/linear/staging-transformer/types';
import { type BaseMessage } from '@langchain/core/messages';

export interface AgentState {
  messages: BaseMessage[];
  userInput: string;
  // Intent & Search (Phase 2 - Updated Scope)
  intent: "search" | "fetch_details" | "propose_change" | "manage_focus" | "provide_clarification" | "unknown"; // Reduced scope
  searchQuery?: string | null;
  searchResults?: Array<{ id: string; name: string; type: 'project' | 'issue' }> | null;
  // Active Context (Phase 2)
  activeEntityId?: string | null; // Linear GUID
  activeEntityType?: 'project' | 'issue' | null;
  // relatedEntityId?: string | null; // <<< REMOVED for Phase 2 simplification >>>
  // Command Processing (Phase 1 - keep for now if focus logic depends on it? Phase 2 plan says replace... let's keep focusTargetId for focus command)
  // commandType: "natural_language" | "focus" | "unfocus" | "apply" | "clear" | "changes" | "history" | "issues" | "projects" | "confirm_apply" | "unknown"; // Replaced by intent
  focusTargetId?: string | null; // ID given with 'focus' command
  // Linear Context / State
  linearContext: string | null | undefined; // <<< Allow undefined
  isFocused: boolean;
  focusedProjectId?: string | null; // Linear GUID
  focusedProjectName?: string | null;
  // LLM / Change Processing Results
  plainTextResponse?: string | null; // Raw LLM output for NL
  conversationalPart?: string | null; // User-facing chat part
  rawProposedChanges?: Array<any> | null; // Raw proposed changes from LLM function call
  graphQLMutations?: GraphQLMutation[] | null;
  stagedChanges?: StagedChange[] | null; // Structured changes ready for manager
  // Flow Control / Display
  confirmationNeeded: boolean;
  displayData?: any | null; // Data for specific commands (projects list, issues, etc.)
  responseToUser: string | null | undefined; // <<< Final message for the user - Allow null/undefined
  error?: string | null;
  // --- New/Refined fields for Phase 3 ---
  needsClarification: boolean; // Tracks if the agent is waiting for clarification
  clarificationQuestion?: string | null; // The specific question asked
  clarificationOptions?: Array<{ id: string; name: string; type: 'project' | 'issue' }> | null; // The options presented
  previousIntent?: AgentState['intent'] | null; // Store original intent before asking for clarification
  llmAssumption?: string | null; // The LLM's assumption when resolving ambiguity
  ambiguousOptions?: Array<{ id: string; name: string; type: 'project' | 'issue' }> | null; // Options if LLM needs clarification
  hasProposedChanges?: boolean; // <<< Re-added temporarily
  // Fields added for fetch action/filters
  fetchAction?: 'list' | 'count' | 'summary' | null;
  fetchFilters?: Record<string, any> | null; // Flexible filter object
  // messages: any[]; // Keep if needed for conversation history
}
