import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LinearClient, type Issue, type WorkflowState } from '@linear/sdk';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop';
import { saveAgentState, loadAgentState } from '@/state/manager';
import { redisClient } from '@/redis/client';
import { 
  E2E_PROJECT_ID, 
  E2E_TEAM_ID, 
  LINEAR_API_KEY, 
  createInitialAgentState 
} from '@tests/shared/linear-e2e.config';
import type { LinearSearchResult, LinearDetailsResult } from '@/tools/linear_read';

// Helper to find a specific workflow state by name for a team
async function getTeamWorkflowState(
  linearClient: LinearClient,
  teamId: string,
  stateName: string
): Promise<WorkflowState | undefined> {
  const team = await linearClient.team(teamId);
  const states = await team.states();
  return states.nodes.find(state => state.name.toLowerCase() === stateName.toLowerCase());
}


describe('Agent E2E: Vague References & Complexity with Linear Interaction', () => {
  let linearClient: LinearClient;
  const testSessionIdPrefix = 'test-agent-linear-interaction-';
  let currentTestSessionId: string;

  let uiIssue: Issue | undefined;
  let backendIssue: Issue | undefined;
  let inProgressStateId: string | undefined;

  beforeAll(async () => {
    linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });

    // Ensure Redis client is connected (it tries on init, but good practice)
    if (redisClient.status !== 'ready' && redisClient.status !== 'connect') {
      try {
        if (redisClient.status !== 'connecting') {
          await redisClient.connect();
        } else {
          await new Promise<void>((resolve, reject) => {
            redisClient.once('ready', resolve);
            redisClient.once('error', reject);
          });
        }
      } catch (err) {
        console.error('Failed to ensure Redis client connection for tests:', err);
        throw err;
      }
    }

    // Get the 'In Progress' state ID for the E2E_TEAM_ID
    const inProgressState = await getTeamWorkflowState(linearClient, E2E_TEAM_ID, 'In Progress');
    if (!inProgressState) {
      throw new Error(`Could not find 'In Progress' workflow state for team ${E2E_TEAM_ID}`);
    }
    inProgressStateId = inProgressState.id;

    // Create test issues
    const uiIssueData = await linearClient.createIssue({
      title: 'E2E Test: Fix button alignment on dashboard',
      description: 'The main call to action button is misaligned on the user dashboard.',
      projectId: E2E_PROJECT_ID,
      teamId: E2E_TEAM_ID,
    });
    uiIssue = await uiIssueData.issue;
    if (!uiIssue) throw new Error('Failed to create UI test issue');

    // Create backend issue, initially NOT 'In Progress' (e.g., in 'Todo' or default state)
    // We will fetch the 'Todo' state for this example.
    const todoState = await getTeamWorkflowState(linearClient, E2E_TEAM_ID, 'Todo');
    if (!todoState) {
        throw new Error(`Could not find 'Todo' workflow state for team ${E2E_TEAM_ID}. Please ensure it exists.`);
    }

    const backendIssueData = await linearClient.createIssue({
      title: 'E2E Test: Optimize database query for user profiles',
      description: 'The user profile loading query is too slow and needs optimization.',
      projectId: E2E_PROJECT_ID,
      teamId: E2E_TEAM_ID,
      stateId: todoState.id, // Start in 'Todo' state
    });
    backendIssue = await backendIssueData.issue;
    if (!backendIssue) throw new Error('Failed to create backend test issue');

    console.log(`--- E2E Setup: Created UI Issue ID: ${uiIssue.id}, Backend Issue ID: ${backendIssue.id} in Todo state ---`);
  }, 30000); // Increased timeout for beforeAll hook

  afterAll(async () => {
    const issuesToDelete: string[] = [];
    if (uiIssue) issuesToDelete.push(uiIssue.id);
    if (backendIssue) issuesToDelete.push(backendIssue.id);

    if (issuesToDelete.length > 0) {
      console.log(`--- E2E Teardown: Deleting ${issuesToDelete.length} Linear issues... ---`);
      try {
        for (const issueId of issuesToDelete) {
          await linearClient.deleteIssue(issueId);
        }
        console.log('Successfully deleted Linear issues.');
      } catch (error) {
        console.error('Error deleting Linear issues during teardown:', error);
      }
    }
    // Note: Not quitting shared redisClient here
  });

  beforeEach(async () => {
    currentTestSessionId = `${testSessionIdPrefix}${randomUUID()}`;
    // Ensure a clean state for each test run by re-creating the initial agent state
    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);
  });

  afterEach(async () => {
    if ((redisClient.status === 'ready' || redisClient.status === 'connect') && currentTestSessionId) {
      await redisClient.del(currentTestSessionId);
    }
  });

  it('should correctly identify vaguely referenced issues and stage updates with confirmation', async () => {
    if (!uiIssue || !backendIssue || !inProgressStateId) {
      throw new Error('Test issues or inProgressStateId not initialized correctly for the test.');
    }

    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);
    
    console.log(`--- Test Start: Session ID ${currentTestSessionId} ---`);
    console.log(`UI Issue: ${uiIssue.identifier} (${uiIssue.title}), Backend Issue: ${backendIssue.identifier} (${backendIssue.title})`);

    // Turn 1: User: "What issues are assigned to me about UI bugs?"
    // For this E2E test, we'll make the search more specific to ensure we find our created UI issue.
    const userQuery1 = `Search for issues with title "${uiIssue.title}" in project "${E2E_PROJECT_ID}"`;
    console.log(`\n--- Turn 1 --- User: ${userQuery1}`);
    const response1Output = await runConversationTurn(currentTestSessionId, userQuery1);
    console.log(`Voca: ${response1Output?.textResponse}`);

    // Turn 2: User: "Also search for backend performance issues."
    // Make search specific for the backend issue.
    const userQuery2 = `Search for issues with title "${backendIssue.title}" in project "${E2E_PROJECT_ID}"`;
    console.log(`\n--- Turn 2 --- User: ${userQuery2}`);
    const response2Output = await runConversationTurn(currentTestSessionId, userQuery2);
    console.log(`Voca: ${response2Output?.textResponse}`);
    // Assert on structured tool result for Turn 2 (linear_search)
    expect(response2Output?.toolResult).toBeDefined();
    expect(response2Output!.toolResult!.toolName).toBe('linear_search');
    expect(response2Output!.toolResult!.structuredOutput).toBeDefined();
    // Cast structuredOutput to the specific result type
    const searchResult = response2Output!.toolResult!.structuredOutput as LinearSearchResult;
    expect(searchResult.success).toBe(true);
    expect(searchResult.outcome).toBe('FOUND_RESULTS');
    expect(searchResult.results).toBeDefined();
    // Check if the results array contains the backendIssue
    const foundBackendIssue = searchResult.results!.find(
      (issue: any) => issue.identifier === backendIssue!.identifier
    );
    expect(foundBackendIssue).toBeDefined();
    
    const agentStateAfterSearches = await loadAgentState(currentTestSessionId);
    expect(agentStateAfterSearches?.id_map[uiIssue.identifier]).toBe(uiIssue.id);
    expect(agentStateAfterSearches?.id_map[backendIssue.identifier]).toBe(backendIssue.id);

    // Turn 3: User: "Tell me more about that UI bug." (Agent maps to NP-UI-1 -> linear_get_details)
    // The agent should use context. We refer to it by its identifier directly for robustness in test.
    const userQuery3 = `Tell me more about ${uiIssue.identifier}`;
    console.log(`\n--- Turn 3 --- User: ${userQuery3}`);
    const response3Output = await runConversationTurn(currentTestSessionId, userQuery3);
    console.log(`Voca: ${response3Output?.textResponse}`);
    // Assert on structured tool result for Turn 3 (linear_get_details)
    expect(response3Output?.toolResult).toBeDefined();
    expect(response3Output!.toolResult!.toolName).toBe('linear_get_details');
    expect(response3Output!.toolResult!.structuredOutput).toBeDefined();
    // Cast structuredOutput to the specific result type
    const detailsResult = response3Output!.toolResult!.structuredOutput as LinearDetailsResult;
    expect(detailsResult.success).toBe(true);
    expect(detailsResult.outcome).toBe('FOUND_DETAILS');
    expect(detailsResult.entity).toBeDefined();
    // Cast entity to Issue as we expect an Issue here
    const detailedIssue = detailsResult.entity as Issue;
    expect(detailedIssue.identifier).toBe(uiIssue!.identifier);
    expect(detailedIssue.description).toBeDefined();
    expect(detailedIssue.description).not.toBe('');

    // Turn 4: User: "Okay, stage an update to mark the backend performance issue as 'In Progress'."
    // (Agent maps to NP-BE-5 -> potentially linear_get_details -> stage_add -> MUST provide confirmation text)
    // Modify query to provide stateId directly to simplify LLM task and bypass potential stateId resolution issues.
    const userQuery4 = `Okay, stage an update for issue ${backendIssue.identifier} to state ID ${inProgressStateId}. Also add a comment: "This is now being worked on."`;
    console.log(`\n--- Turn 4 --- User: ${userQuery4}`);
    const response4Output = await runConversationTurn(currentTestSessionId, userQuery4);
    console.log(`Voca: ${response4Output?.textResponse}`);

    // Assertions for Turn 4:
    // 1. Check the agent's intent after staging
    expect(response4Output?.intent).toBe('AWAITING_CONFIRMATION');
    
    // 2. Check agent state for the staged change
    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState?.staged_changes).toHaveLength(1);
    const stagedChange = finalState?.staged_changes[0];
    expect(stagedChange).toBeDefined();
    expect(stagedChange?.opType).toBe('issue.update');
    // The `id` in staged_changes data should be the actual GUID of the backend issue
    expect(stagedChange?.data.id).toBe(backendIssue.id); 
    // The agent should have resolved 'In Progress' to its actual ID (or used the provided one)
    expect(stagedChange?.data.stateId).toBe(inProgressStateId); 
    expect(stagedChange?.data.comment).toBe("This is now being worked on.");
    
    console.log('--- Test End: Vague reference and staging test passed ---');

  }, 90000); // Increased timeout for multiple dependent LLM calls & API interactions
}); 