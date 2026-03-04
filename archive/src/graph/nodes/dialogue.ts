import type { VocaAgentStateType } from '../graph';

/**
 * Node: formatNLResponseNode
 * Formats the final natural language response to the user, potentially combining
 * conversational parts with confirmation of actions or results.
 * Expects `conversationalPart` and potentially `stagedChanges` or `displayData`
 * to be populated in the state by upstream nodes (like generatePlainTextNode or applyChangesNode).
 */
export async function formatNLResponseNode(
    state: VocaAgentStateType
): Promise<Partial<VocaAgentStateType>> {
    console.log(`[Node: formatNLResponse] Formatting final response.`);
    let finalResponse = state.conversationalPart || ""; // Start with LLM's conversational text

    // Append confirmation/results if available and no explicit conversational part exists
    if (!finalResponse && state.displayData) {
        finalResponse = state.displayData; // Use pre-formatted data if no conversation
    } else if (state.displayData) {
        // Combine conversational part with formatted data
        finalResponse += `\n\n${state.displayData}`;
    } else if (!finalResponse) {
        // Fallback if nothing else is available
        if (state.intent === 'unknown') {
            finalResponse = "Sorry, I can only help with Linear issues and projects. How can I assist with those?";
        } else {
            // Use responseToUser if set by a previous node (like focus confirmation), otherwise generic OK
            finalResponse = state.responseToUser || "OK."; 
        }
    }

    console.log(`[Node: formatNLResponse] Final response to user: "${finalResponse.substring(0, 100)}..."`);

    return {
        responseToUser: finalResponse,
        // Clear intermediate fields once formatted
        conversationalPart: null,
        displayData: null,
        error: null, // Clear any error handled before formatting
    };
}

/**
 * Node: formatSearchResponseNode
 * Formats a simple confirmation message after a search finds a single entity.
 * Assumes `linearContext` contains the JSON details of the found entity and
 * `activeEntityType` and `activeEntityId` are set.
 */
export async function formatSearchResponseNode(
    state: VocaAgentStateType
): Promise<Partial<VocaAgentStateType>> {
    console.log(`[Node: formatSearchResponse] Formatting search confirmation.`);
    const { linearContext, activeEntityType, activeEntityId } = state;

    let responseToUser = "Found the requested information."; // Default response

    if (activeEntityType && activeEntityId && linearContext) {
        try {
            // Attempt to parse the primary context to get title/identifier
            const contextData = JSON.parse(linearContext);
            const primaryData = contextData?.primary;

            // Prioritize checking for project name first
            if (activeEntityType === 'project' && primaryData && primaryData.name) {
                 responseToUser = `Found project ${primaryData.name}`; // Handle project name specifically
            } else if (primaryData && primaryData.identifier && primaryData.title) {
                 responseToUser = `Found ${activeEntityType} ${primaryData.identifier}: ${primaryData.title}`; // General case for issues (or projects without name?)
            } else if (primaryData && primaryData.title) {
                 responseToUser = `Found ${activeEntityType}: ${primaryData.title}`;
            } else if (primaryData && primaryData.identifier) {
                 responseToUser = `Found ${activeEntityType} ${primaryData.identifier}`;
            } else {
                 responseToUser = `Found ${activeEntityType} ${activeEntityId}.`; // Fallback if context is missing expected fields
            }
        } catch (parseError: any) {
            console.warn(`[Node: formatSearchResponse] Failed to parse linearContext for ${activeEntityId}: ${parseError}`);
            // Fallback if parsing fails
            responseToUser = `Found ${activeEntityType} ${activeEntityId}. Details might be unavailable.`;
        }
    } else if (activeEntityType && activeEntityId) {
         responseToUser = `Found ${activeEntityType} ${activeEntityId}.`; // Fallback if context is missing
    }

    console.log(`[Node: formatSearchResponse] Response: "${responseToUser}"`);

    return {
        responseToUser: responseToUser,
        error: null // Clear any previous error
    };
}

/**
 * Node: askClarificationNode (Phase 3)
 * Formats a question asking the user to clarify which item they meant when search returns multiple results.
 * Sets the state to indicate clarification is needed.
 */
export async function askClarificationNode(
  state: VocaAgentStateType
): Promise<Partial<VocaAgentStateType>> {
  console.log('[Node: askClarificationNode] Asking for clarification due to ambiguity.');

  // Validate we have options to clarify
  if (!state.ambiguousOptions || state.ambiguousOptions.length === 0) {
    console.error('[Node: askClarificationNode] Called without ambiguousOptions.');
    return {
      error: "Internal Error: Clarification requested without options.",
      responseToUser: "Sorry, something went wrong while trying to clarify your request.",
      needsClarification: false,
      intent: 'unknown'
    };
  }

  // Store the original intent if not already stored
  const previousIntent = state.previousIntent || (state.intent === 'needs_understanding' ? 'unknown' : state.intent);

  // Format the options clearly
  const optionsText = state.ambiguousOptions
    .map((r, i) => `${i + 1}. ${r.type === 'project' ? 'Project' : 'Issue'}: ${r.name} (${r.id})`)
    .join('\n');

  const question = `I found multiple items matching your request. Which one did you mean?\n${optionsText}\n\nPlease reply with the number, ID, or name of your choice, or type 'cancel' to start over.`;

  return {
    needsClarification: true,
    clarificationQuestion: question,
    clarificationOptions: state.ambiguousOptions,
    responseToUser: question,
    intent: 'provide_clarification',
    previousIntent,
    // Clear any previous error or entity selections
    error: null,
    activeEntityId: null,
    activeEntityType: null,
    // Preserve search context if it exists
    searchQuery: state.searchQuery || null,
    // Clear ambiguity detection fields as we're now in clarification
    ambiguousOptions: null,
    llmAssumption: null
  };
}

/**
 * Node: processClarificationNode (Phase 3)
 * Processes the user's input in response to a clarification request.
 * Updates the active entity and restores the original intent if successful.
 */
export async function processClarificationNode(
  state: VocaAgentStateType
): Promise<Partial<VocaAgentStateType>> {
  console.log(`[Node: processClarificationNode] Processing user input: ${state.userInput}`);

  // Validate we're in clarification state
  if (!state.needsClarification || !state.clarificationOptions || !state.clarificationQuestion) {
    console.error('[Node: processClarificationNode] Called in invalid state.');
    return { 
      error: "Internal Error: Clarification processing called in invalid state.",
      responseToUser: "Sorry, something went wrong while processing your selection.",
      intent: 'unknown',
      needsClarification: false,
      clarificationQuestion: null,
      clarificationOptions: null,
      previousIntent: null
    };
  }

  const input = state.userInput.trim().toLowerCase();

  // Handle cancellation
  if (input === 'cancel' || input === 'never mind' || input === 'nevermind') {
    console.log('[Node: processClarificationNode] User cancelled clarification.');
    return {
      needsClarification: false,
      clarificationQuestion: null,
      clarificationOptions: null,
      responseToUser: "Okay, let's start over. What would you like to do?",
      intent: 'unknown',
      activeEntityId: null,
      activeEntityType: null,
      previousIntent: null,
      // Clear all context
      searchQuery: null,
      llmAssumption: null,
      ambiguousOptions: null,
      error: null
    };
  }

  // Try to match the selection
  let selectedOption = null;

  // Try matching by index (1-based)
  const indexMatch = input.match(/^(\d+)$/);
  if (indexMatch) {
    const index = parseInt(indexMatch[1], 10) - 1;
    if (index >= 0 && index < state.clarificationOptions.length) {
      selectedOption = state.clarificationOptions[index];
      console.log(`[Node: processClarificationNode] Matched option by index ${index + 1}.`);
    }
  }

  // Try matching by ID (case-insensitive)
  if (!selectedOption) {
    selectedOption = state.clarificationOptions.find(opt => 
      opt.id.toLowerCase() === input || 
      opt.id.replace('-', '').toLowerCase() === input.replace('-', '')
    );
    if (selectedOption) {
      console.log(`[Node: processClarificationNode] Matched option by ID: ${selectedOption.id}`);
    }
  }

  // Try matching by name (case-insensitive, partial match)
  if (!selectedOption) {
    selectedOption = state.clarificationOptions.find(opt => 
      opt.name.toLowerCase().includes(input) || 
      input.includes(opt.name.toLowerCase())
    );
    if (selectedOption) {
      console.log(`[Node: processClarificationNode] Matched option by Name: ${selectedOption.name}`);
    }
  }

  // Process the selection
  if (selectedOption) {
    console.log(`[Node: processClarificationNode] Selection resolved: ${selectedOption.id} (${selectedOption.name})`);
    
    // Restore the original intent and context
    return {
      needsClarification: false,
      clarificationQuestion: null,
      clarificationOptions: null,
      activeEntityId: selectedOption.id,
      activeEntityType: selectedOption.type,
      // Restore the original intent (or default to fetch_details if none)
      intent: state.previousIntent || 'fetch_details',
      previousIntent: null,
      // Clear ambiguity fields
      llmAssumption: null,
      ambiguousOptions: null,
      // Set a confirmation response
      responseToUser: `Selected: ${selectedOption.name}`,
      error: null
    };
  } else {
    // Invalid selection - stay in clarification state
    console.warn('[Node: processClarificationNode] Invalid selection.');
    const retryQuestion = `I didn't understand that selection. ${state.clarificationQuestion}`;
    return {
      needsClarification: true,
      responseToUser: retryQuestion,
      intent: 'provide_clarification',
      // Preserve other clarification state
      clarificationQuestion: state.clarificationQuestion,
      clarificationOptions: state.clarificationOptions,
      previousIntent: state.previousIntent,
      error: null
    };
  }
}

/**
 * Node: handleApiErrorNode (Phase 3)
 * Handles errors set in the state (e.g., from API calls in other nodes).
 * Formats a user-friendly error message and clears the error state.
 */
export async function handleApiErrorNode(
  state: VocaAgentStateType
): Promise<Partial<VocaAgentStateType>> {
  if (!state.error) {
    // Should not be called if no error exists, but handle defensively.
    console.warn('[Node: handleApiErrorNode] Called without an error in state.');
    return { error: null }; // Ensure error state is null if called erroneously
  }

  console.error(`[Node: handleApiErrorNode] Handling error: ${state.error}`);
  // Log the full error for debugging (consider a more robust logging mechanism)
  // logger.error("API Error Encountered", { detail: state.error });

  // --- Format User-Friendly Message --- 
  let userMessage = "An unexpected error occurred while processing your request. Please try again.";
  const lowerError = state.error.toLowerCase();

  // Customize messages based on error content (simple keyword matching)
  if (lowerError.includes("search")) {
    userMessage = "Sorry, I encountered an error searching Linear. Please check your query or try again later.";
  } else if (lowerError.includes("fetch") || lowerError.includes("details") || lowerError.includes("not found")) {
    userMessage = "Sorry, I couldn't fetch the details for that item. It might not exist or there could be a connection issue.";
  } else if (lowerError.includes("focus")) {
    userMessage = "Sorry, I couldn't set the focus. Please ensure the project ID or name is correct.";
  } else if (lowerError.includes("apply") || lowerError.includes("change")) {
    userMessage = "Sorry, I encountered an error applying the changes. Please review them or try again.";
  } else if (lowerError.includes("llm") || lowerError.includes("intent") || lowerError.includes("understand")) {
    userMessage = "Sorry, I had trouble understanding that request. Could you please rephrase it?";
  }

  return {
    responseToUser: userMessage,
    error: null, // Clear the error after handling
  };
} 