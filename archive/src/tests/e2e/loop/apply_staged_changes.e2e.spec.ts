/// <reference types="vitest" />
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { runConversationTurn } from '@/loop'; // Adjust path
import { StagedChange, ConversationMessage, AgentState } from '@/state/types'; // Adjust path
import type { TemporaryFriendlyId } from '@/types/linear-ids'; // Adjust path
import { saveAgentState, loadAgentState } from '@/state/manager'; // Adjust path
import { redisClient } from '@/redis/client'; // Adjust path
import { LinearClient } from '@linear/sdk';
import { 
  E2E_PROJECT_ID, 
  E2E_TEAM_ID, 
  LINEAR_API_KEY, 
  createInitialAgentState 
} from '@tests/shared/linear-e2e.config'; // Adjust path
import { stage_add, StageAddResult } from '@/tools/linear_stage'; // <-- Import StageAddResult
import { ApplyStagedChangesResult, ApplyOutcome, ApplyChangeDetail } from '@/tools/linear_apply'; // <-- Correct import path and add ApplyChangeDetail

// Helper function to directly add a staged change to the state (copied from loop.tools test)
async function addStagedChangeDirectly(
  sessionId: string, 
  stagedChange: StagedChange
): Promise<void> {
  let state = await loadAgentState(sessionId); // Changed to let
  if (!state) throw new Error(`State not found for session ${sessionId}`);
  
  console.log(`[addStagedChangeDirectly] BEFORE calling stage_add for ${stagedChange.tempId || 'unknown tempId'} with change ${JSON.stringify(stagedChange)}. Current staged_changes:`, JSON.stringify(state.staged_changes, null, 2));

  // Call the actual stage_add tool function, which now returns a structured result
  const stageAddResult: StageAddResult = stage_add(state, stagedChange);
  
  // Log the outcome from stage_add and the staged_changes from the NEW state
  console.log(`[addStagedChangeDirectly] AFTER calling stage_add for ${stagedChange.tempId || 'unknown tempId'}. Result: ${JSON.stringify(stageAddResult)}`);
  
  // Check if the operation was successful before logging/saving the new state
  if (!stageAddResult.success) {
    console.error(`[addStagedChangeDirectly] stage_add failed! Outcome: ${stageAddResult.outcome}, Message: ${stageAddResult.message}`);
    // Decide if the test should throw or just log. Throwing might be better for tests.
    throw new Error(`stage_add failed during test setup: ${stageAddResult.message || stageAddResult.outcome}`);
  }

  // Extract the new state from the successful result
  const updatedStateAfterStageAdd = stageAddResult.newState;
  console.log(`[addStagedChangeDirectly] Staged changes in NEW state from successful stage_add:`, JSON.stringify(updatedStateAfterStageAdd.staged_changes, null, 2));

  // Save the modified (new) state
  await saveAgentState(sessionId, updatedStateAfterStageAdd); 
}

// Ensure necessary env vars are set
if (!process.env.GEMINI_API_KEY) {
  throw new Error('Missing required environment variables: GEMINI_API_KEY');
}

describe('Loop E2E - Apply Staged Changes', () => {
  const testSessionIdPrefix = 'test-session-e2e-loop-apply-'; // Unique prefix
  let currentTestSessionId: string;
  let linearClient: LinearClient;
  const createdIssueIds: string[] = []; // Track issues specifically for apply tests
  // Store original project state for cleanup in project update test
  let originalProjectState: { state?: string; leadId?: string | null } = {}; 

  beforeAll(async () => {
    linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });
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
    // Fetch and store original project state
    try {
      const project = await linearClient.project(E2E_PROJECT_ID);
      const lead = await project.lead; // Await the lead fetch
      originalProjectState.state = project.state;
      originalProjectState.leadId = lead?.id; // Access id after awaiting
    } catch (error) {
      console.error(`Failed to fetch initial project state for ${E2E_PROJECT_ID} in beforeAll:`, error);
      // Allow tests to proceed, they might handle the lack of initial state
    }
  }, 30000); // Increased timeout

  afterAll(async () => {
    // Linear Issue Cleanup
    if (createdIssueIds.length > 0) {
      console.log(`Cleaning up ${createdIssueIds.length} Linear issues created by apply E2E tests...`);
      try {
        for (const issueId of createdIssueIds) {
          // Use deleteIssue or archive - delete seems simpler if permissions allow
          await linearClient.deleteIssue(issueId); 
        }
        console.log('Successfully deleted Linear issues for apply tests.');
      } catch (error) {
        console.error('Error deleting Linear issues for apply tests:', error);
      }
    }
    // Project State Cleanup (revert changes made by project update test)
    if (originalProjectState.state !== undefined) { 
      try {
        console.log(`Reverting project ${E2E_PROJECT_ID} to original state...`);
        await linearClient.updateProject(E2E_PROJECT_ID, {
          state: originalProjectState.state,
          leadId: originalProjectState.leadId,
        });
        console.log(`Reverted project ${E2E_PROJECT_ID} state.`);
      } catch (cleanupError) {
        console.error(`Failed to cleanup/revert project ${E2E_PROJECT_ID}:`, cleanupError);
      }
    }
    // Redis Cleanup
    if (redisClient.status === 'ready' || redisClient.status === 'connect') {
        const keys = await redisClient.keys(`${testSessionIdPrefix}*`);
        if (keys.length > 0) {
            console.warn(`Cleaning up ${keys.length} lingering apply test keys...`);
            await redisClient.del(keys);
        }
    }
  });

  beforeEach(async () => {
    currentTestSessionId = `${testSessionIdPrefix}${randomUUID()}`;
    // Ensure createdIssueIds is clear for each test, unless cleanup is only in afterAll
    // createdIssueIds.length = 0; // Clearing here means afterAll might miss failures. Keep accumulating.
  });

  afterEach(async () => {
    if ((redisClient.status === 'ready' || redisClient.status === 'connect') && currentTestSessionId) {
      await redisClient.del(currentTestSessionId);
    }
    // Don't clear createdIssueIds here - afterAll handles cleanup
  });

  // --- Test Cases moved from loop.tools.e2e.spec.ts --- //

  // Test 1: Simple issue creation apply
  it('should stage and then apply a simple issue creation', async () => {
    const tempId = 'TMP-1' as TemporaryFriendlyId;
    const userInput = `Please stage creating a new issue titled 'Simple Apply Test' with description 'Phase 4 test', teamId '${E2E_TEAM_ID}', and give it temp id ${tempId}`;
    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);

    // --- Turn 1: User asks to stage ---
    const stageResponseOutput = await runConversationTurn(currentTestSessionId, userInput);
    console.log('Voca (Stage) Text Response:', stageResponseOutput?.textResponse);
    console.log('Voca (Stage) Intent:', stageResponseOutput?.intent);
    console.log('Voca (Stage) Pending Action:', JSON.stringify(stageResponseOutput?.pendingAction, null, 2));
    console.log('Voca (Stage) Tool Result (raw from turn output):', JSON.stringify(stageResponseOutput?.toolResult, null, 2));
    
    // Check if the stage_add tool was called and reported in toolResult
    expect(stageResponseOutput?.toolResult, 'ToolResult should be defined for stage_add call').toBeDefined();
    expect(stageResponseOutput!.toolResult?.toolName, 'ToolName should be stage_add').toBe('stage_add');
    expect(stageResponseOutput!.toolResult?.structuredOutput, 'structuredOutput for stage_add should be defined').toBeDefined();
    
    const stageAddToolOutput = stageResponseOutput!.toolResult!.structuredOutput as StageAddResult;
    expect(stageAddToolOutput.success, `stage_add tool failed or output structure unexpected: ${JSON.stringify(stageAddToolOutput)}`).toBe(true);
    expect(stageAddToolOutput.outcome).toBe('SUCCESS_ADDED');
    expect(stageAddToolOutput.tempId).toBe(tempId); 

    let stateAfterStage = await loadAgentState(currentTestSessionId);
    console.log('State after stage attempt (turn 1):', JSON.stringify(stateAfterStage, null, 2));
    expect(stateAfterStage?.staged_changes, 'Staged changes should have 1 item after successful stage_add tool call').toHaveLength(1);
    const stagedChange = stateAfterStage!.staged_changes[0];
    expect(stagedChange!.tempId).toBe(tempId);

    // --- Turn 2: User confirms apply --- //
    const confirmInput = "apply";
    const turnResultApply = await runConversationTurn(currentTestSessionId, confirmInput);
    console.log('Voca (Apply) Text Response:', turnResultApply?.textResponse);
    console.log('Voca (Apply) Intent:', turnResultApply?.intent);
    console.log('Voca (Apply) Tool Result (raw from turn output):', JSON.stringify(turnResultApply?.toolResult, null, 2));
    
    // Assertions for apply_staged_changes tool call
    expect(turnResultApply?.toolResult, 'ToolResult should be defined for apply_staged_changes call').toBeDefined();
    expect(turnResultApply!.toolResult?.toolName, 'ToolName should be apply_staged_changes').toBe('apply_staged_changes');
    expect(turnResultApply!.toolResult?.structuredOutput, 'structuredOutput for apply_staged_changes should be defined').toBeDefined();

    const applyResult = turnResultApply!.toolResult!.structuredOutput as ApplyStagedChangesResult;
    expect(applyResult.success, `apply_staged_changes tool success was false. Outcome: ${applyResult.outcome}, Message: ${applyResult.message}`).toBe(true);
    expect(applyResult.outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    expect(applyResult.results).toHaveLength(1);
    expect(applyResult.results[0].status).toBe('succeeded');
    expect(applyResult.results[0].newId).toBeDefined();
    expect(applyResult.results[0].change.tempId).toBe(tempId);

    // Load state AFTER the apply turn
    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply).toBeDefined();

    // Verify state changes (staged changes cleared, ID mapped)
    expect(stateAfterApply!.staged_changes).toHaveLength(0);
    expect(stateAfterApply!.id_map[tempId]).toBeDefined();
    const createdIssueGuid = stateAfterApply!.id_map[tempId]!;
    createdIssueIds.push(createdIssueGuid); // Track for cleanup

    // Verify Linear API state
    let createdIssue = await linearClient.issue(createdIssueGuid);
    expect(createdIssue).toBeDefined();
    expect(createdIssue.title).toBe('Simple Apply Test');
    expect(createdIssue.description).toContain('Phase 4 test');

    // Verify conversation history (optional, but can be useful)
    // Ensure that the history contains the tool call and tool result for apply_staged_changes
    const toolMessageInHistory = stateAfterApply.conversation_history.find(
        msg => msg.role === 'tool' && msg.content.includes('"name":"apply_staged_changes"')
    );
    expect(toolMessageInHistory, 'Tool message for apply_staged_changes not found in history').toBeDefined();
    if (toolMessageInHistory) {
        const parsedToolContent = JSON.parse(toolMessageInHistory.content);
        expect(parsedToolContent.name).toBe('apply_staged_changes');
        // The content of parsedToolContent.output should match 'applyResult'
        expect(parsedToolContent.output).toEqual(applyResult);
    }
  }, 60000); // Increased timeout for E2E with API calls

  // Test 2: Create issue, apply, then comment on it (dependency check)
  it('should stage issue, apply it, then add a comment', async () => {
    const issueTempId: TemporaryFriendlyId = 'TMP-2' as TemporaryFriendlyId;

    // --- Turn 1: Stage Issue Creation --- //
    const stageIssueInput = `Please stage creating an issue titled 'Apply Then Comment Test' with description 'Applied first', teamId '${E2E_TEAM_ID}', and temp id ${issueTempId}`;
    const stageResponseOutput = await runConversationTurn(currentTestSessionId, stageIssueInput);

    // Verify stage_add was called and successful
    expect(stageResponseOutput?.toolResult?.toolName).toBe('stage_add');
    const stageAddToolOutput = stageResponseOutput!.toolResult!.structuredOutput as StageAddResult;
    expect(stageAddToolOutput.success).toBe(true);
    expect(stageAddToolOutput.tempId).toBe(issueTempId);
    let stateAfterStage = await loadAgentState(currentTestSessionId);
    expect(stateAfterStage?.staged_changes).toHaveLength(1);
    expect(stateAfterStage?.staged_changes[0].tempId).toBe(issueTempId);

    // --- Turn 2: Apply Staged Change --- //
    const applyInput = "apply";
    const turnResultApply = await runConversationTurn(currentTestSessionId, applyInput);

    // Verify apply_staged_changes was called and successful
    expect(turnResultApply?.toolResult?.toolName).toBe('apply_staged_changes');
    const applyResult = turnResultApply!.toolResult!.structuredOutput as ApplyStagedChangesResult;
    expect(applyResult.success).toBe(true);
    expect(applyResult.outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    expect(applyResult.results).toHaveLength(1);
    expect(applyResult.results[0].status).toBe('succeeded');
    expect(applyResult.results[0].newId).toBeDefined();
    const createdIssueGuid = applyResult.results[0].newId!;
    createdIssueIds.push(createdIssueGuid); // Track for cleanup

    // Verify state after apply
    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply!.staged_changes).toHaveLength(0);
    expect(stateAfterApply!.id_map[issueTempId]).toBe(createdIssueGuid);

    // --- Turn 3: Add Comment to the Created Issue --- //
    const commentBody = 'Test comment added AFTER apply';
    // Use the REAL issue ID obtained from the apply result
    const addCommentInput = `Please add a comment to issue ${createdIssueGuid} with body \"${commentBody}\"`;
    const turnResultComment = await runConversationTurn(currentTestSessionId, addCommentInput);

    // Verify comment.create tool was called (no staging needed)
    expect(turnResultComment?.toolResult?.toolName).toBe('comment.create');
    const commentResult = turnResultComment!.toolResult!.structuredOutput as any; // Using 'any' for now, replace with actual type if known
    expect(commentResult.success).toBe(true);
    expect(commentResult.commentId).toBeDefined();
    const createdCommentGuid = commentResult.commentId;

    // Verify Linear API state
    const createdIssue = await linearClient.issue(createdIssueGuid);
    expect(createdIssue).toBeDefined();
    expect(createdIssue.title).toBe('Apply Then Comment Test');
    const comments = await createdIssue.comments();
    expect(comments.nodes).toHaveLength(1);
    expect(comments.nodes[0].id).toBe(createdCommentGuid);
    expect(comments.nodes[0].body).toContain(commentBody);

  }, 90000);

  // Test 3: Apply failure (enrichment)
  it('should report enrichment failure during apply and keep the change staged', async () => {
    const tempId: TemporaryFriendlyId = 'TMP-5' as TemporaryFriendlyId;
    const invalidStatusName = 'Definitely Not A Real Status';
    const confirmInput = "apply";

    const initialState = createInitialAgentState(currentTestSessionId, {
      focus: { type: 'project', id: E2E_PROJECT_ID },
    });
    await saveAgentState(currentTestSessionId, initialState);

    // --- Stage Issue Create with invalid status --- //
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.create',
      tempId: tempId,
      data: { title: 'Error Handling Test Issue', status: invalidStatusName, team: 'LIFE' }
    });

    // --- Apply (expecting failure reported) --- //
    const turnResultApply = await runConversationTurn(currentTestSessionId, confirmInput);

    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply).toBeDefined();

    // Verify the structured tool output indicates failure
    const toolResponses = stateAfterApply!.conversation_history.filter(m => m.role === 'tool');
    const applyToolResponse = toolResponses.find(tr => tr.content.includes('apply_staged_changes'));
    expect(applyToolResponse).toBeDefined();

    // Parse the structured result from the tool response content, being flexible about wrappers
    let applyResult: ApplyStagedChangesResult | null = null;
    if (applyToolResponse) {
      try {
        // First, try parsing assuming the standard {name, output} wrapper
        const parsedWrapper = JSON.parse(applyToolResponse.content);
        if (parsedWrapper && parsedWrapper.name === 'apply_staged_changes' && parsedWrapper.output) {
          applyResult = parsedWrapper.output as ApplyStagedChangesResult;
        } else {
          // If wrapper is missing or different, try parsing the content directly
          console.warn('Tool response content did not match expected {name, output} structure, attempting direct parse:', applyToolResponse.content);
          applyResult = JSON.parse(applyToolResponse.content) as ApplyStagedChangesResult;
        }
      } catch (e) {
        // If even direct parse fails, log error
        console.error("Failed to parse apply_staged_changes tool response content:", applyToolResponse.content, e);
        // Additionally, try one more time assuming it *might* be just the 'output' part stringified
        try {
            const potentialOutput = JSON.parse(applyToolResponse.content)?.output;
            if (potentialOutput) {
                applyResult = typeof potentialOutput === 'string' ? JSON.parse(potentialOutput) : potentialOutput;
            }
        } catch (e2) {
             console.error("Second attempt to parse apply_staged_changes tool response content also failed:", applyToolResponse.content, e2);
        }
      }
    }

    expect(applyResult, `Failed to parse apply result from: ${applyToolResponse?.content}`).toBeDefined();
    expect(applyResult!.success).toBe(false); // Should fail overall if nothing applied
    expect(applyResult!.outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(applyResult!.results).toHaveLength(1);
    expect(applyResult!.results[0].status).toBe('failed');
    expect(applyResult!.results[0].reason).toMatch(/Enrichment failed:.*Workflow state.*not found/i);
    expect(applyResult!.results[0].reason).toMatch(new RegExp(invalidStatusName, 'i'));

    // Verify state changes (change should remain staged)
    expect(stateAfterApply!.staged_changes).toHaveLength(1);
    expect(stateAfterApply!.staged_changes[0].tempId).toBe(tempId);

  }, 90000);

  // Test 4: Apply failure (SDK)
  it('should report SDK failure during apply and remove the change', async () => {
    const tempId: TemporaryFriendlyId = 'TMP-6' as TemporaryFriendlyId;
    const invalidProjectId = '00000000-0000-0000-0000-000000000000';
    const confirmInput = "apply";

    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);

    // --- Stage Issue Create with invalid project ID --- //
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.create',
      tempId: tempId,
      data: { title: 'SDK Fail Test Issue', projectId: invalidProjectId, team: 'LIFE' }
    });

    // --- Apply (expecting SDK failure reported) --- //
    const turnResultApply = await runConversationTurn(currentTestSessionId, confirmInput);

    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply).toBeDefined();

    // Verify the structured tool output indicates failure
    const toolResponses = stateAfterApply!.conversation_history.filter(m => m.role === 'tool');
    const applyToolResponse = toolResponses.find(tr => tr.content.includes('apply_staged_changes'));
    expect(applyToolResponse).toBeDefined();

    // Parse the structured result from the tool response content, being flexible about wrappers
    let applyResult: ApplyStagedChangesResult | null = null;
    if (applyToolResponse) {
      try {
        // First, try parsing assuming the standard {name, output} wrapper
        const parsedWrapper = JSON.parse(applyToolResponse.content);
        if (parsedWrapper && parsedWrapper.name === 'apply_staged_changes' && parsedWrapper.output) {
          applyResult = parsedWrapper.output as ApplyStagedChangesResult;
        } else {
          // If wrapper is missing or different, try parsing the content directly
          console.warn('Tool response content did not match expected {name, output} structure, attempting direct parse:', applyToolResponse.content);
          applyResult = JSON.parse(applyToolResponse.content) as ApplyStagedChangesResult;
        }
      } catch (e) {
        // If even direct parse fails, log error
        console.error("Failed to parse apply_staged_changes tool response content:", applyToolResponse.content, e);
        // Additionally, try one more time assuming it *might* be just the 'output' part stringified
        try {
            const potentialOutput = JSON.parse(applyToolResponse.content)?.output;
            if (potentialOutput) {
                applyResult = typeof potentialOutput === 'string' ? JSON.parse(potentialOutput) : potentialOutput;
            }
        } catch (e2) {
             console.error("Second attempt to parse apply_staged_changes tool response content also failed:", applyToolResponse.content, e2);
        }
      }
    }

    expect(applyResult, `Failed to parse apply result from: ${applyToolResponse?.content}`).toBeDefined();
    expect(applyResult!.success).toBe(false); // Should fail overall
    expect(applyResult!.outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(applyResult!.results).toHaveLength(1);
    expect(applyResult!.results[0].status).toBe('failed');
    expect(applyResult!.results[0].reason).toMatch(/SDK Error during issue.create:.*Received non-uuid id/i); // Adjusted regex

    // Verify state changes (change should be REMOVED on SDK failure)
    expect(stateAfterApply!.staged_changes).toHaveLength(0);
    expect(stateAfterApply!.id_map[tempId]).toBeUndefined(); // No ID mapping occurred

  }, 90000);

  // Test 5: Apply with no staged changes
  it('should handle apply command when no changes are staged', async () => {
    // Initial state: some conversation, but no staged changes
    await saveAgentState(currentTestSessionId, createInitialAgentState(currentTestSessionId, {
      conversation_history: [
        { role: 'user', content: 'Previous unrelated message' },
        { role: 'assistant', content: 'Previous assistant response' }
      ],
      staged_changes: [], // Explicitly empty
    }));

    // User says "apply", intending to apply staged changes
    const turnResultApply = await runConversationTurn(currentTestSessionId, 'apply');
    
    // Load state AFTER the apply turn to inspect history and tool output
    const stateAfterApplyTurn = await loadAgentState(currentTestSessionId);
    expect(stateAfterApplyTurn).toBeDefined();

    // Verify the structured tool output indicates precondition error
    const toolResponses = stateAfterApplyTurn!.conversation_history.filter(m => m.role === 'tool');
    const applyToolResponse = toolResponses.find(tr => tr.content.includes('apply_staged_changes'));
    expect(applyToolResponse).toBeDefined();

    // Parse the structured result from the tool response content, being flexible about wrappers
    let applyResult: ApplyStagedChangesResult | null = null;
    if (applyToolResponse) {
      try {
        // First, try parsing assuming the standard {name, output} wrapper
        const parsedWrapper = JSON.parse(applyToolResponse.content);
        if (parsedWrapper && parsedWrapper.name === 'apply_staged_changes' && parsedWrapper.output) {
          applyResult = parsedWrapper.output as ApplyStagedChangesResult;
        } else {
          // If wrapper is missing or different, try parsing the content directly
          console.warn('Tool response content did not match expected {name, output} structure, attempting direct parse:', applyToolResponse.content);
          applyResult = JSON.parse(applyToolResponse.content) as ApplyStagedChangesResult;
        }
      } catch (e) {
        // If even direct parse fails, log error
        console.error("Failed to parse apply_staged_changes tool response content:", applyToolResponse.content, e);
        // Additionally, try one more time assuming it *might* be just the 'output' part stringified
        try {
            const potentialOutput = JSON.parse(applyToolResponse.content)?.output;
            if (potentialOutput) {
                applyResult = typeof potentialOutput === 'string' ? JSON.parse(potentialOutput) : potentialOutput;
            }
        } catch (e2) {
             console.error("Second attempt to parse apply_staged_changes tool response content also failed:", applyToolResponse.content, e2);
        }
      }
    }

    expect(applyResult, `Failed to parse apply result from: ${applyToolResponse?.content}`).toBeDefined();
    // Check the specific outcome and message for precondition failure
    expect(applyResult!.success).toBe(true); // Vacuously true according to apply_staged_changes logic
    expect(applyResult!.outcome).toBe(ApplyOutcome.ERROR_PRECONDITION);
    expect(applyResult!.message).toMatch(/No staged changes found/i);
    expect(applyResult!.results).toHaveLength(0);

    // Check state (should be unchanged)
    expect(stateAfterApplyTurn!.staged_changes).toHaveLength(0);
  }, 90000);

  // Test 6: Partial apply (one success, one enrichment failure)
  it('should handle partial apply (success + enrichment failure)', async () => {
    const successTempId: TemporaryFriendlyId = 'TMP-400' as TemporaryFriendlyId; // <-- Fixed tempId
    const failTempId: TemporaryFriendlyId = 'TMP-401' as TemporaryFriendlyId;    // <-- Fixed tempId
    const invalidStatusName = 'Definitely Not A Real Status Partial';
    const confirmInput = "apply";

    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);

    // Stage successful change
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.create',
      tempId: successTempId,
      data: { title: 'Partial Apply Success', team: 'LIFE' }
    });
    // Stage change that will fail enrichment
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.create', // <-- Reverted to issue.create
      tempId: failTempId,
      data: { title: 'Partial Apply Fail Enrich', status: invalidStatusName, team: 'LIFE' } // <-- Reverted data
    });

    let stateBeforeApply = await loadAgentState(currentTestSessionId);
    expect(stateBeforeApply?.staged_changes).toHaveLength(2);

    // --- Apply --- //
    const turnResultApply = await runConversationTurn(currentTestSessionId, confirmInput);
    
    // Load state AFTER the apply turn
    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply).toBeDefined();

    // Verify the structured tool output
    const toolResponses = stateAfterApply!.conversation_history.filter(m => m.role === 'tool');
    const applyToolResponse = toolResponses.find(tr => tr.content.includes('apply_staged_changes'));
    expect(applyToolResponse).toBeDefined();

    // Parse the structured result from the tool response content, being flexible about wrappers
    let applyResult: ApplyStagedChangesResult | null = null;
    if (applyToolResponse) {
      try {
        // First, try parsing assuming the standard {name, output} wrapper
        const parsedWrapper = JSON.parse(applyToolResponse.content);
        if (parsedWrapper && parsedWrapper.name === 'apply_staged_changes' && parsedWrapper.output) {
          applyResult = parsedWrapper.output as ApplyStagedChangesResult;
        } else {
          // If wrapper is missing or different, try parsing the content directly
          console.warn('Tool response content did not match expected {name, output} structure, attempting direct parse:', applyToolResponse.content);
          applyResult = JSON.parse(applyToolResponse.content) as ApplyStagedChangesResult;
        }
      } catch (e) {
        // If even direct parse fails, log error
        console.error("Failed to parse apply_staged_changes tool response content:", applyToolResponse.content, e);
        // Additionally, try one more time assuming it *might* be just the 'output' part stringified
        try {
            const potentialOutput = JSON.parse(applyToolResponse.content)?.output;
            if (potentialOutput) {
                applyResult = typeof potentialOutput === 'string' ? JSON.parse(potentialOutput) : potentialOutput;
            }
        } catch (e2) {
             console.error("Second attempt to parse apply_staged_changes tool response content also failed:", applyToolResponse.content, e2);
        }
      }
    }

    expect(applyResult, `Failed to parse apply result from: ${applyToolResponse?.content}`).toBeDefined();
    expect(applyResult!.success).toBe(true); // Partial success is still overall success = true
    expect(applyResult!.outcome).toBe(ApplyOutcome.SUCCESS_PARTIAL_APPLIED);
    expect(applyResult!.results).toHaveLength(2);
    const successDetail = applyResult!.results.find(r => r.change.tempId === successTempId);
    const failDetail = applyResult!.results.find(r => r.change.tempId === failTempId);
    expect(successDetail?.status).toBe('succeeded');
    expect(failDetail?.status).toBe('failed');
    expect(failDetail?.reason).toMatch(/Enrichment failed:.*Workflow state.*not found/i);
    expect(failDetail?.reason).toMatch(new RegExp(invalidStatusName, 'i'));

    // Check state: One change remains (the failed one), one ID is mapped
    expect(stateAfterApply!.staged_changes).toHaveLength(1);
    expect(stateAfterApply!.staged_changes[0].tempId).toBe(failTempId);
    expect(stateAfterApply!.id_map[successTempId]).toBeDefined();
    expect(stateAfterApply!.id_map[failTempId]).toBeUndefined();
    const createdIssueGuid = stateAfterApply!.id_map[successTempId]!;
    createdIssueIds.push(createdIssueGuid); // Track successful one

    // Verify Linear API state for the successful one
    let createdIssue = await linearClient.issue(createdIssueGuid);
    expect(createdIssue).toBeDefined();
    expect(createdIssue.title).toBe('Partial Apply Success');

  }, 90000);

  // Test 7: Full flow: Stage create, apply create, stage update (that fails enrichment), apply (fail), verify state
  it('should stage create, apply, stage update (fail enrich), apply (fail), verify state', async () => {
    const createTempId = 'TMP-500' as TemporaryFriendlyId; // <-- Fixed tempId
    const updateTempId = 'TMP-501' as TemporaryFriendlyId; // <-- Fixed tempId (was missing this one before)
    const confirmInput = "apply";

    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);

    // --- Turn 1: Stage Create ---
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.create',
      tempId: createTempId,
      data: { title: 'Full Flow Create E2E', team: 'LIFE' }
    });
    let stateAfterCreateStage = await loadAgentState(currentTestSessionId);
    expect(stateAfterCreateStage?.staged_changes).toHaveLength(1);

    // --- Turn 2: Apply Create ---
    await runConversationTurn(currentTestSessionId, confirmInput);
    let stateAfterCreateApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterCreateApply?.staged_changes).toHaveLength(0);
    expect(stateAfterCreateApply?.id_map[createTempId]).toBeDefined();
    const createdIssueGuid = stateAfterCreateApply!.id_map[createTempId]!;
    createdIssueIds.push(createdIssueGuid); // Track for cleanup

    // --- Turn 3: Stage Update (designed to fail enrichment) ---
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'issue.update',
      tempId: updateTempId, // Use the new fixed tempId
      data: { id: createdIssueGuid, title: 'Update Title Should Fail', teamId: '00000000-0000-0000-0000-000000000001' } // Use a valid UUID format for non-existent team
    });
    let stateAfterUpdateStage = await loadAgentState(currentTestSessionId);
    expect(stateAfterUpdateStage?.staged_changes).toHaveLength(1);
    expect(stateAfterUpdateStage?.staged_changes[0].tempId).toBe(updateTempId);

    // --- Turn 4: Apply Update (should fail due to non-existent teamId from previous step) ---
    const applyUpdateTurnOutput = await runConversationTurn(currentTestSessionId, 'apply');
    const applyUpdateResult = applyUpdateTurnOutput?.toolResult?.structuredOutput as ApplyStagedChangesResult;

    // Assertions for structured tool response content for the second apply
    expect(applyUpdateResult).toBeDefined();
    expect(applyUpdateResult!.success).toBe(false); // Failed overall
    expect(applyUpdateResult!.outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(applyUpdateResult!.results).toHaveLength(1);
    expect(applyUpdateResult!.results[0].status).toBe('failed');
    // Expect an SDK error because the teamId (though a valid UUID) does not exist
    expect(applyUpdateResult!.results[0].reason).toMatch(/SDK Error during issue.update: Entity not found: Team - Could not find referenced Team./i);
    expect(applyUpdateResult!.results[0].change.tempId).toBe(updateTempId);

    // Verify original issue is unchanged and failed change is removed from staging
    const finalState = await loadAgentState(currentTestSessionId);
    expect(finalState?.staged_changes).toHaveLength(0); // Failed change is removed
    expect(finalState?.id_map[createTempId]).toBe(createdIssueGuid); // Original mapping should persist
    expect(finalState?.id_map[updateTempId]).toBeUndefined(); // Update tempId should not be mapped

    // Verify the actual issue on Linear wasn't updated
    const finalIssueState = await linearClient.issue(createdIssueGuid);
    expect(finalIssueState.title).toBe('Full Flow Create E2E'); // Title should NOT be 'Update Title Should Fail'

  }, 90000);
  
   // Test 8: Staging and applying a project update (expected to be skipped)
   // This relies on the ChangeApplier skipping unimplemented operations like project.update
  it('should stage and report skip for an unimplemented project update', async () => {
    const updateTempId: TemporaryFriendlyId = 'TMP-10' as TemporaryFriendlyId;
    const newStateName = 'In Progress'; 
    const confirmInput = "apply";

    const initialState = createInitialAgentState(currentTestSessionId);
    await saveAgentState(currentTestSessionId, initialState);

    // --- Stage Project Update --- //
    await addStagedChangeDirectly(currentTestSessionId, {
      opType: 'project.update',
      tempId: updateTempId,
      data: { id: E2E_PROJECT_ID, state: newStateName } // Use the actual Project ID
    });
    expect((await loadAgentState(currentTestSessionId))?.staged_changes).toHaveLength(1);

    // --- Apply --- //
    await runConversationTurn(currentTestSessionId, confirmInput);

    const stateAfterApply = await loadAgentState(currentTestSessionId);
    expect(stateAfterApply).toBeDefined();

    // Verify the structured tool output indicates skip
    const toolResponses = stateAfterApply!.conversation_history.filter(m => m.role === 'tool');
    const applyToolResponse = toolResponses.find(tr => tr.content.includes('apply_staged_changes'));
    expect(applyToolResponse).toBeDefined();

    // Parse the structured result from the tool response content, being flexible about wrappers
    let applyResult: ApplyStagedChangesResult | null = null;
    if (applyToolResponse) {
      try {
        // First, try parsing assuming the standard {name, output} wrapper
        const parsedWrapper = JSON.parse(applyToolResponse.content);
        if (parsedWrapper && parsedWrapper.name === 'apply_staged_changes' && parsedWrapper.output) {
          applyResult = parsedWrapper.output as ApplyStagedChangesResult;
        } else {
          // If wrapper is missing or different, try parsing the content directly
          console.warn('Tool response content did not match expected {name, output} structure, attempting direct parse:', applyToolResponse.content);
          applyResult = JSON.parse(applyToolResponse.content) as ApplyStagedChangesResult;
        }
      } catch (e) {
        // If even direct parse fails, log error
        console.error("Failed to parse apply_staged_changes tool response content:", applyToolResponse.content, e);
        // Additionally, try one more time assuming it *might* be just the 'output' part stringified
        try {
            const potentialOutput = JSON.parse(applyToolResponse.content)?.output;
            if (potentialOutput) {
                applyResult = typeof potentialOutput === 'string' ? JSON.parse(potentialOutput) : potentialOutput;
            }
        } catch (e2) {
             console.error("Second attempt to parse apply_staged_changes tool response content also failed:", applyToolResponse.content, e2);
        }
      }
    }

    expect(applyResult, `Failed to parse apply result from: ${applyToolResponse?.content}`).toBeDefined();
    // Even a skip results in overall success:false if nothing else succeeded.
    // Let's assume FAILURE_NONE_APPLIED outcome means overall success = false
    expect(applyResult!.success).toBe(false);
    expect(applyResult!.outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(applyResult!.results).toHaveLength(1);
    expect(applyResult!.results[0].status).toBe('skipped');
    expect(applyResult!.results[0].reason).toMatch(/"message":"Operation type project.update is not implemented.*"/i); // Adjusted regex
    expect(applyResult!.results[0].change.tempId).toBe(updateTempId);

    // Verify state changes (skipped change should remain staged)
    expect(stateAfterApply!.staged_changes).toHaveLength(1);
    expect(stateAfterApply!.staged_changes[0].tempId).toBe(updateTempId);

    // --- Assert Linear API State (Should NOT be updated) --- //
    let updatedProject = await linearClient.project(E2E_PROJECT_ID);
    expect(updatedProject).toBeDefined();
    // Ensure the project state did NOT change from its original state before this test ran
    expect(updatedProject.state).toBe(originalProjectState.state); 
    // Note: We are comparing to originalProjectState captured in beforeAll,
    // assuming no other test mutated it in a way that affects this assertion.

  }, 90000);

}); 