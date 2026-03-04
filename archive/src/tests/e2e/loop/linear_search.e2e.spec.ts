import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop';
import { StagedChange, ConversationMessage, type AgentState } from '@/state/types'; // Adjust path
import { saveAgentState, loadAgentState } from '@/state/manager';
import { redisClient } from '@/redis/client';
import { LinearClient, type Issue } from '@linear/sdk';
import { createInitialAgentState, LINEAR_API_KEY, E2E_PROJECT_ID, E2E_TEAM_ID } from '@tests/shared/linear-e2e.config';
import type { AgentTurnOutput } from '@/types/agent-output';
import { type LinearSearchResult, SearchOutcome } from '@/tools/linear_read'; // Added imports

// Ensure necessary env vars are set (GEMINI_API_KEY check)
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}

describe('Loop E2E - linear_search', () => {
  const testSessionIdPrefix = 'test-session-e2e-loop-search-';
  let currentTestSessionId: string;
  let linearClient: LinearClient;
  const createdIssueIds: string[] = [];

  beforeAll(async () => {
    linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });
    if (redisClient.status !== 'ready' && redisClient.status !== 'connect') {
      try {
        if (redisClient.status !== 'connecting') {
          await redisClient.connect();
          console.log('Redis client explicitly connected for E2E tests.');
        } else {
          await new Promise<void>((resolve, reject) => {
            redisClient.once('ready', () => {
              console.log('Redis client became ready for E2E tests.');
              resolve();
            });
            redisClient.once('error', (err) => {
              console.error('Redis client connection error during wait:', err);
              reject(err);
            });
          });
        }
      } catch (err) {
        console.error('Failed to ensure Redis client connection for tests:', err);
        throw err; 
      }
    }
  });

  afterAll(async () => {
    if (createdIssueIds.length > 0) {
      console.log(`Cleaning up ${createdIssueIds.length} Linear issues created by search E2E tests...`);
      try {
        for (const issueId of createdIssueIds) {
          await linearClient.deleteIssue(issueId); // Use deleteIssue for cleanup
        }
        console.log('Successfully deleted Linear issues for search test.');
      } catch (error) {
        console.error('Error deleting Linear issues for search test:', error);
      }
    }
    // Clean up Redis keys if necessary, but avoid disconnecting shared client
    if (redisClient.status === 'ready' || redisClient.status === 'connect') {
        const keys = await redisClient.keys(`${testSessionIdPrefix}*`);
        if (keys.length > 0) {
            console.warn(`Cleaning up ${keys.length} lingering search test keys...`);
            await redisClient.del(keys);
        }
    }
  });

  beforeEach(async () => {
    currentTestSessionId = `${testSessionIdPrefix}${randomUUID()}`;
    // Note: Initial state setup is now within the 'it' block
  });

  afterEach(async () => {
    if ((redisClient.status === 'ready' || redisClient.status === 'connect') && currentTestSessionId) {
      await redisClient.del(currentTestSessionId);
    }
  });

  // Test case: Simulate a search request
  it('should handle a user request requiring linear_search', async () => {
    const searchIssueTitle = 'E2E Test Issue for Search: refactor state management';
    const searchIssue = await linearClient.createIssue({
      title: searchIssueTitle,
      description: 'This is a temporary issue created for E2E testing of linear_search.',
      projectId: E2E_PROJECT_ID,
      teamId: E2E_TEAM_ID, 
    });
    const searchIssueId = (await searchIssue.issue)?.id;
    if (!searchIssueId) throw new Error('Failed to create issue for search test');
    createdIssueIds.push(searchIssueId);

    const userInput = "Search for Linear issues mentioning 'refactor state management'";
    const initialState = createInitialAgentState(currentTestSessionId, {
      focus: { type: 'project', id: E2E_PROJECT_ID },
    });
    await saveAgentState(currentTestSessionId, initialState);

    const turnOutput = await runConversationTurn(currentTestSessionId, userInput) as AgentTurnOutput;

    // --- Assertions ---
    expect(turnOutput).toBeDefined();
    
    // 1. Check the tool call and its structured output FIRST
    expect(turnOutput.toolResult).toBeDefined();
    expect(turnOutput.toolResult?.toolName).toBe('linear_search');
    
    const toolStructuredOutput = turnOutput.toolResult?.structuredOutput as LinearSearchResult;
    expect(toolStructuredOutput).toBeDefined();
    expect(toolStructuredOutput.success).toBe(true);
    expect(toolStructuredOutput.outcome).toBe(SearchOutcome.FOUND_RESULTS);
    expect(toolStructuredOutput.results).toBeInstanceOf(Array);
    expect(toolStructuredOutput.results.length).toBeGreaterThanOrEqual(1);

    const foundTestIssue = toolStructuredOutput.results.find(
      (issue: Issue) => issue.id === searchIssueId || issue.title.includes('refactor state management')
    );
    expect(foundTestIssue).toBeDefined(); // Check if the specific issue created for the test was found

    // 2. Check the final text response (summary from LLM)
    // This can be more lenient now that we've confirmed the tool worked.
    const responseText = turnOutput.textResponse;
    expect(responseText).toBeDefined();
    expect(typeof responseText).toBe('string');
    // Optionally, a very lenient check that it mentions the search or the found item
    expect(responseText.toLowerCase()).toMatch(/search|found|refactor state management/i); 
    
    // Check for additional indicators of a successful search call
    expect(turnOutput.intent).toBeDefined();
    if (turnOutput.toolResult) {
      expect(turnOutput.toolResult.toolName).toBe('linear_search');
    }

    // Verify state update
    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState).toBeDefined();
    
    // Check conversation history more flexibly
    expect(finalState?.conversation_history.length).toBeGreaterThanOrEqual(4);

    // 1. User message is first
    expect(finalState?.conversation_history[0].role).toBe('user');
    expect(finalState?.conversation_history[0].content).toContain(userInput);

    // 2. Assistant message with functionCall for linear_search
    const assistantFunctionCallMessage = finalState?.conversation_history.find(
      msg => msg.role === 'assistant' && msg.content.includes('"functionCall":{"name":"linear_search"')
    );
    expect(assistantFunctionCallMessage).toBeDefined();

    // 3. Tool message for linear_search containing the searchIssueTitle
    const toolMessage = finalState?.conversation_history.find(
      msg => msg.role === 'tool' && msg.content.includes('"name":"linear_search"')
    );
    expect(toolMessage).toBeDefined();
    // The content of the tool message in history is the JSON string of LinearSearchResult
    // We've already validated the structured output from turnOutput.toolResult, 
    // but we can ensure the title is in this stringified version too.
    expect(toolMessage?.content.toLowerCase()).toContain(searchIssueTitle.toLowerCase());
    expect(toolMessage?.content).toMatch(/"outcome":"FOUND_RESULTS"/); 
    expect(toolMessage?.content).toMatch(/"output":{.*}/); // Check for tool output structure

    // 4. The last assistant message is the final responseText
    const lastAssistantMessage = finalState?.conversation_history.findLast(msg => msg.role === 'assistant');
    expect(lastAssistantMessage).toBeDefined();
    expect(lastAssistantMessage?.content).toBe(responseText);

  }, 60000);

}); 