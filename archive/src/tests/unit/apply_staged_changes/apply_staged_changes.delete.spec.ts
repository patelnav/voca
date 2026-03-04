import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apply_staged_changes } from '@/tools/linear_apply';
import { saveAgentState, loadAgentState } from '@/state/manager';
import type { AgentState, StagedChange } from '@/state/types';
import { createTemporaryFriendlyId, asLinearGuid } from '@/types/linear-ids'; // For creating/casting IDs
import { executeLinearOperation } from '@/tools/linear_sdk_helpers'; // We will mock only this export
import { redisClient } from '@/redis/client'; // For cleanup
import { createMockLinearClient, type MockLinearClientInterface } from '@tests/shared/mocks/linear_client.mock';
import crypto from 'crypto'; // For UUID generation
import { produce } from 'immer';
import { ApplyOutcome } from '@/tools/linear_apply'; // <<< Added Import

// Mock only executeLinearOperation from linear_sdk_helpers
// Other functions like resolveIdentifiers will be the real implementations.
vi.mock('@/tools/linear_sdk_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/linear_sdk_helpers')>();
  return {
    ...actual,
    executeLinearOperation: vi.fn(), // This is the only function we mock from this module
  };
});

// enrichStagedChangeData will be the real implementation (no mock for ../../../linear/enrichment)

// Mock the logger to prevent console noise during tests
vi.mock('@/utils/logger', () => ({
  Logger: {
    getInstance: vi.fn(() => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarning: vi.fn(),
      logInfo: vi.fn(),
      logDebug: vi.fn(),
      logCli: vi.fn(),
    })),
  },
}));

describe('apply_staged_changes with delete operations (real persistence, real enrichment/resolution)', () => {
  const sessionId = 'test-agent-delete-flow-persist-real-helpers'; // Unique session ID
  const mockExecuteLinearOperation = vi.mocked(executeLinearOperation);
  let mockLinearClient: MockLinearClientInterface;

  beforeEach(async () => {
    mockExecuteLinearOperation.mockReset();
    mockLinearClient = createMockLinearClient();
    await redisClient.del(sessionId);
  });

  afterEach(async () => {
    await redisClient.del(sessionId);
  });

  it('should stage create, apply create, stage delete, apply delete, and then verify staged_changes is empty', async () => {
    const initialAgentState: AgentState = {
      sessionId: sessionId,
      conversation_history: [],
      focus: null,
      staged_changes: [],
      id_map: {},
      team_workflows: {},
      issue_team_map: {},
      status: 'idle',
      llm_scratchpad: '',
      current_plan: null,
      plan_step_outputs: {},
    };
    await saveAgentState(sessionId, initialAgentState);
    let agentState = await loadAgentState(sessionId);
    expect(agentState.staged_changes).toEqual([]);

    const createTempId = createTemporaryFriendlyId(1);
    const createChangeData = { title: 'Test Issue for Delete Flow', description: 'This is a test issue.', teamId: asLinearGuid(crypto.randomUUID()) };
    const createChange: StagedChange = {
      opType: 'issue.create',
      tempId: createTempId,
      data: createChangeData,
    };
    // Simulate adding to state then saving (as runConversationTurn would do after a staging tool call)
    let stateAfterStageCreate = produce(agentState, draft => {
        draft.staged_changes = [...draft.staged_changes, createChange];
    });
    await saveAgentState(sessionId, stateAfterStageCreate);

    const createdIssueGuidValue = crypto.randomUUID();
    const createdIssueGuid = asLinearGuid(createdIssueGuidValue);

    // Mock for the CREATE operation (executeLinearOperation is the only one mocked now)
    mockExecuteLinearOperation.mockResolvedValueOnce({
      success: true,
      newId: createdIssueGuid, 
    });

    agentState = await loadAgentState(sessionId); 
    const {newState: stateAfterApplyCreate, output: createOutput} = await apply_staged_changes({}, agentState, mockLinearClient);
    const { success: createSuccess, outcome: createOutcome } = createOutput; // Destructure from output
    expect(createSuccess).toBe(true);
    expect(createOutcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    await saveAgentState(sessionId, stateAfterApplyCreate); // Simulate runConversationTurn saving the new state

    agentState = await loadAgentState(sessionId); 
    expect(agentState.staged_changes.length).toBe(0);
    expect(agentState.id_map[createTempId]).toBe(createdIssueGuid);

    const deleteTempId = createTemporaryFriendlyId(2);
    const deleteChange: StagedChange = {
      opType: 'issue.delete',
      tempId: deleteTempId,
      data: { id: createdIssueGuid }, 
    };
    // Simulate adding to state then saving
    let stateAfterStageDelete = produce(agentState, draft => {
        draft.staged_changes = [...draft.staged_changes, deleteChange];
    });
    await saveAgentState(sessionId, stateAfterStageDelete);
    
    // Mock for the DELETE operation (executeLinearOperation is the only one mocked now)
    mockExecuteLinearOperation.mockResolvedValueOnce({
      success: true, // No newId for delete
    });

    agentState = await loadAgentState(sessionId); 
    const {newState: stateAfterApplyDelete, output: deleteOutput} = await apply_staged_changes({}, agentState, mockLinearClient);
    const { success: deleteSuccess, outcome: deleteOutcome } = deleteOutput; // Destructure from output
    expect(deleteSuccess).toBe(true);
    expect(deleteOutcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    await saveAgentState(sessionId, stateAfterApplyDelete); // Simulate runConversationTurn saving the new state

    agentState = await loadAgentState(sessionId);
    expect(agentState.staged_changes.length).toBe(0);
    expect(agentState.id_map[deleteTempId]).toBeUndefined();
    expect(agentState.id_map[createTempId]).toBe(createdIssueGuid);
  });
}); 