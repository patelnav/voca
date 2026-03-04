import type { AgentState } from '../state';
import type { GeminiClient, ChatMessage } from '../../api';
import type { FunctionDeclaration } from '../../api/core/interfaces';
import type { NodeDependencies } from '../types';
import { type BaseMessage } from '@langchain/core/messages';
import type { VocaAgentStateType } from '../graph'; // Import the internal state type
import type { LinearClient } from '@linear/sdk';  // Import from SDK directly
import type { Project } from '@linear/sdk';  // Import Project type for type safety

// Helper function (moved from focus.ts as it's used here too)
function extractProjectIdentifier(input: string): string | null {
    // Look for patterns like "focus on project X", "focus X"
    const focusMatch = input.match(/focus(?: on project| on)?\s+([^,.!?]+)/i);
    if (focusMatch && focusMatch[1]) {
        return focusMatch[1].trim();
    }
    return null; // No clear identifier found
}

/**
 * Node: parseCommandNode (New Entry Point)
 * Analyzes userInput to determine commandType and extract focusTargetId.
 * **Sets intent to 'needs_understanding' for non-explicit commands.**
 * Fetches current focus state.
 * Accepts and returns the internal VocaAgentStateType.
 */
export async function parseCommandNode(
    state: VocaAgentStateType, // Changed from AgentState
    dependencies: Pick<NodeDependencies, 'focusManager'>
): Promise<Partial<VocaAgentStateType>> { // Changed from AgentState
    const { userInput } = state;
    const { focusManager } = dependencies;
    // Type assertion needed here because the default in Annotation is string, 
    // but we treat it as AgentState['intent'] | 'needs_understanding'.
    // Initialize based on current state or default to 'needs_understanding'
    let intent: VocaAgentStateType['intent'] = state.intent ?? 'needs_understanding'; 
    let focusTargetId: string | null = null;

    const trimmedInput = userInput.trim().toLowerCase();

    console.log(`[Node: parseCommand] Parsing user input: "${userInput}"`);

    // --- Handle potential NATURAL LANGUAGE focus --- 
    // Check if it looks like a focus command, but treat as NL input
    if (trimmedInput.startsWith('focus ')) {
        // Extract potential target, but let LLM confirm intent & refine target
        intent = 'needs_understanding'; 
        focusTargetId = extractProjectIdentifier(userInput); // Use helper to extract just the ID/Name
        console.log(`[Node: parseCommand] Detected potential focus target: ${focusTargetId}, routing for understanding.`);
    } else if (trimmedInput) {
        // Any other non-empty, non-explicit input needs understanding
        intent = 'needs_understanding';
    } else {
        // Empty input is unknown/end
        // Check if unknown is assignable, otherwise use a valid default like needs_understanding
        intent = 'unknown'; // 'unknown' is part of AgentState['intent'] union
    }

    // Fetch current focus state regardless of command
    const isFocused = focusManager.hasFocus();
    const focusedProjectId = focusManager.getFocusedProjectId();
    const focusedProjectName = focusManager.getFocusedProjectName();

    console.log(`[Node: parseCommand] Determined intent: ${intent}, Focus Target: ${focusTargetId}, Current Focus: ${focusedProjectName || 'None'}`);

    return {
        intent,
        focusTargetId: focusTargetId || undefined, // Ensure null becomes undefined if needed by state typing
        isFocused,
        focusedProjectId: focusedProjectId || undefined,
        focusedProjectName: focusedProjectName || undefined,
        error: null // Clear previous error
    };
}

// --- Function Declaration for Intent Classification --- 
const classifyIntentSchema: FunctionDeclaration = {
    name: "classify_user_intent",
    description: "Analyzes the user's request concerning **ONLY Issues or Projects** to determine their primary goal (intent) and extract key information like search terms, specific entity IDs, or focus targets. This function ONLY classifies and extracts; it does not perform actions.",
    parameters: {
        type: "object",
        properties: {
            intent: {
                type: "string",
                description: "The user's primary goal or action category related ONLY to Issues or Projects.",
                enum: ["search", "fetch_details", "propose_change", "manage_focus", "unknown"]
            },
            searchQuery: {
                type: "string",
                description: "If intent is 'search', extract the **core semantic subject** the user is asking about, simplified for keyword search (e.g., 'issues about login problems' -> 'login', 'tasks for the UI refactor' -> 'UI refactor', 'any documents on the new API?' -> 'new API document'). Focus on the main nouns/concepts. Null if intent is not 'search' or query is unclear.",
            },
            activeEntityId: {
                type: "string",
                description: "A specific Linear Issue ID (e.g., 'PRO-123') or Project ID (UUID) mentioned, ONLY if the action targets an EXISTING entity. Null if creating a new entity.",
            },
            activeEntityType: {
                type: "string",
                description: "The type ('project' or 'issue') if activeEntityId is extracted OR if the user requests a list/search (e.g., 'list issues' implies 'issue'). Required if intent targets an entity.",
                enum: ["project", "issue"]
            },
            focusTargetIdentifier: {
                type: "string",
                description: "If intent is 'manage_focus', the Project name, slug, or ID to focus on. Null if unfocusing.",
            },
            fetchAction: {
                type: "string",
                description: "If intent is 'fetch_details' for Issues or Projects, specify the action: 'list', 'count', or 'summary'.",
                enum: ["list", "count", "summary"]
            },
            fetchFilters: {
                type: "object",
                description: "If intent is 'fetch_details' for Issues or Projects, user-specified filters (e.g., 'list *open* issues'). Keys: 'state', 'assignee', 'priority', 'createdAt', 'updatedAt'.",
                properties: {
                    state: { type: "string", description: "Filter by issue status (e.g., 'open', 'done')" },
                    assignee: { type: "string", description: "Filter by assignee name or ID" },
                    priority: { type: "string", description: "Filter by priority (e.g., 'high', 'low')" },
                    createdAt: { type: "string", description: "Filter by creation date (e.g., 'today', 'this week')" },
                    updatedAt: { type: "string", description: "Filter by update date (e.g., 'today', 'this week')" }
                },
                required: []
            },
            // --- Phase 3: Ambiguity Handling ---
            ambiguityDetected: {
                type: "boolean",
                description: "Set to true ONLY if the user's request for an entity (Issue or Project) is ambiguous (e.g., 'the API project' could match multiple projects). False otherwise."
            },
            llmAssumption: {
                type: "string",
                description: "If ambiguityDetected is true BUT you can make a high-confidence guess (e.g., context strongly suggests one), state your assumption here (e.g., 'Assuming project ID abc-123'). Otherwise, leave null."
            },
            ambiguousOptions: {
                type: "array",
                description: "If ambiguityDetected is true AND you cannot make a high-confidence guess, provide a list of possible matching entities (max 5). Required if ambiguityDetected is true and llmAssumption is null.",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "The Linear GUID or Friendly ID of the entity." },
                        name: { type: "string", description: "The display name of the entity." },
                        type: { type: "string", enum: ["project", "issue"], description: "The type of the entity." }
                    },
                    required: ["id", "name", "type"]
                }
            }
        },
        required: ["intent"]
    }
};
// --- End Function Declaration ---

// <<< Helper to convert BaseMessage to ChatMessage >>>
function convertToBaseChatMessage(msg: BaseMessage): ChatMessage | null {
    let role: ChatMessage['role'];
    let content: string;

    const type = msg._getType();
    // @ts-ignore - Linter seems overly strict on comparing BaseMessage type strings
    if (type === 'human' || type === 'user') {
        role = 'user';
    // @ts-ignore - Linter seems overly strict on comparing BaseMessage type strings
    } else if (type === 'ai' || type === 'assistant') { // Map AI/assistant to assistant
        role = 'assistant'; // Use 'assistant' for ChatMessage role
    } else {
        console.warn(`[convertToBaseChatMessage] Skipping message with unhandled type: ${type}`);
        return null; // Skip system or other message types for now
    }

    if (typeof msg.content === 'string') {
        content = msg.content;
    } else if (Array.isArray(msg.content) && msg.content.length > 0 && typeof msg.content[0] === 'object' && 'text' in msg.content[0]) {
        // Handle cases where content might be an array of parts (like Gemini response)
        content = msg.content.map(part => (part as any).text || '').join('\\n');
    } else {
         console.warn(`[convertToBaseChatMessage] Skipping message with unhandled content format: ${JSON.stringify(msg.content)}`);
        return null; // Skip if content format is unexpected
    }

    return { role, content };
}

/**
 * Node: understandIntentNode (Phase 2)
 * Uses an LLM to understand the user's natural language input, classify intent,
 * and extract relevant entities like search terms or specific IDs.
 * **Focuses specifically on Issues and Projects.**
 * **Includes a single retry attempt for LLM calls.**
 */
export async function understandIntentNode(
    state: VocaAgentStateType,
    dependencies: { 
        llmClient: GeminiClient,
        linearClient: LinearClient
    } 
): Promise<Partial<VocaAgentStateType>> {
    const { userInput, messages } = state;
    const { llmClient, linearClient } = dependencies;
    const MAX_RETRIES = 1;
    const RETRY_DELAY_MS = 500;

    // --- Define Enhanced Instructions ---
    // Define the core instructions separately to be combined with user input later.
    const enhancedInstructions = `Your task is SOLELY to classify the user's intent based on the request provided below under 'User Request:' **specifically regarding Issues or Projects**, and extract relevant information using the provided function schema ('classify_user_intent').

**CRITICAL INSTRUCTIONS:**
1.  **Analyze CONTEXT FIRST:** Before classifying or extracting, you MUST analyze the 'Conversation History' (provided separately as message history) to understand the context.
2.  **Resolve References using HISTORY:** Use the conversation history to resolve pronouns (it, them) and relative references ('the first one', 'that project', 'the API one') to specific entities mentioned in the history whenever possible. If history mentions 'Project X [proj-123]' and the user says 'focus on that one', you MUST extract 'proj-123' or 'Project X' as the focusTargetIdentifier.
3.  **Determine Ambiguity AFTER Context:** Only set \`ambiguityDetected: true\` if, *after* consulting the history, a reference *still* cannot be uniquely resolved to a single entity mentioned there. If context allows unique resolution, proceed with that entity and set \`ambiguityDetected: false\`.
4.  **Scope:** Focus ONLY on Issues and Projects.
5.  **Schema:** Respond *only* using the provided \`classify_user_intent\` function call schema.

Intent Guidelines (Issue/Project Focus):
- 'propose_change': Create/modify Issue/Project.
- 'fetch_details': View info/list Issues/Projects.
- 'search': Find Issues/Projects via keywords.
- 'manage_focus': Focus/unfocus on a Project.
- 'unknown': Unclear/unrelated intent.

Entity Type Guidelines: Infer 'issue'/'project' from context, keywords, ID patterns (e.g., 'PRO-123' is issue).
Search Query Guidelines: Extract core semantic subject if intent='search'.`;


    // --- Prepare Messages for LLM (History) ---
    // Keep this logic: prepare the history messages array
    const chatMessages: ChatMessage[] = [];
    if (messages && messages.length > 0) {
        const recentMessages = messages.slice(-3); // Last 3 messages for context
        chatMessages.push(...recentMessages
            .map(convertToBaseChatMessage)
            .filter((msg): msg is ChatMessage => msg !== null));
    }

    // --- Prepare Final Prompt Argument ---
    // Combine the enhanced instructions with the actual user input for the 'prompt' argument
    const finalPromptArgument = `${enhancedInstructions}

--- User Request ---
${userInput}
--- End User Request ---

Now, classify the intent and extract information based *only* on the 'User Request' above, using the context from the provided 'Conversation History' (passed separately). Respond using the 'classify_user_intent' function call.`;


    // --- Call LLM with Retry Logic ---
    let functionCallResponse = null;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
        try {
            // Pass the enhanced prompt as the first arg, and history as the fourth.
            functionCallResponse = await llmClient.sendFunctionCall(
                finalPromptArgument, // Enhanced instructions + user input
                classifyIntentSchema,
                undefined,
                chatMessages // Pass the prepared history array
            );

            if (!functionCallResponse || functionCallResponse.functionName !== classifyIntentSchema.name) {
                throw new Error('LLM did not return the expected function call.');
            }
            break;
        } catch (error) {
            if (retryCount === MAX_RETRIES) {
                console.error('[Node: understandIntent] Max retries reached:', error);
                return {
                    error: 'Failed to understand intent after retries.',
                    intent: 'unknown'
                };
            }
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    if (!functionCallResponse) {
        return {
            error: 'Failed to get response from LLM.',
            intent: 'unknown'
        };
    }

    // --- Process LLM Response ---
    try {
        const args = functionCallResponse.functionArgs;

        // Extract and validate arguments 
        // Cast to VocaAgentStateType['intent'] for internal assignment
        let intent: VocaAgentStateType['intent'] = (args.intent as VocaAgentStateType['intent']) || 'unknown';
        const searchQuery = typeof args.searchQuery === 'string' ? args.searchQuery : null;
        const activeEntityId = typeof args.activeEntityId === 'string' ? args.activeEntityId : null;
        const focusTargetIdentifier = typeof args.focusTargetIdentifier === 'string' ? args.focusTargetIdentifier : null;

        // --- Normalize intent --- 
        if (typeof intent === 'string') {
            // Use simple regex for whitespace replacement
            intent = intent.trim().toLowerCase().replace(/\s+/g, '_') as VocaAgentStateType['intent']; 
        }
        // Check if normalized intent is valid within VocaAgentStateType union
        const validIntents: VocaAgentStateType['intent'][] = ["search", "fetch_details", "propose_change", "manage_focus", "unknown", "provide_clarification"]; 
        if (!validIntents.includes(intent)) {
            console.warn(`[Node: understandIntent] Normalized intent "${intent}" is not valid. Setting to unknown.`);
            intent = 'unknown';
        }

        // Ensure entity type is valid or null
        const activeEntityType = (typeof args.activeEntityType === 'string' && (args.activeEntityType === 'project' || args.activeEntityType === 'issue')) 
                                ? args.activeEntityType 
                                : null;

        // Extract fetchAction and fetchFilters
        const fetchAction = (typeof args.fetchAction === 'string' && ['list', 'count', 'summary'].includes(args.fetchAction)) 
                            ? args.fetchAction as AgentState['fetchAction'] 
                            : null;
        const fetchFilters = (typeof args.fetchFilters === 'object' && args.fetchFilters !== null) 
                            ? args.fetchFilters as AgentState['fetchFilters'] 
                            : null;

        // --- Phase 3: Extract and Validate Ambiguity Fields ---
        let isAmbiguous = typeof args.ambiguityDetected === 'boolean' ? args.ambiguityDetected : false;
        const llmAssumption = typeof args.llmAssumption === 'string' ? args.llmAssumption : null;
        let ambiguousOptions = Array.isArray(args.ambiguousOptions) ? args.ambiguousOptions : null;

        // Validate ambiguousOptions structure
        if (ambiguousOptions && !ambiguousOptions.every(opt => 
            opt && typeof opt.id === 'string' && 
            typeof opt.name === 'string' && 
            (opt.type === 'issue' || opt.type === 'project'))) {
            console.warn("[Node: understandIntent] Invalid structure in ambiguousOptions. Clearing.");
            ambiguousOptions = null;
        }

        // If ambiguity is detected and options are provided, validate against real data
        if (isAmbiguous && ambiguousOptions && !llmAssumption) {
            console.log('[Node: understandIntent] Validating ambiguous options against Linear data');
            
            // Fetch all projects to validate against
            const projects = await linearClient.projects();
            const validatedOptions = [];

            // Validate each option against real data
            for (const option of ambiguousOptions) {
                if (option.type === 'project') {
                    // Try to find a matching project
                    const matchingProject = projects.nodes.find((p: Project) =>
                        p.id === option.id || 
                        p.name.toLowerCase() === option.name.toLowerCase()
                    );

                    if (matchingProject) {
                        validatedOptions.push({
                            id: matchingProject.id,
                            name: matchingProject.name,
                            type: 'project' as const
                        });
                    }
                }
                // Add similar validation for issues if needed
            }

            // Update options with validated data
            if (validatedOptions.length > 0) {
                ambiguousOptions = validatedOptions;
            } else {
                // If no valid options found, clear ambiguity
                isAmbiguous = false;
                ambiguousOptions = [];
            }
        }

        // --- Handle Ambiguity Logic ---
        let finalActiveEntityId = activeEntityId;
        let finalActiveEntityType: 'project' | 'issue' | null = activeEntityType as 'project' | 'issue' | null;
        let needsClarification = false;
        let previousIntent: VocaAgentStateType['intent'] | null = null;

        if (isAmbiguous) {
            if (llmAssumption && activeEntityId && activeEntityType) {
                // High confidence guess: Proceed with LLM's chosen ID/Type
                console.log(`[Node: understandIntent] Ambiguity detected, but proceeding with LLM assumption: ${llmAssumption}`);
                finalActiveEntityId = activeEntityId;
                finalActiveEntityType = activeEntityType as 'project' | 'issue';
            } else if (ambiguousOptions && ambiguousOptions.length > 0) {
                // Low confidence: Need clarification
                console.log("[Node: understandIntent] Ambiguity detected, requires user clarification.");
                needsClarification = true;
                previousIntent = intent === 'needs_understanding' ? 'unknown' : intent;
                finalActiveEntityId = null;
                finalActiveEntityType = null;
                intent = 'provide_clarification';
            } else {
                // Ambiguity detected but no assumption or options? Treat as unknown/error
                console.warn("[Node: understandIntent] Ambiguity detected, but no assumption or options provided. Setting intent to unknown.");
                intent = 'unknown';
                finalActiveEntityId = null;
                finalActiveEntityType = null;
            }
        }

        console.log(`[Node: understandIntent] Classified Intent: ${intent}, EntityType: ${finalActiveEntityType}, EntityId: ${finalActiveEntityId}, Search: ${searchQuery}, FocusTarget: ${focusTargetIdentifier}, FetchAction: ${fetchAction}, FetchFilters: ${JSON.stringify(fetchFilters)}`);
        console.log(`[Node: understandIntent] Ambiguity Detected: ${isAmbiguous}, Assumption: ${llmAssumption}, Options: ${JSON.stringify(ambiguousOptions)}`);

        return {
            intent,
            searchQuery,
            activeEntityId: finalActiveEntityId,
            activeEntityType: finalActiveEntityType,
            focusTargetId: focusTargetIdentifier || undefined,
            fetchAction,
            fetchFilters,
            // Ambiguity fields
            llmAssumption,
            ambiguousOptions,
            needsClarification,
            previousIntent,
            // Reset clarification fields if not needed now
            clarificationQuestion: needsClarification ? undefined : null,
            clarificationOptions: needsClarification ? undefined : null,
            error: null
        };
    } catch (error) {
        console.error('[Node: understandIntent] Error processing LLM response:', error);
        return {
            error: 'Failed to process LLM response.',
            intent: 'unknown'
        };
    }
}
 