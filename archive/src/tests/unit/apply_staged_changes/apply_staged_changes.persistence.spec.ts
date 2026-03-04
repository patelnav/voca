/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apply_staged_changes } from '@/tools/linear_apply';
import type { AgentState, StagedChange } from '@/state/types';
import type { TemporaryFriendlyId, LinearGuid } from '@/types/linear-ids';
// Use real state manager functions, but don't import the client directly
import { saveAgentState, loadAgentState } from '@/state/manager'; 
import { executeLinearOperation } from '@/tools/linear_sdk_helpers';
import { createInitialAgentState } from '@tests/shared/linear-e2e.config'; 
import { createMockGuid } from '@tests/shared/testUtils';
import { createMockLinearClient, type MockLinearClientInterface } from '@tests/shared/mocks/linear_client.mock';
import { ApplyOutcome } from '@/tools/linear_apply';

// Mock only the direct SDK helper, not the state manager
vi.mock('@/tools/linear_sdk_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/linear_sdk_helpers')>();
  return {
    ...actual,
    // We don't mock resolveIdentifiers fully here, assume it works or isn't needed if executeLinearOperation is mocked simply
    resolveIdentifiers: actual.resolveIdentifiers, // Use real resolveIdentifiers? Or mock simply? Let's start simple.
    // Mock executeLinearOperation to *reliably* return success + newId to isolate state persistence
    executeLinearOperation: vi.fn(),
  };
});

// Mock enrichment as it involves external calls potentially
vi.mock('@/linear/enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/linear/enrichment')>();
  return {
    ...actual,
    enrichStagedChangeData: vi.fn().mockImplementation(async (change) => change.data), // Simple pass-through mock
    EnrichmentError: actual.EnrichmentError,
  };
});


describe('apply_staged_changes - Persistence Tests (using real Redis)', () => {
  const mockExecuteLinearOperation = vi.mocked(executeLinearOperation);
  let mockLinearClient: MockLinearClientInterface;
  let currentTestSessionId = '';

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear mocks
    mockLinearClient = createMockLinearClient(); 
    const randomSuffix = Math.random().toString(36).substring(2, 10); // Generate random 8-char suffix
    currentTestSessionId = `test-session-persist-${randomSuffix}`;
    console.log(`Using Session ID for test: ${currentTestSessionId}`);
    // Removed direct Redis connection check and cleanup here.
    // Assuming save/load handle connection and unique ID provides isolation.
  });

  afterEach(async () => {
    // Optional: Consider adding a cleanup function if needed, 
    // but relying on unique IDs might be sufficient for now.
    // e.g., await cleanupSessionState(currentTestSessionId);
    // Removed direct Redis client usage and disconnection.
  });

  it('should correctly persist empty staged_changes and updated id_map after successful apply', async () => {
    // --- Setup ---
    const issueTempId = 'TMP-P-ISSUE-1' as TemporaryFriendlyId;
    const commentTempId = 'TMP-P-COMMENT-1' as TemporaryFriendlyId;
    // Use createMockGuid with GUID-like strings
    const mockNewIssueGuid = createMockGuid('d7a8f1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4') as LinearGuid;
    const mockNewCommentGuid = createMockGuid('e8b9f2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5') as LinearGuid;

    const issueChange: StagedChange = {
      opType: 'issue.create',
      tempId: issueTempId,
      data: { teamId: 'TEAM-P-1', title: 'Persistence Test Issue' },
    };
    const commentChange: StagedChange = {
      opType: 'comment.create',
      tempId: commentTempId,
      data: { 
        issueId: issueTempId, // Dependency
        body: 'Persistence test comment.' 
      },
    };

    const initialState = createInitialAgentState(currentTestSessionId, {
      staged_changes: [issueChange, commentChange],
      id_map: {},
    });

    // Mock executeLinearOperation to guarantee success and return specific IDs
    mockExecuteLinearOperation
      .mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid }) // For issue.create
      .mockResolvedValueOnce({ success: true, newId: mockNewCommentGuid }); // For comment.create

    // --- Action ---
    // 1. Save initial state
    await saveAgentState(currentTestSessionId, initialState);
    console.log(`[Test ${currentTestSessionId}] Initial state saved.`);

    // 2. Load state (to simulate what apply_staged_changes receives)
    const loadedStateBeforeApply = await loadAgentState(currentTestSessionId);
    if (!loadedStateBeforeApply) throw new Error('Failed to load state before apply');
    console.log(`[Test ${currentTestSessionId}] State loaded before apply. staged_changes count: ${loadedStateBeforeApply.staged_changes.length}`);

    // 3. Run apply_staged_changes (this will call saveAgentState internally)
    const {newState: stateAfterApply, output} = await apply_staged_changes({}, loadedStateBeforeApply, mockLinearClient);
    const { success, outcome } = output; // Destructure from output
    expect(success).toBe(true);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);

    // --- Verification ---
    // 4. Save the state returned by apply_staged_changes and then load it to verify persistence
    await saveAgentState(currentTestSessionId, stateAfterApply); // Simulate runConversationTurn saving the state
    console.log(`[Test ${currentTestSessionId}] Loading final state...`);
    const finalState = await loadAgentState(currentTestSessionId);
    if (!finalState) throw new Error('Failed to load final state');
    console.log(`[Test ${currentTestSessionId}] Final state loaded. staged_changes: ${JSON.stringify(finalState.staged_changes)}, id_map: ${JSON.stringify(finalState.id_map)}`);

    // 5. Assert final state is correct
    expect(finalState.staged_changes, 'Staged changes should be empty after successful apply').toEqual([]);
    expect(finalState.id_map, 'ID map should contain mappings for successfully created entities').toEqual({
      [issueTempId]: mockNewIssueGuid,
      [commentTempId]: mockNewCommentGuid,
    });
  });

  // Add more tests here if needed, e.g., for failures, deletions, updates persistence
}); 