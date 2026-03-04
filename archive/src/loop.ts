import { FunctionCall, GenerateContentResponse as SDKGenerateContentResponse, Tool } from '@google/genai';
import { produce } from 'immer';

import { AgentTurnOutput } from './types/agent-output'; // Removed AgentIntent as it's not directly used here now
import { GeminiClient } from './api/core/gemini-client'; // SDKGenerateContentResponse is no longer imported from here
import { Logger } from './utils/logger'; // Assuming path from src/
import { loadAgentState, saveAgentState } from './state/manager'; // Assuming path from src/
import { getLinearClient } from './linear/client'; // Assuming path from src/

import { GEMINI_SYSTEM_PROMPT_STATIC_PARTS } from './prompts/system_static_parts';
import { GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS } from './prompts/system_scratchpad_instructions';
import { GEMINI_TASK_SPECIFIC_INSTRUCTIONS } from './prompts/system_task_specific_instructions';

import { serializeCoreContext, extractLlmResponseAndScratchpad } from './loop/state-helpers';
import { availableTools } from './loop/tool-definitions';
import { determineIntentFromUserInput } from './loop/intent-detection';
import { runToolAndGenerateResponse } from './loop/tool-execution';
import { ChatMessage } from './api/core/interfaces';

const logger = Logger.getInstance();

export async function runConversationTurn(
    sessionId: string,
    userInput: string,
): Promise<AgentTurnOutput | undefined> {
    logger.logCli(`\n--- Running conversation turn for session: ${sessionId} (NEW LOOP) ---`);
    logger.logCli(`User Input: ${userInput}`);

    let agentState = await loadAgentState(sessionId);
    if (!agentState) {
        logger.logCli(`Error: Agent state not found for session ${sessionId}. Cannot proceed.`);
        return {
            textResponse: "Error: Agent state not found. Cannot process your request.",
            intent: 'AGENT_ERROR',
            internalErrorDetails: `Agent state not found for session ${sessionId}`,
        };
    }

    const linearClient = getLinearClient();
    const geminiClient = new GeminiClient(); // Reverted to default model

    agentState = produce(agentState, (draftState) => {
        draftState.conversation_history.push({ role: 'user', content: userInput });
    });

    // --- REVERTING PROMPT SIMPLIFICATION --- 
    // const simplifiedSystemPrompt = `
    // You are an AI assistant.
    // When the user asks to search, you MUST use the linear_search tool by populating the functionCall field of your response.
    // Your text field in the response should ONLY contain a brief user-facing message like "Okay, I will search now."
    // DO NOT put JSON in the text field if you are making a function call.
    // 
    // Full instructions for JSON output (only when NOT making a tool call) are here:
    // ${GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS}
    // `;
    const systemPrompt = GEMINI_SYSTEM_PROMPT_STATIC_PARTS +
        serializeCoreContext(agentState) + 
        GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS +
        (agentState.llm_scratchpad ? `== LLM SCRATCHPAD START ==\n${agentState.llm_scratchpad}\n== LLM SCRATCHPAD END ==\n` : '== LLM SCRATCHPAD START ==\n(empty)\n== LLM SCRATCHPAD END ==\n') +
        GEMINI_TASK_SPECIFIC_INSTRUCTIONS;
    // --- END REVERTING PROMPT SIMPLIFICATION ---

    try {
        const hasStagedChanges = agentState.staged_changes.length > 0;
        const isApplyConfirmation = userInput.toLowerCase().match(/^(yes|ok|okay|sure|confirm|proceed|go ahead|apply|do it)$/i) !== null;

        if (hasStagedChanges && isApplyConfirmation) {
            logger.logCli('Detected confirmation to apply staged changes. Auto-calling apply_staged_changes.');
            const applyToolCall: FunctionCall = { name: 'apply_staged_changes', args: {} };
            const toolResult = await runToolAndGenerateResponse(
                sessionId,
                applyToolCall,
                agentState,
                linearClient,
                geminiClient,
                `I'll apply the staged changes now.`
            );
            return toolResult.turnOutput;
        }

        const systemMessage: ChatMessage = { role: 'system', content: systemPrompt }; // Use original full prompt
        const historyWithSystem = [systemMessage, ...agentState.conversation_history];

        const rawLlmSDKResponse = await geminiClient.generateContentWithTools(
            historyWithSystem,
            availableTools as Tool[]
        ) as SDKGenerateContentResponse;

        const { 
            text: sdkTextResponse,
            functionCalls: sdkToolCalls
        } = rawLlmSDKResponse;

        if (!rawLlmSDKResponse || (!sdkTextResponse && (!sdkToolCalls || sdkToolCalls.length === 0))) {
            logger.logCli('LLM returned no response or an empty response (checking SDK text/functionCalls).');
            agentState = produce(agentState, (draftState) => {
                draftState.conversation_history.push({ role: 'assistant', content: '' });
                draftState.status = 'idle';
            });
            await saveAgentState(sessionId, agentState);
            return {
                textResponse: "I received an empty response from the language model. Please try again.",
                intent: 'AGENT_ERROR',
                internalErrorDetails: 'LLM returned no response or an empty response (SDK text/functionCalls).'
            };
        }

        let finalAgentState = agentState;
        let turnOutput: AgentTurnOutput;

        const { 
            userFacingMessage,
            newScratchpad,
            updatedPlan,
        } = extractLlmResponseAndScratchpad(sdkTextResponse ?? '');

        const effectiveToolCalls: FunctionCall[] | undefined = sdkToolCalls;

        if (effectiveToolCalls && effectiveToolCalls.length > 0) {
            logger.logCli(`LLM wants to call ${effectiveToolCalls.length} tool(s). Effective source: SDK Getter`);
            const toolCall = effectiveToolCalls[0];
            logger.logCli(`Attempting to execute tool: ${toolCall.name}`);
            
            const toolResult = await runToolAndGenerateResponse(
                sessionId,
                toolCall,
                finalAgentState,
                linearClient,
                geminiClient,
                userFacingMessage
            );
            finalAgentState = toolResult.agentState;
            turnOutput = toolResult.turnOutput;
        } else {
            logger.logCli(`LLM returned text-only response (expected JSON): ${userFacingMessage}`);
            
            if (newScratchpad !== null) {
                finalAgentState = produce(finalAgentState, draft => { draft.llm_scratchpad = newScratchpad; });
            }
            if (updatedPlan !== null) {
                finalAgentState = produce(finalAgentState, draft => { draft.current_plan = updatedPlan; });
            }

            finalAgentState = produce(finalAgentState, (draftState) => {
                if (userFacingMessage) {
                  draftState.conversation_history.push({ role: 'assistant', content: userFacingMessage });
                }
                draftState.status = 'idle';
            });
            
            await saveAgentState(sessionId, finalAgentState);

            const textOnlyIntent = determineIntentFromUserInput(userInput, finalAgentState);
            turnOutput = {
                textResponse: userFacingMessage ?? '', 
                intent: textOnlyIntent,
                numStagedChanges: finalAgentState.staged_changes.length
            };
        }

        finalAgentState = produce(finalAgentState, draft => {
            draft.status = turnOutput.intent === 'AWAITING_CONFIRMATION' ? 'waiting_confirmation' : 'idle';
        });

        await saveAgentState(sessionId, finalAgentState);
        return turnOutput;

    } catch (error: any) {
        logger.logCli(`Error in runConversationTurn (NEW LOOP): ${error.message}`);
        console.error(error);
        try {
            const currentState = await loadAgentState(sessionId);
            if (currentState) {
                const errorState = produce(currentState, draft => {
                    draft.conversation_history.push({
                        role: 'assistant',
                        content: `INTERNAL_ERROR: ${error.message}`
                    });
                    draft.status = 'error';
                });
                await saveAgentState(sessionId, errorState);
            }
        } catch (saveError: any) {
            logger.logCli(`Critical: Failed to save agent state during error handling (NEW LOOP): ${saveError.message}`);
        }
        return {
            textResponse: "An unexpected error occurred while processing your request. Please try again later.",
            intent: 'AGENT_ERROR',
            internalErrorDetails: error.message,
        };
    }
} 