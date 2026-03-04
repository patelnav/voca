import { AgentState, StructuredLlmResponse } from '../state/types';
import { Plan } from '../types/agent-output';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export function serializeCoreContext(agentState: AgentState): string {
  let context = "== PERSISTENT CORE CONTEXT START ==\n";

  context += "ID_MAP:\n";
  if (agentState.id_map && Object.keys(agentState.id_map).length > 0) {
    for (const [key, value] of Object.entries(agentState.id_map)) {
      context += `  ${key}: ${value}\n`;
    }
  } else {
    context += "  (empty)\n";
  }

  context += "TEAM_WORKFLOWS:\n";
  if (agentState.team_workflows && Object.keys(agentState.team_workflows).length > 0) {
    for (const [teamId, workflowContext] of Object.entries(agentState.team_workflows)) {
      context += `  ${teamId}:\n`;
      context += `    name: "${workflowContext.name}"\n`;
      context += `    states: [\n`;
      if (workflowContext.states && workflowContext.states.length > 0) {
        workflowContext.states.forEach(s => {
          context += `      { id: "${s.id}", name: "${s.name}" }\n`;
        });
      } else {
        context += "      (no states defined for this team)\n";
      }
      context += `    ]\n`;
    }
  } else {
    context += "  (empty)\n";
  }

  context += "ISSUE_TEAM_MAP:\n";
  if (agentState.issue_team_map && Object.keys(agentState.issue_team_map).length > 0) {
    for (const [issueGuid, teamGuid] of Object.entries(agentState.issue_team_map)) {
      context += `  ${issueGuid}: ${teamGuid}\n`;
    }
  } else {
    context += "  (empty)\n";
  }

  context += "== PERSISTENT CORE CONTEXT END ==";
  return context;
}

export function extractLlmResponseAndScratchpad(llmOutputContent: string): {
  userFacingMessage: string;
  newScratchpad: string | null;
  updatedPlan: Plan | null;
} {
  if (!llmOutputContent || llmOutputContent.trim() === '') {
    return { userFacingMessage: '', newScratchpad: null, updatedPlan: null };
  }

  let contentToParse = llmOutputContent.trim();
  const jsonFenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = contentToParse.match(jsonFenceRegex);
  if (match && match[1]) {
    contentToParse = match[1].trim();
  }

  try {
    const parsed = JSON.parse(contentToParse) as Partial<StructuredLlmResponse>;

    const userFacingMessage = typeof parsed.userFacingMessage === 'string' ? parsed.userFacingMessage : '';
    const newScratchpad = typeof parsed.scratchpad === 'string' ? parsed.scratchpad : null;
    const updatedPlan = parsed.currentPlan !== undefined ? parsed.currentPlan : null;

    if (typeof parsed.userFacingMessage === 'string') {
      return {
        userFacingMessage,
        newScratchpad,
        updatedPlan,
      };
    }

    logger.logCli(`Warning: extractLlmResponseAndScratchpad - Parsed JSON but core fields missing/invalid type. Output snippet: ${llmOutputContent.substring(0, 200)}`);
  } catch (e) {
    logger.logCli(`Info: extractLlmResponseAndScratchpad - Content could not be parsed as JSON, treating as simple string response. Snippet: ${llmOutputContent.substring(0, 200)}`);
    return { userFacingMessage: llmOutputContent, newScratchpad: null, updatedPlan: null };
  }

  return { userFacingMessage: llmOutputContent, newScratchpad: null, updatedPlan: null };
} 