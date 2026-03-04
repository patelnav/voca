import { LinearClient } from '@linear/sdk';
import { FunctionCall } from '@google/genai';
import { AgentState, StagedChange } from '../state/types';
import { GeminiClient } from '../api/core/gemini-client';
import { Logger } from '../utils/logger';
import { produce } from 'immer';
import { AgentTurnOutput } from '../types/agent-output';
import { TemporaryFriendlyId } from '../types/linear-ids';
import { saveAgentState } from '../state/manager';
import { GenerationConfig } from '../api/core/interfaces';
import { HarmCategory, HarmBlockThreshold } from '@google/genai';

// Corrected Prompt Imports
import { GEMINI_POST_TOOL_SYSTEM_INSTRUCTIONS } from '../prompts/system_post_tool_instructions';
import { GEMINI_SYSTEM_PROMPT_STATIC_PARTS } from '../prompts/system_static_parts';
import { GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS } from '../prompts/system_scratchpad_instructions';

import { serializeCoreContext, extractLlmResponseAndScratchpad } from './state-helpers';
import { determineIntentFromToolCall, determinePendingActionType } from './intent-detection';

// Tool implementations (assuming they are now in ../tools/ and export necessary functions)
import { linear_search, linear_get_details, LinearSearchResult, SearchOutcome, LinearDetailsResult, DetailsOutcome } from '../tools/linear_read';
import { stage_add, stage_list, stage_remove, stage_update, StageAddOutcome, StageAddResult, StageListResult, StageRemoveOutcome, StageRemoveResult, StageUpdateOutcome, StageUpdateResult } from '../tools/linear_stage';
import { apply_staged_changes, ApplyStagedChangesResult } from '../tools/linear_apply';
import { ChatMessage } from '../api/core/interfaces';

const logger = Logger.getInstance();

export async function executeToolCall(
  toolCall: FunctionCall,
  initialAgentState: AgentState,
  linearClient: LinearClient,
  sessionId: string
): Promise<{ name: string; response: object; finalAgentState: AgentState }> {
  const { name, args } = toolCall;
  let toolResultObject: object = {};
  let resultingAgentState: AgentState = initialAgentState;

  logger.logCli(`[${sessionId}] Executing tool: ${name!} with args: ${JSON.stringify(args || {})}`);

  switch (name) {
    case 'linear_search':
      try {
        if (!args?.query) throw new Error('Missing query for linear_search');
        const searchResult: LinearSearchResult = await linear_search(args.query as string, initialAgentState);
        toolResultObject = searchResult;
        resultingAgentState = produce(initialAgentState, draftState => {
          if (searchResult.updatedIdMap) Object.assign(draftState.id_map, searchResult.updatedIdMap);
        });
      } catch (e: any) {
        toolResultObject = {
          success: false,
          outcome: SearchOutcome.ERROR_UNKNOWN,
          results: [],
          message: `linear_search execution failed: ${e.message}`
        };
      }
      break;
    case 'linear_get_details':
      try {
        if (!args?.entityId) throw new Error('Missing entityId for linear_get_details');
        const detailsResult: LinearDetailsResult = await linear_get_details(args.entityId as string, initialAgentState);
        toolResultObject = detailsResult;
        resultingAgentState = produce(initialAgentState, draftState => {
          if (detailsResult.updatedIdMap) Object.assign(draftState.id_map, detailsResult.updatedIdMap);
          if (detailsResult.updatedTeamWorkflows) Object.assign(draftState.team_workflows, detailsResult.updatedTeamWorkflows);
          if (detailsResult.updatedIssueTeamMap) Object.assign(draftState.issue_team_map, detailsResult.updatedIssueTeamMap);
        });
      } catch (e: any) {
        toolResultObject = {
          success: false,
          outcome: DetailsOutcome.ERROR_UNKNOWN,
          message: `linear_get_details execution failed: ${e.message}`
        };
      }
      break;
    case 'stage_add':
      try {
        if (!args?.change) throw new Error('Missing change for stage_add');
        const stageAddResult: StageAddResult = stage_add(initialAgentState, args.change as StagedChange);
        resultingAgentState = stageAddResult.newState;
        const { newState, ...responsePayload } = stageAddResult;
        toolResultObject = responsePayload;
      } catch (e: any) {
        toolResultObject = {
          success: false,
          outcome: StageAddOutcome.ERROR_UNKNOWN,
          message: `stage_add execution failed: ${e.message}`
        };
      }
      break;
    case 'stage_list':
      try {
        const stageListResult: StageListResult = stage_list(initialAgentState);
        toolResultObject = stageListResult;
      } catch (e: any) {
        toolResultObject = {
          success: false,
          stagedChanges: [],
          message: `stage_list execution failed: ${e.message}`
        };
      }
      break;
    case 'stage_remove':
      try {
        if (!args?.tempId) throw new Error('Missing tempId for stage_remove');
        const stageRemoveResult: StageRemoveResult = stage_remove(initialAgentState, args.tempId as TemporaryFriendlyId);
        resultingAgentState = stageRemoveResult.newState;
        const { newState, ...responsePayload } = stageRemoveResult;
        toolResultObject = responsePayload;
      } catch (e: any) {
        toolResultObject = {
          success: false,
          outcome: StageRemoveOutcome.ERROR_UNKNOWN,
          message: `stage_remove execution failed: ${e.message}`
        };
      }
      break;
    case 'stage_update':
      try {
        if (!args?.changeToUpdate) throw new Error('Missing changeToUpdate for stage_update');
        const stageUpdateResult: StageUpdateResult = stage_update(initialAgentState, args.changeToUpdate as StagedChange);
        resultingAgentState = stageUpdateResult.newState;
        const { newState, ...responsePayload } = stageUpdateResult;
        toolResultObject = responsePayload;
      } catch (e: any) {
        toolResultObject = {
          success: false,
          outcome: StageUpdateOutcome.ERROR_UNKNOWN,
          message: `stage_update execution failed: ${e.message}`
        };
      }
      break;
    case 'apply_staged_changes':
      try {
        const applyResult: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes(args as any, initialAgentState, linearClient);
        toolResultObject = applyResult.output;
        resultingAgentState = applyResult.newState;
      } catch (e: any) { toolResultObject = { error: `apply_staged_changes failed: ${e.message}` }; }
      break;
    case 'comment.create':
      try {
        if (!args?.issueId) throw new Error('Missing issueId for comment.create');
        if (!args?.body) throw new Error('Missing body for comment.create');
        
        // Prepare arguments for linearClient.createComment
        const commentInput = {
          issueId: args.issueId as string,
          body: args.body as string,
          // Add other optional fields if needed/available in args
        };
        
        // Directly call the Linear SDK function via the client
        const response = await linearClient.createComment(commentInput);
        
        if (response.success) {
          const sdkComment = await response.comment;
          toolResultObject = {
            success: true,
            commentId: sdkComment?.id
          };
        } else {
          toolResultObject = {
            success: false,
            error: `Linear SDK Error: ${ (response as any).error || 'Failed to create comment'}`
          };
        }
      } catch (e: any) {
        toolResultObject = {
          success: false,
          error: `comment.create execution failed: ${e.message}`
        };
      }
      break;
    default:
      toolResultObject = { error: `Unknown tool '${name!}'` };
      break;
  }
  logger.logCli(`[${sessionId}] Tool ${name!} executed. Response object for LLM: ${JSON.stringify(toolResultObject)}`);
  return { name: name!, response: toolResultObject, finalAgentState: resultingAgentState };
}

export async function runToolAndGenerateResponse(
  sessionId: string,
  toolCall: FunctionCall,
  initialAgentState: AgentState,
  linearClient: LinearClient,
  geminiClient: GeminiClient,
  initialLlmTextResponse?: string | null
): Promise<{ agentState: AgentState; turnOutput: AgentTurnOutput }> {
  let currentAgentState = initialAgentState;
  logger.logCli(`[runToolAndGenerateResponse] Session: ${sessionId}, Tool call: ${toolCall.name}`);
  const toolArgs = toolCall.args || {};
  const initialIntent = determineIntentFromToolCall(toolCall.name, true, currentAgentState);
  const pendingActionType = determinePendingActionType(toolCall.name);

  let turnOutput: AgentTurnOutput = {
    textResponse: "",
    intent: initialIntent,
    pendingAction: { type: pendingActionType, toolName: toolCall.name || "", toolArgs: toolArgs },
    numStagedChanges: currentAgentState.staged_changes.length
  };

  if (toolCall.name === 'apply_staged_changes' && (!initialLlmTextResponse || initialLlmTextResponse.trim() === '')) {
    const stageCount = currentAgentState.staged_changes.length;
    let confirmationText = `I'm about to apply ${stageCount} staged change${stageCount !== 1 ? 's' : ''}.`;
    if (stageCount > 0) {
      confirmationText += " This will:";
      currentAgentState.staged_changes.forEach((change, idx) => {
        const operation = change.opType.split('.')[1] || change.opType;
        const entity = change.opType.split('.')[0] || 'item';
        const identifier = change.tempId || (change.data?.id ? `ID: ${change.data.id}` : `#${idx + 1}`);
        confirmationText += `\n- ${operation} ${entity} (${identifier})`;
      });
    }
    confirmationText += "\nDo you want to proceed?";
    turnOutput.textResponse = confirmationText;
    initialLlmTextResponse = confirmationText;
  }

  if (initialLlmTextResponse && initialLlmTextResponse.trim() !== '') {
    turnOutput.textResponse = initialLlmTextResponse;
  }

  currentAgentState = produce(currentAgentState, draft => {
    if (initialLlmTextResponse && initialLlmTextResponse.trim() !== '') {
      draft.conversation_history.push({ role: 'assistant', content: initialLlmTextResponse });
      logger.logCli(`Added initial LLM text to history: "${initialLlmTextResponse.substring(0, 100)}..."`);
    }
    draft.conversation_history.push({ role: 'assistant', content: JSON.stringify({ functionCall: toolCall }) });
  });

  try {
    const toolResponse = await executeToolCall(toolCall, currentAgentState, linearClient, sessionId);
    currentAgentState = toolResponse.finalAgentState;

    currentAgentState = produce(currentAgentState, draft => {
      // Add the *full* tool result JSON to history again
      draft.conversation_history.push({ role: 'tool', content: JSON.stringify({ name: toolCall.name, output: toolResponse.response }) });
    });

    const systemPromptTextForSummary = [
      GEMINI_SYSTEM_PROMPT_STATIC_PARTS,
      GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS,
      GEMINI_POST_TOOL_SYSTEM_INSTRUCTIONS,
      `Scratchpad Content:\n== LLM SCRATCHPAD START ==\n${currentAgentState.llm_scratchpad || '(empty)'}
== LLM SCRATCHPAD END ==`,
      serializeCoreContext(currentAgentState),
    ].join('\n\n');
    
    const systemMessage: ChatMessage = { role: 'system', content: systemPromptTextForSummary };
    const historyForSecondLlmCall = [systemMessage, ...currentAgentState.conversation_history];
    
    logger.logCli(`[DEBUG runToolAndGenerateResponse] System instruction text for second LLM call (length: ${systemPromptTextForSummary?.length}): ${systemPromptTextForSummary?.substring(0,100)}...`);
    
    // Define specific config for the second call, increasing maxOutputTokens
    const secondCallConfig: GenerationConfig = {
        temperature: 0.2, // Keep other defaults
        maxOutputTokens: 16384, // Increase significantly
        topP: 0.95,
        topK: 64
    };
    
    // Define permissive safety settings
    const permissiveSafetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];
    
    const secondLlmResponse = await geminiClient.generateContentWithTools(historyForSecondLlmCall, [], secondCallConfig, permissiveSafetySettings);
    const secondLlmResponseText = secondLlmResponse.text ?? '';
    logger.logCli(`[DEBUG runToolAndGenerateResponse] Raw second LLM response text (length: ${secondLlmResponseText.length}): "${secondLlmResponseText.substring(0, 200)}"`);

    const { userFacingMessage: synthesizedTextOutput, newScratchpad: synthesizedScratchpad, updatedPlan: synthesizedPlan } = extractLlmResponseAndScratchpad(secondLlmResponseText);
    
    logger.logCli(`[DEBUG runToolAndGenerateResponse] Extracted synthesizedTextOutput (length: ${synthesizedTextOutput?.length}): "${synthesizedTextOutput?.substring(0, 200)}"`);
    logger.logCli(`[DEBUG runToolAndGenerateResponse] Extracted synthesizedScratchpad (length: ${synthesizedScratchpad?.length}): "${synthesizedScratchpad?.substring(0, 200)}"`);
    logger.logCli(`[DEBUG runToolAndGenerateResponse] Extracted synthesizedPlan: ${synthesizedPlan ? JSON.stringify(synthesizedPlan).substring(0,200) : 'null'}`);

    if (synthesizedScratchpad !== null && synthesizedPlan !== null && typeof synthesizedTextOutput === 'string') {
      currentAgentState = produce(currentAgentState, draft => {
        if (synthesizedScratchpad !== null) draft.llm_scratchpad = synthesizedScratchpad;
        if (synthesizedPlan !== null) draft.current_plan = synthesizedPlan;
        draft.conversation_history.push({ role: 'assistant', content: synthesizedTextOutput });
        draft.status = 'idle';
      });
      
      const postExecutionIntent = determineIntentFromToolCall(toolCall.name, false, currentAgentState);
      turnOutput = {
        textResponse: synthesizedTextOutput,
        intent: postExecutionIntent,
        numStagedChanges: currentAgentState.staged_changes.length,
        toolResult: { toolName: toolCall.name || "unknown", structuredOutput: toolResponse.response, resultSummary: synthesizedTextOutput },
      };
    } else {
      const failureMessage = "Tool executed successfully, but I encountered an issue processing the results.";
      logger.logCli(`Error: Failed to parse expected JSON from second LLM call in runToolAndGenerateResponse. Raw text: ${secondLlmResponseText}`);
      currentAgentState = produce(currentAgentState, draft => {
        draft.conversation_history.push({ role: 'assistant', content: failureMessage });
        draft.status = 'error';
      });
      turnOutput = {
        textResponse: failureMessage,
        intent: 'AGENT_ERROR',
        numStagedChanges: currentAgentState.staged_changes.length,
        toolResult: { toolName: toolCall.name || "unknown", structuredOutput: toolResponse.response, resultSummary: failureMessage },
        internalErrorDetails: "Failed to parse JSON from post-tool LLM response."
      };
    }
  } catch (error: any) {
    const errorMessage = `Error executing tool ${toolCall.name || "unknown"}: ${error.message}`;
    logger.logCli(errorMessage);
    currentAgentState = produce(currentAgentState, draft => {
      draft.conversation_history.push({ role: 'tool', content: JSON.stringify({ name: toolCall.name, error: error.message }) });
      draft.conversation_history.push({ role: 'assistant', content: errorMessage });
      draft.status = 'error';
    });
    turnOutput = {
      textResponse: errorMessage,
      intent: 'TOOL_ERROR',
      numStagedChanges: currentAgentState.staged_changes.length,
      internalErrorDetails: error.message,
      toolResult: { toolName: toolCall.name || "unknown", structuredOutput: { error: error.message }, resultSummary: errorMessage }
    };
  }

  try {
    await saveAgentState(sessionId, currentAgentState);
    logger.logCli(`[runToolAndGenerateResponse] Saved final state for session ${sessionId}`);
  } catch (saveError: any) {
    logger.logCli(`[runToolAndGenerateResponse] CRITICAL: Failed to save agent state after tool execution for session ${sessionId}: ${saveError.message}`);
  }

  return { agentState: currentAgentState, turnOutput };
} 