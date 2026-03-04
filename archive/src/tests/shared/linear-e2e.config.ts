import dotenv from 'dotenv';
import type { AgentState } from '../state/types';

// Load environment variables from .env file if not already loaded globally
dotenv.config();

export const E2E_PROJECT_ID = '39f3af4e-cd08-4036-bcc5-610e251d0ce6';
export const E2E_TEAM_ID = 'e9eb7141-8d9e-49fa-b16a-de8224285df0'; // Actual UUID for TESTTEAM (TES)

export const LINEAR_API_KEY = process.env.LINEAR_API_KEY;

if (!LINEAR_API_KEY) {
  throw new Error('Missing LINEAR_API_KEY in environment variables. This is required for E2E tests.');
}

/**
 * Creates a default initial AgentState object for testing.
 * @param sessionId The session ID for the agent state.
 * @param overrides Optional partial state to override defaults.
 * @returns A complete AgentState object.
 */
export function createInitialAgentState(
  sessionId: string, 
  overrides: Partial<AgentState> = {}
): AgentState {
  return {
    sessionId: sessionId,
    conversation_history: [],
    focus: null,
    staged_changes: [],
    id_map: {},
    status: 'idle',
    team_workflows: {},
    issue_team_map: {},
    llm_scratchpad: '',
    current_plan: null,
    plan_step_outputs: {},
    ...overrides, // Apply any specific overrides for the test
  };
} 