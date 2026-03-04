import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop'; // Adjust path
import { StagedChange, AgentState } from '@/state/types'; // Adjust path
import type { TemporaryFriendlyId } from '@/types/linear-ids'; // Adjust path
import { saveAgentState, loadAgentState } from '@/state/manager'; // Adjust path
import { redisClient } from '@/redis/client'; // Adjust path
import { 
  createInitialAgentState 
} from '@tests/shared/linear-e2e.config'; // Adjust path

// Ensure necessary env vars are set (GEMINI_API_KEY check)
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}

describe('Loop E2E - stage_list', () => {
  const testSessionIdPrefix = 'test-session-e2e-loop-stage-list-';
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
            console.warn(`Cleaning up ${keys.length} lingering stage_list test keys...`);
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

  // Test case: stage_list
  it('should handle stage_list after a change has been staged', async () => {
    const initialStagedChange: StagedChange = {
      opType: 'issue.create',
      data: { title: 'Existing Test Issue', priority: 0 },
      tempId: 'TMP-5' as TemporaryFriendlyId
    };
    const initialState: AgentState = createInitialAgentState(currentTestSessionId, {
      conversation_history: [
        { role: 'user', content: 'previous interaction' },
        { role: 'assistant', content: 'staged TMP-5' }
      ],
      staged_changes: [initialStagedChange],
    });
    await saveAgentState(currentTestSessionId, initialState);

    const userInput = "What changes are currently staged?";
    const finalResponseOutput = await runConversationTurn(currentTestSessionId, userInput);

    // Assertions
    expect(finalResponseOutput).toBeDefined();
    // Ensure finalResponseOutput and its textResponse property are defined before calling toLowerCase()
    expect(finalResponseOutput?.textResponse).toBeDefined();

    // NEW ASSERTIONS for structured output:
    expect(finalResponseOutput!.intent).toBe('AWAITING_CONFIRMATION');
    expect(finalResponseOutput!.toolResult).toBeDefined();
    expect(finalResponseOutput!.toolResult?.toolName).toBe('stage_list');

    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState).toBeDefined();
    // History: Initial (2) + User -> Assistant (tool call) -> Tool Result -> Assistant (final) = 6
    expect(finalState?.conversation_history).toHaveLength(6);
    const toolMessage = finalState?.conversation_history[4];
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.content).toBeDefined();

    let parsedToolContent;
    try {
      parsedToolContent = JSON.parse(toolMessage!.content);
    } catch (e) {
      throw new Error(`Failed to parse tool message content as JSON: ${toolMessage?.content}`);
    }

    expect(parsedToolContent.name).toBe('stage_list');
    expect(parsedToolContent.output).toBeDefined();
    expect(parsedToolContent.output.success).toBe(true);
    expect(parsedToolContent.output.stagedChanges).toBeInstanceOf(Array);
    expect(parsedToolContent.output.stagedChanges).toHaveLength(1);
    const stagedChangeInOutput = parsedToolContent.output.stagedChanges[0];
    expect(stagedChangeInOutput.opType).toBe('issue.create');
    expect(stagedChangeInOutput.tempId).toBe('TMP-5');
    expect(stagedChangeInOutput.data?.title).toBe('Existing Test Issue');

    // Verify staged_changes in agent state remain unchanged by stage_list
    expect(finalState?.staged_changes).toHaveLength(1);

  }, 60000);

}); 