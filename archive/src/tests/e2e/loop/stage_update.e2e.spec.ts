import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop';
import { saveAgentState, loadAgentState } from '@/state/manager';
import { redisClient } from '@/redis/client';
import { createInitialAgentState, LINEAR_API_KEY, E2E_PROJECT_ID, E2E_TEAM_ID } from '@tests/shared/linear-e2e.config';
import type { AgentState, StagedChange, ConversationMessage } from '@/state/types';
import type { TemporaryFriendlyId } from '@/types/linear-ids';

// Ensure necessary env vars are set (GEMINI_API_KEY check)
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}

describe('Loop E2E - stage_update', () => {
  const testSessionIdPrefix = 'test-session-e2e-loop-stage-update-';
  let currentTestSessionId: string;
  // No Linear client needed

  beforeAll(async () => {
    // Redis connection logic
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
  });

  afterAll(async () => {
    // Redis cleanup
    if (redisClient.status === 'ready' || redisClient.status === 'connect') {
        const keys = await redisClient.keys(`${testSessionIdPrefix}*`);
        if (keys.length > 0) {
            console.warn(`Cleaning up ${keys.length} lingering stage_update test keys...`);
            await redisClient.del(keys);
        }
    }
  });

  beforeEach(async () => {
    currentTestSessionId = `${testSessionIdPrefix}${randomUUID()}`;
  });

  afterEach(async () => {
    if ((redisClient.status === 'ready' || redisClient.status === 'connect') && currentTestSessionId) {
      await redisClient.del(currentTestSessionId);
    }
  });

  // Test case: stage_update
  it('should handle stage_update to modify a staged change', async () => {
    const initialChange: StagedChange = {
      opType: 'issue.create',
      data: { title: 'Original Title', labels: ['bug'] },
      tempId: 'TMP-150' as TemporaryFriendlyId
    };
    const exampleHistory: ConversationMessage[] = [
        {
            role: 'user',
            content: "Stage creating an issue 'Example Task' with temp id TMP-10",
        },
        {
            role: 'assistant',
            content: '(Requesting tool call: stage_add)', 
        },
        {
            role: 'tool',
            content: JSON.stringify({ name: 'stage_add', response: { result: "Change staged successfully. Assigned temporary ID: TMP-10" } }),
        },
        {
            role: 'assistant',
            content: "Okay, I've staged the creation of issue 'Example Task' with temporary ID TMP-10.",
        },
    ];
    const initialState = createInitialAgentState(currentTestSessionId, {
      conversation_history: exampleHistory,
      staged_changes: [initialChange],
    });
    await saveAgentState(currentTestSessionId, initialState);

    // Make the prompt more explicit about the required structure for the tool
    const userInput = `Please stage an update for the change with tempId TMP-150. The update object should contain: opType 'issue.create', tempId 'TMP-150', and data { title: "Updated E2E Title", labels: ["urgent"] }`;
    const finalResponseOutput = await runConversationTurn(currentTestSessionId, userInput);

    // Assertions
    expect(finalResponseOutput).toBeDefined();
    expect(finalResponseOutput?.textResponse).toBeDefined();
    expect(finalResponseOutput!.textResponse.toLowerCase()).toMatch(/updated|modified|changed|tmp-150/);

    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState).toBeDefined();

    // Verify the staged change was updated correctly - this is the primary goal
    expect(finalState?.staged_changes).toHaveLength(1);
    const updatedChange = finalState?.staged_changes[0];
    expect(updatedChange?.tempId).toBe('TMP-150');
    expect(updatedChange?.opType).toBe('issue.create'); 
    expect(updatedChange?.data).toBeTypeOf('object');
    expect(updatedChange?.data.title).toBe('Updated E2E Title');
    expect(updatedChange?.data.labels).toBeDefined();
    expect(updatedChange?.data.labels).toContain('urgent');

    // Verify that the stage_update tool was called successfully
    const stageUpdateToolCall = finalState?.conversation_history.find(
      message => message.role === 'tool' && message.content.includes('"name":"stage_update"')
    );
    expect(stageUpdateToolCall).toBeDefined();
    
    let parsedToolContent;
    try {
      parsedToolContent = JSON.parse(stageUpdateToolCall!.content);
    } catch (e) {
      throw new Error(`Failed to parse tool message content as JSON: ${stageUpdateToolCall?.content}`);
    }

    expect(parsedToolContent.name).toBe('stage_update');
    expect(parsedToolContent.output).toBeDefined();
    expect(parsedToolContent.output.success).toBe(true);
    expect(parsedToolContent.output.outcome).toBe('SUCCESS_UPDATED');
    expect(parsedToolContent.output.updatedTempId).toBe('TMP-150');

    // Verify that the final assistant response is present in the history
    const lastAssistantMessage = finalState?.conversation_history.findLast(message => message.role === 'assistant');
    expect(lastAssistantMessage).toBeDefined();
    expect(lastAssistantMessage?.content?.endsWith(finalResponseOutput!.textResponse)).toBe(true);

  }, 60000);

}); 