import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop';
import { StagedChange, ConversationMessage, AgentState } from '@/state/types';
import type { TemporaryFriendlyId } from '@/types/linear-ids';
import { saveAgentState, loadAgentState } from '@/state/manager';
import { redisClient } from '@/redis/client';
import { createInitialAgentState, LINEAR_API_KEY, E2E_PROJECT_ID, E2E_TEAM_ID } from '@tests/shared/linear-e2e.config';

// Ensure necessary env vars are set (GEMINI_API_KEY check)
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}

describe('Loop E2E - stage_remove', () => {
  const testSessionIdPrefix = 'test-session-e2e-loop-stage-remove-';
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
            console.warn(`Cleaning up ${keys.length} lingering stage_remove test keys...`);
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

  // Test case: stage_remove
  it('should handle stage_remove to remove a staged change', async () => {
    const changeToRemove: StagedChange = {
      opType: 'issue.create',
      data: { title: 'Issue to Remove' },
      tempId: 'TMP-99' as TemporaryFriendlyId
    };
     const changeToKeep: StagedChange = {
      opType: 'issue.update',
      data: { description: 'Keep this one' },
      tempId: 'TMP-101' as TemporaryFriendlyId
    };
    const initialState = createInitialAgentState(currentTestSessionId, {
      staged_changes: [changeToRemove, changeToKeep],
    });
    await saveAgentState(currentTestSessionId, initialState);

    const userInput = "Remove staged change TMP-99";
    const finalResponseOutput = await runConversationTurn(currentTestSessionId, userInput);

    // Assertions
    expect(finalResponseOutput).toBeDefined();
    // Ensure finalResponseOutput and its textResponse property are defined before calling toLowerCase()
    expect(finalResponseOutput?.textResponse).toBeDefined();
    expect(finalResponseOutput!.textResponse.toLowerCase()).toMatch(/removed|deleted|cancelled|tmp-99/);

    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState).toBeDefined();
    // History: User -> Assistant (tool call + initial text) -> Tool Result -> Assistant (final summary)
    expect(finalState?.conversation_history).toHaveLength(4);
    const toolMessage = finalState?.conversation_history[2];
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.content).toBeDefined();

    let parsedToolContent;
    try {
      parsedToolContent = JSON.parse(toolMessage!.content);
    } catch (e) {
      throw new Error(`Failed to parse tool message content as JSON: ${toolMessage?.content}`);
    }

    expect(parsedToolContent.name).toBe('stage_remove');
    expect(parsedToolContent.output).toBeDefined();
    expect(parsedToolContent.output.success).toBe(true);
    expect(parsedToolContent.output.outcome).toBe('SUCCESS_REMOVED'); 
    expect(parsedToolContent.output.removedTempId).toBe('TMP-99');

    // Verify staged_changes: only the one to keep should remain
    expect(finalState?.staged_changes).toHaveLength(1);
    expect(finalState?.staged_changes[0].tempId).toBe('TMP-101');
    expect(finalState?.staged_changes.find(c => c.tempId === 'TMP-99')).toBeUndefined();

  }, 60000);

}); 