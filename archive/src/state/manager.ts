import { redisClient } from '../redis/client';
import { AgentState, AgentStatus } from './types';
import { Logger } from '../utils/logger';

// Get the singleton logger instance
const logger = Logger.getInstance();

// Define the default state using string literals for status
const DEFAULT_AGENT_STATE: Omit<AgentState, 'sessionId'> = {
  conversation_history: [],
  focus: null,
  staged_changes: [],
  id_map: {},
  team_workflows: {},
  issue_team_map: {},
  status: 'idle', // Corrected: Use string literal
  llm_scratchpad: "", // Initialize LLM scratchpad as empty string
  current_plan: null,
  plan_step_outputs: {},
};

/**
 * Loads the agent state for a given session ID from Redis.
 * If no state is found, returns a default initial state.
 * @param sessionId The unique identifier for the session.
 * @returns A Promise resolving to the AgentState.
 */
export async function loadAgentState(sessionId: string): Promise<AgentState> {
  try {
    const stateString = await redisClient.get(sessionId);
    if (stateString) {
      // Use console.log for debug messages, logger captures it
      console.log(`Loaded state string for session ${sessionId}: ${stateString}`);
      const parsedState = JSON.parse(stateString) as AgentState;
      console.log(`Parsed state for session ${sessionId}: ${JSON.stringify(parsedState.staged_changes)}`);
      return parsedState;
    } else {
      console.log(
        `No state found for session ${sessionId}, returning default state.`,
      );
      return {
        ...DEFAULT_AGENT_STATE,
        sessionId: sessionId,
      };
    }
  } catch (error) {
    // Use the logger's explicit error logging method
    logger.logError(error, `Error loading state for session ${sessionId}`);
    // Also log to console for immediate visibility during development
    console.error(`Error loading state for session ${sessionId}:`, error);
    return {
      ...DEFAULT_AGENT_STATE,
      sessionId: sessionId,
    };
  }
}

/**
 * Saves the agent state for a given session ID to Redis.
 * @param sessionId The unique identifier for the session.
 * @param state The AgentState object to save.
 * @returns A Promise resolving when the state is saved.
 */
export async function saveAgentState(
  sessionId: string,
  state: AgentState,
): Promise<void> {
  try {
    const stateString = JSON.stringify(state);
    await redisClient.set(sessionId, stateString);
    // Use console.log for debug messages
    console.log(`Saved state for session ${sessionId}`);
  } catch (error) {
    // Use the logger's explicit error logging method
    logger.logError(error, `Error saving state for session ${sessionId}`);
    // Also log to console
    console.error(`Error saving state for session ${sessionId}:`, error);
  }
} 