/// <reference types="vitest" />
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { AgentState } from '@/state/types';
import type { LinearGuid } from '@/types/linear-ids';
import { saveAgentState } from '@/state/manager';
import { redisClient } from '@/redis/client';
import { LinearClient } from '@linear/sdk';
import { LINEAR_API_KEY, createInitialAgentState } from '@tests/shared/linear-e2e.config';
import { GeminiClient } from '@/api/core/gemini-client';
import type { ChatMessage } from '@/api/core/interfaces';
import { runToolAndGenerateResponse } from '@/loop/tool-execution';
import { getLinearClient } from '@/linear/client';
import { produce } from 'immer';

/**
 * IMPORTANT NOTE ABOUT THE 500 ERROR
 * 
 * During test runs of agent.linear-interaction.e2e.spec.ts, we observed 500 Internal Server Errors
 * from the Gemini API specifically during the post-tool summarization call.
 * 
 * The pattern is:
 * 1. The user requests to stage an update to an issue (with stateId and comment)
 * 2. The LLM calls the stage_add tool successfully
 * 3. The stage_add tool executes successfully and returns its output
 * 4. The agent then calls the LLM again to "summarize" the tool output into a user-friendly message
 * 5. This summarization call fails with a 500 Internal Server Error from the Gemini API
 * 
 * This test isolates the direct GeminiClient call that reproduces this error.
 */

// Ensure necessary env vars are set
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}
// LINEAR_API_KEY is not strictly needed for this isolated test, but keeping for now if other parts of your test runner expect it.
// if (!process.env.LINEAR_API_KEY) { // Assuming LINEAR_API_KEY might be loaded from .env via a global setup
//   throw new Error('Missing required environment variable: LINEAR_API_KEY for E2E tests.');
// }

describe('Isolated E2E - Summarization 500 Error after stage_add', () => {
  const testSessionIdPrefix = 'test-session-e2e-repro-500-';
  let currentTestSessionId: string;
  let linearClient: LinearClient;

  beforeAll(async () => {
    linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });
    // Redis connection logic
    if (redisClient.status !== 'ready' && redisClient.status !== 'connect') {
      try {
        if (redisClient.status !== 'connecting') {
          await redisClient.connect();
        } else {
          // If already connecting, wait for 'ready' or 'error'
          await new Promise<void>((resolve, reject) => {
            redisClient.once('ready', resolve);
            redisClient.once('error', (err) => reject(new Error(`Redis connection error during beforeAll: ${err.message || err}`)) );
            // Add a timeout to prevent hanging indefinitely if 'ready' or 'error' never fires
            setTimeout(() => reject(new Error('Redis connection attempt timed out in beforeAll')), 10000);
          });
        }
        console.log('Redis client connected successfully for repro_summarization_500 tests.');
      } catch (err: any) {
        console.error('Failed to ensure Redis client connection for repro_summarization_500 tests:', err.message || err);
        // Rethrow to fail the test suite if Redis can't connect, as it's essential.
        throw new Error(`Failed to connect to Redis: ${err.message || err}`);
      }
    }
  }, 30000); // Increased timeout for beforeAll

  afterAll(async () => {
    // General Redis Cleanup for this test suite's prefix
    if (redisClient.status === 'ready' || redisClient.status === 'connect') {
      try {
        const keys = await redisClient.keys(`${testSessionIdPrefix}*`);
        if (keys.length > 0) {
          console.warn(`Cleaning up ${keys.length} lingering repro_summarization_500 test keys: ${keys.join(', ')}`);
          await redisClient.del(keys);
        }
      } catch (err: any) {
         console.error('Error during general Redis cleanup in afterAll for repro_summarization_500:', err.message || err);
      }
      // Consider disconnecting the client if it was solely for this test suite and no other tests are running after
      // await redisClient.quit(); 
    }
  });

  beforeEach(async () => {
    currentTestSessionId = `${testSessionIdPrefix}${randomUUID()}`;
    // Initial state is set within the test itself for clarity
  });

  afterEach(async () => {
    if ((redisClient.status === 'ready' || redisClient.status === 'connect') && currentTestSessionId) {
      try {
        await redisClient.del(currentTestSessionId);
      } catch (err: any) {
        console.error(`Error deleting session key ${currentTestSessionId} in afterEach:`, err.message || err);
      }
    }
  });

  it('should reproduce error patterns using direct GeminiClient calls', async () => {
    const fakeIssueGuid = '61f6bf32-0888-44d3-80ef-c582c96c0e14';
    const fakeStateId = '034b5215-8a0c-4e92-a1bf-8b3e2583a372';

    // Create a realistic message sequence based on what would happen in the real agent flow
    const historyFixture = [
      {
        role: "user" as const,
        parts: [
          {
            text: "Okay, stage an update for issue TES-301 to state ID " + fakeStateId + ". Also add a comment: \"This is now being worked on.\""
          }
        ]
      },
      {
        role: "model" as const,
        parts: [
          {
            text: "I will stage that update for TES-301." // Initial textual response
          }
        ]
      },
      {
        role: "model" as const,
        parts: [
          {
            functionCall: {
              name: "stage_add",
              args: {
                pre_execution_narration: "Okay, I will stage the update for TES-301.",
                change: {
                  data: {
                    id: fakeIssueGuid,
                    stateId: fakeStateId,
                    comment: "This is now being worked on."
                  },
                  opType: "issue.update"
                }
              }
            }
          }
        ]
      },
      {
        role: "function" as const,
        parts: [
          {
            functionResponse: {
              name: "stage_add",
              response: {
                output: "Change staged successfully. Full details have been recorded."
              }
            }
          }
        ]
      }
    ];

    const geminiClient = new GeminiClient(undefined, true); // true for debug

    const clonedFixture = JSON.parse(JSON.stringify(historyFixture));
    
    // Ensure the fixture conforms to ChatMessage structure
    const historyMessages: ChatMessage[] = clonedFixture.map((m: any) => {
      // Basic validation/mapping (adjust if fixture structure is complex)
      if (!m.role || !Array.isArray(m.parts)) {
          throw new Error('Invalid fixture structure');
      }
      return {
          role: m.role,
          parts: m.parts.map((p: any) => {
              if (p.text !== undefined) return { text: p.text };
              if (p.functionCall !== undefined) return { functionCall: p.functionCall };
              if (p.functionResponse !== undefined) return { functionResponse: p.functionResponse };
              throw new Error(`Invalid part in fixture: ${JSON.stringify(p)}`);
          })
      };
    });

    // --- Construct a realistic system prompt ---
    const simplifiedSystemContext = `
You are Voca, an AI assistant.
Current Context:
- User asked to stage an update for TES-301.
- Tool 'stage_add' was called and succeeded.
- Staged Changes: 1 change pending.
System Instructions: Summarize the tool output concisely.
LLM Scratchpad: User wants to update TES-301 to In Progress with a comment. Called stage_add. Tool succeeded.
`; 
    const systemMessage: ChatMessage = { role: 'system', content: simplifiedSystemContext };
    // --- End System Prompt Construction ---

    const messagesForClient: ChatMessage[] = [systemMessage, ...historyMessages];


    console.log(`[REPRO-500-TEST] Calling generateContentWithTools with a realistic message sequence (including system prompt) from agent.linear-interaction.e2e.spec.ts`);
    console.log(`[REPRO-500-TEST] Message count: ${messagesForClient.length}, First message role: ${messagesForClient[0]?.role}`);


    try {
      await geminiClient.generateContentWithTools(messagesForClient);
      console.log('[REPRO-500-TEST] API call succeeded, which is unexpected as we are trying to reproduce error conditions');
      expect.fail('Expected API error but call succeeded');
    } catch (error: any) {
      console.log(`[REPRO-500-TEST] Error caught as expected: ${error.message}`);
      expect(error.message).toContain('status:'); 
      if (error.message.includes('400 Bad Request')) {
        console.log('[REPRO-500-TEST] Got 400 error - this is a client/request formatting issue');
      } else if (error.message.includes('500 Internal Server Error') || error.message.includes('INTERNAL')) {
        console.log('[REPRO-500-TEST] Successfully reproduced 500 error!');
      } else {
        console.log(`[REPRO-500-TEST] Got other error type: ${error.message.substring(0, 100)}`);
      }
    }
      
  }, 90000); 
});