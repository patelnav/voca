import { type NextRequest, NextResponse } from 'next/server';
import { getLinearClient } from '@/linear/client';
import { GeminiClient } from '@/api/core/gemini-client';

// --- Phase 2 Imports ---
import { ServiceRegistry } from '@/services/registry';
import { setGraphDependencies, getCompiledGraph } from '@/graph';
import { type VocaAgentStateType } from '@/graph/graph';
import { type AgentState } from '@/graph/state'; // Import AgentState type
import type { StagedChange } from '@/linear/changes/types'; // Import StagedChange type for validation
import { type BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'; // Import specific message classes
// --- End Phase 2 Imports ---

// Next.js automatically loads .env.local in ui-client
// dotenv.config({ path: '../../.env' }); // No longer needed

// --- REMOVED Singleton Initialization Logic ---
/*
let linearClientInstance: ReturnType<typeof getLinearClient> | null = null;
let geminiClientInstance: GeminiClient | null = null;
let serviceRegistryInstance: ServiceRegistry | null = null;
let graphDependenciesInstance: any | null = null;
function initializeSingletons() { ... }
*/
// --- End REMOVED Singleton Initialization Logic ---

// --- Phase 5 Helper: Create State from Request ---
const createApiState = (
    userInput: string,
    // Phase 5: Add optional incoming state
    incomingMessages?: BaseMessage[],
    incomingStagedChanges?: StagedChange[]
): AgentState => {
    console.log('Creating state with:', { userInput, hasMessages: !!incomingMessages, hasStagedChanges: !!incomingStagedChanges });
    // Basic state for API invocation - no focus initially
    const baseState: Partial<AgentState> = {
        userInput: userInput,
        intent: "unknown",
        messages: incomingMessages || [], // Use incoming or empty array
        linearContext: JSON.stringify({ // Default empty context
            currentProject: null,
            issuesInProject: []
        }),
        isFocused: false,
        focusedProjectId: undefined,
        focusedProjectName: undefined,
        searchQuery: null,
        searchResults: null,
        activeEntityId: undefined,
        activeEntityType: null,
        plainTextResponse: null,
        conversationalPart: null,
        rawProposedChanges: null,
        graphQLMutations: null,
        stagedChanges: incomingStagedChanges || null, // Use incoming or null
        confirmationNeeded: false, // Graph determines this
        displayData: null,
        responseToUser: '',
        error: null,
        needsClarification: false,
        clarificationQuestion: null,
        clarificationOptions: null,
        previousIntent: null,
    };
    // It's crucial that the returned object matches the full AgentState shape.
    // Using 'as AgentState' assumes all required fields are present in baseState or have defaults.
    // A more robust approach would ensure all keys are explicitly handled if defaults aren't guaranteed.
    return baseState as AgentState;
};
// --- End Phase 5 Helper ---

export async function POST(req: NextRequest) {
  console.log("API Route /api/graph called.");

  let userInput: string | null = null;
  // Phase 5: Variables for incoming state
  let incomingPlainMessages: { role: string, content: string }[] | undefined = undefined;
  let incomingStagedChanges: StagedChange[] | undefined = undefined;
  // <<< ADDED: Placeholder for incoming ID mappings >>>
  let incomingIdMappings: any | undefined = undefined; // Define a proper type later

  try {
    // --- Singleton initialization call removed --- 
    // initializeSingletons();

    // --- Phase 5: Read Input (including optional state) ---
    const body = await req.json();
    userInput = body.userInput;
    // Optional fields
    incomingPlainMessages = body.messages;
    incomingStagedChanges = body.stagedChanges;
    incomingIdMappings = body.idMappings; // <<< Read idMappings

    if (!userInput || typeof userInput !== 'string') {
      throw new Error('Missing or invalid "userInput" in request body.');
    }
    // Add basic validation for optional fields if needed
    if (incomingPlainMessages && !Array.isArray(incomingPlainMessages)) {
        console.warn('Invalid "messages" format received, ignoring.');
        incomingPlainMessages = undefined;
    }
    if (incomingStagedChanges && !Array.isArray(incomingStagedChanges)) {
        console.warn('Invalid "stagedChanges" format received, ignoring.');
        incomingStagedChanges = undefined;
    }
    if (incomingIdMappings && typeof incomingIdMappings !== 'object') { // Basic validation
        console.warn('Invalid "idMappings" format received, ignoring.');
        incomingIdMappings = undefined;
    }

    console.log(`Received userInput: "${userInput}", hasMessages: ${!!incomingPlainMessages}, hasStagedChanges: ${!!incomingStagedChanges}, hasIdMappings: ${!!incomingIdMappings}`);
    // --- End Phase 5 Input ---

    // --- Initialize Clients and Graph PER REQUEST --- 
    console.log("Initializing clients...");
    const linearApiKey = process.env.LINEAR_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!linearApiKey) {
      throw new Error('LINEAR_API_KEY environment variable is not set');
    }
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const linearClient = getLinearClient();
    
    if (!linearClient) {
        throw new Error('Client initialization failed unexpectedly.');
    }
    console.log("Linear client initialized successfully.");

    console.log("Initializing Service Registry and Graph...");

    // Instantiate Service Registry per request with Linear client only
    const registry = ServiceRegistry.getInstance(linearClient, incomingIdMappings);
    const geminiClient = registry.getLLMClient();
    
    console.log("Service Registry instantiated.");

    // Define dependencies
    const validator = async (_changes: string): Promise<boolean> => true;
    const linearHandler = {};

    const graphDependencies = {
        plainTextGenerator: registry.plainTextGenerator,
        graphQLConverter: registry.graphqlProcessor,
        validator,
        mutationConverter: registry.mutationConverter,
        focusManager: registry.focusManager,
        linearChangeManager: registry.linearChangeManager,
        idMapper: registry.idMapper, // IdMapper instance is now initialized with mappings
        linearHandler,
        linearClient,
        llmClient: geminiClient,
    };

    // Set dependencies and compile graph (compilation might be cached by LangGraph)
    setGraphDependencies(graphDependencies as any);
    console.log("Graph dependencies set.");

    const compiledGraph = getCompiledGraph();
    if (!compiledGraph) {
        throw new Error('Failed to compile graph.');
    }
    console.log("Graph compiled successfully.");
    // --- End Per-Request Initialization ---

    // If not a confirmation action, proceed with graph invocation
    console.log("Proceeding with graph invocation...");
    console.log("Creating state from request data...");

    // Convert plain messages to BaseMessage instances
    const initialMessages: BaseMessage[] = (incomingPlainMessages || []).map(msg => {
      if (msg.role === 'user' || msg.role === 'human') {
        return new HumanMessage(msg.content);
      } else if (msg.role === 'assistant' || msg.role === 'ai' || msg.role === 'model') {
        return new AIMessage(msg.content);
      } else {
        console.warn(`Unknown message role "${msg.role}" received, skipping.`);
        return null;
      }
    }).filter((msg): msg is BaseMessage => msg !== null);

    // <<< TODO: Include incomingIdMappings when creating initial state later >>>
    const initialStateBase = createApiState(userInput, initialMessages, incomingStagedChanges);
    const initialState = {
        ...initialStateBase,
        idMappings: incomingIdMappings || null // Add mappings to initial state
    };

    console.log("Invoking graph with initial state including mappings...");
    const finalState = await compiledGraph.invoke(initialState as VocaAgentStateType, { // Cast needed if createApiState returns AgentState
        recursionLimit: 50,
    });
    console.log("Graph invocation complete.");

    // Retrieve updated mappings from the IdMapper instance used in this request
    // <<< Retrieve updated mappings from the registry's IdMapper >>>
    const updatedIdMappings = registry.idMapper.getSerializableMappings(); 

    console.log("Returning final state to client including ID mappings.");
    return NextResponse.json({
        success: true,
        responseToUser: finalState.responseToUser,
        displayData: finalState.displayData,
        confirmationNeeded: finalState.confirmationNeeded,
        stagedChanges: finalState.stagedChanges,
        error: finalState.error,
        messages: finalState.messages || [],
        idMappings: updatedIdMappings, // <<< Return updated mappings
    });

  } catch (error: any) {
    console.error(`Error in /api/graph (Input: "${userInput || 'N/A'}"):`, error);
    const isInputError = error.message.includes('userInput');
    return NextResponse.json(
      {
        success: false,
        message: isInputError ? error.message : "Failed during graph invocation or processing.",
        error: error.message || 'Unknown error',
        // <<< Decide how to handle mappings on error >>>
        idMappings: incomingIdMappings || null // Return original mappings on error?
      },
      { status: isInputError ? 400 : 500 }
    );
  }
}

// Optional: Add a simple GET handler for basic testing/pinging
export async function GET() {
    return NextResponse.json({ message: "API Route /api/graph is running. Use POST to interact." });
} 