/**
 * Represents the agent's broad intent or the state of the conversation turn.
 */
export type AgentIntent =
  | 'AWAITING_CONFIRMATION'  // Agent has proposed an action (e.g., apply staged changes) and needs user go-ahead.
  | 'ACTION_COMPLETED'     // A tool was successfully executed and/or a requested process finished.
  | 'INFORMATION_PROVIDED' // Agent provided information; no immediate complex action expected beyond conversation.
  | 'CLARIFICATION_NEEDED' // Agent requires more information from the user to proceed.
  | 'TOOL_CALLED'          // Agent has just executed a tool (used when the turn includes both tool call and summarization).
  | 'TOOL_ERROR'           // A tool call resulted in an error that was communicated to the user.
  | 'AGENT_ERROR'          // An internal error occurred in the agent's logic (potentially not user-facing).
  | 'IDLE';                // Agent is ready for new input, no specific pending action from the last turn.

/**
 * Describes an action the agent is currently focused on, has just completed,
 * or is waiting for user confirmation to proceed with.
 */
export interface PendingAction {
  type: 'APPLY_STAGED_CHANGES' | 'CALL_TOOL' | string; // `string` allows for future or custom action types.
  toolName?: string;          // Relevant if type is 'CALL_TOOL'.
  toolArgs?: Record<string, any>; // Arguments for the tool call, if relevant.
  // Potentially add a human-readable description of the pending action.
  // description?: string;
}

/**
 * Details about a tool execution within the turn.
 */
export interface ToolExecutionResult {
  toolName: string;
  /** Summary of the tool\'s raw output, if different from the main textResponse.
   *  Can also be the main user-facing message if the turn is solely about the tool\'s output.
   */
  resultSummary: string;
  /** The structured object returned by the tool, containing success status, outcome, etc. */
  structuredOutput: object; // Use a generic object for now, can be refined later
  error?: string;         // If the tool execution resulted in an error presented to the user.
  legacyOutput?: any;     // Optionally, the old raw/string output from the tool for debugging/logging during transition.
}

/**
 * The output from a single turn of conversation with the agent.
 */
export interface AgentTurnOutput {
  /** The natural language response to be presented to the user. */
  textResponse: string;
  /** The agent's perceived intent or the primary outcome of this turn. */
  intent: AgentIntent;
  /** Describes a specific action that is pending or was just handled. */
  pendingAction?: PendingAction;
  /** If a tool was executed and its result is being conveyed, this field provides details. */
  toolResult?: ToolExecutionResult;
  /** For AGENT_ERROR or severe TOOL_ERROR, provides more specific, non-user-facing error information. */
  internalErrorDetails?: string;
  /** Optional: Number of changes currently staged, can help UI/tests understand state. */
  numStagedChanges?: number;
  // We could also include other key pieces of state if useful for the consumer of this output.
  // E.g., currentFocus?: string | null;
}

export interface PlanStep {
    step: string;
    completed: boolean;
    skipped: boolean;
    subSteps?: PlanStep[]; 
}

export type Plan = PlanStep[];

/**
 * Represents the structured JSON that the LLM is primarily asked to produce in its text responses.
 */
export interface StructuredLlmResponse {
    userFacingMessage: string; 
    scratchpad: string; // Corrected name
    currentPlan: Plan;
    // tool_calls?: FunctionCall[]; // Removed as tool calls are handled via SDK
}