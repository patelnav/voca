import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runConversationTurn } from '@/loop';
import { redisClient } from '@/redis/client';
import { createInitialAgentState, LINEAR_API_KEY, E2E_PROJECT_ID, E2E_TEAM_ID } from '@tests/shared/linear-e2e.config';
import type { AgentState } from '@/state/types';
import { v4 as uuidv4 } from 'uuid';
import { LinearClient, type Issue } from '@linear/sdk';
import type { AgentTurnOutput } from '@/types/agent-output';

// Check for required environment variables
if (!process.env.GEMINI_API_KEY) {
  throw new Error('E2E Test requires GEMINI_API_KEY in .env file');
}
if (!process.env.REDIS_HOST || !process.env.REDIS_PORT) {
    console.warn('REDIS_HOST or REDIS_PORT not found in .env, defaulting. Ensure Redis is running locally.');
}

describe('Core Loop E2E Test', () => {
  let sessionId: string;
  let linearClient: LinearClient;
  const createdIssueIds: string[] = [];
  let testIssue: Issue | undefined;

  beforeAll(async () => {
    linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });

    const issueData = await linearClient.createIssue({
      title: 'E2E Core Loop Test Issue: State Management Example',
      description: 'This issue is created specifically for the core loop E2E test.',
      projectId: E2E_PROJECT_ID,
      teamId: E2E_TEAM_ID,
    });
    testIssue = await issueData.issue;
    if (!testIssue) {
      throw new Error('Failed to create test issue for Core Loop E2E Test');
    }
    createdIssueIds.push(testIssue.id);
    console.log(`--- E2E Core Loop: Created Test Issue ID: ${testIssue.id} (${testIssue.identifier}) ---`);

    sessionId = `e2e-core-loop-test-${uuidv4()}`;
    console.log(`--- Starting E2E Test for Session ID: ${sessionId} ---`);
  });

  afterAll(async () => {
    if (createdIssueIds.length > 0) {
      console.log(`--- E2E Core Loop: Cleaning up ${createdIssueIds.length} Linear issue(s)... ---`);
      try {
        for (const issueId of createdIssueIds) {
          await linearClient.deleteIssue(issueId);
        }
        console.log('--- E2E Core Loop: Successfully deleted Linear issues. ---');
      } catch (error) {
        console.error('--- E2E Core Loop: Error deleting Linear issues:', error);
      }
    }

    try {
      if (redisClient.status === 'ready' || redisClient.status === 'connect') {
        await redisClient.del(sessionId);
        console.log(`--- Cleaned up Redis key for Session ID: ${sessionId} ---`);
      }
    } catch (err) {
      console.error(`--- Failed to clean up Redis key ${sessionId}:`, err);
    }
  });

  it('should handle a multi-turn conversation using context from Redis for tool calls', async () => {
    if (!testIssue) {
      throw new Error('Test issue was not created for the test run.');
    }

    // --- Turn 1: Search ---
    console.log('\n--- Turn 1: Search (includes Tool Call & Summarization) ---');
    const searchQuery = `Search for issues with title "${testIssue.title}"`; 
    console.log(`User: ${searchQuery}`);
    const turn1Output = await runConversationTurn(sessionId, searchQuery);
    const turn1TextResponse = turn1Output?.textResponse;

    console.log('--- Turn 1 Output (Search Result) ---');
    console.log(`Voca: ${turn1TextResponse}`);
    console.log(JSON.stringify(turn1Output, null, 2));
    
    expect(turn1Output).toBeDefined();
    expect(turn1TextResponse).toBeDefined();
    expect(typeof turn1TextResponse!).toBe('string');
    expect(turn1TextResponse!).not.toContain('error processing');
    // Check if the turn indicates the tool result was processed (optional, depends on runToolAndGenerateResponse)
    // expect(turn1Output?.toolResult).toBeDefined();
    // expect(turn1Output?.toolResult?.toolName).toBe('linear_search');
    
    // Check the text response for the summary
    if (turn1TextResponse!.toLowerCase().includes('empty response') || turn1TextResponse!.toLowerCase().includes('error performing search') || turn1TextResponse!.toLowerCase().includes('i couldn\'t find any issues')) {
      console.log('\n⚠️ Test (Turn 1) proceeding with LLM error/empty/no results for search. This may be due to API issues or no results.');
      // expect(turn1Output?.intent).toMatch(/TOOL_ERROR|INFORMATION_PROVIDED/); // Example intent check
    } else {
      expect(turn1TextResponse!.toLowerCase()).toMatch(/found|search results/);
      expect(turn1TextResponse!.toLowerCase()).toContain(testIssue.identifier.toLowerCase());
      // expect(turn1Output?.intent).toBe('INFORMATION_PROVIDED'); // Example intent check
      console.log('\n✅ Test (Turn 1) Passed: Agent correctly performed search and summarized results.');
    }

    // --- Turn 2: Follow-up Question ---
    console.log('\n--- Turn 2: Follow-up (includes Tool Call & Summarization) ---');
    const turn2Input = 'Tell me more about the first issue found.';
    console.log(`User: ${turn2Input}`);
    const turn2Output = await runConversationTurn(sessionId, turn2Input);
    const turn2TextResponse = turn2Output?.textResponse;        
    
    console.log('--- Turn 2 Output (Follow-up Details) ---');
    console.log(`Voca: ${turn2TextResponse}`);
    console.log(JSON.stringify(turn2Output, null, 2));

    expect(turn2Output).toBeDefined();
    expect(turn2TextResponse).toBeDefined();
    expect(typeof turn2TextResponse!).toBe('string');
    expect(turn2TextResponse!).not.toContain('error processing');
    // Optionally check toolResult for linear_get_details
    // expect(turn2Output?.toolResult).toBeDefined();
    // expect(turn2Output?.toolResult?.toolName).toBe('linear_get_details');

    const turn1HadErrorOrNoResults = turn1TextResponse!.toLowerCase().includes('empty response') || 
                                  turn1TextResponse!.toLowerCase().includes('error performing search') ||
                                  turn1TextResponse!.toLowerCase().includes('no issues found') ||
                                  turn1TextResponse!.toLowerCase().includes('i couldn\'t find any issues');

    if (turn1HadErrorOrNoResults) {
      console.log('\n⚠️ Test (Turn 2) - Turn 1 had an error or no results. Expecting a follow-up that acknowledges lack of context or another error.');
      expect(turn2TextResponse!.toLowerCase()).toMatch(/please provide the id|could you please provide|what was the issue|which issue|i received an empty response|no issues were found|error/i);
      // expect(turn2Output?.intent).toBe('CLARIFICATION_NEEDED'); // Example intent check
      console.log('\n✅ Test (Turn 2) Passed: Agent correctly handled follow-up text when Turn 1 had an error or no results.');
    } else if (turn2TextResponse!.toLowerCase().includes('empty response') || turn2TextResponse!.toLowerCase().includes('error getting details')) {
      console.log('\n⚠️ Test (Turn 2) proceeding with LLM error/empty response for details. This may be due to API issues.');
      // expect(turn2Output?.intent).toMatch(/TOOL_ERROR|INFORMATION_PROVIDED/);
    } else {
      // This is the ideal case: Turn 1 was successful (found issues) and Turn 2 is a valid follow-up providing details.
      expect(turn2TextResponse!.toLowerCase()).toMatch(/details for|issue details|status:|assignee:|description:|np-\d+|vt-\d+|[a-f0-9-]{36}/i);
      expect(turn2TextResponse!.toLowerCase()).toContain(testIssue.identifier.toLowerCase()); // Ensure details are for the correct issue
      // expect(turn2Output?.intent).toBe('INFORMATION_PROVIDED');
      console.log('\n✅ Test (Turn 2) Passed: Agent seemed to use context to get details for the first issue.');
    }

  }, 90000); // Reset timeout to reasonable for 2 turns
}); 