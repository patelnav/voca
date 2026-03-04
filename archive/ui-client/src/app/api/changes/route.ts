import { type NextRequest, NextResponse } from 'next/server';
import { getLinearClient } from '@/linear/client'; // Assuming path alias works
import { GeminiClient } from '@/api/core/gemini-client'; // Assuming path alias works
import { ServiceRegistry } from '@/services/registry'; // Assuming path alias works
import type { StagedChange } from '@/linear/changes/types'; // Assuming path alias works
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';

// --- REMOVED Singleton Initialization Logic ---
/*
let linearClientInstance: ReturnType<typeof getLinearClient> | null = null;
let geminiClientInstance: GeminiClient | null = null;
let serviceRegistryInstance: ServiceRegistry | null = null;
function initializeSingletons() { ... }
*/
// --- End REMOVED Singleton Initialization Logic ---

// --- Helper function to initialize services PER REQUEST ---
function initializeServices(initialIdMappings: any | null) { // Type will be SerializableIdMappings
    console.log("[api/changes] Initializing clients and services...");
    const linearApiKey = process.env.LINEAR_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!linearApiKey) {
        throw new Error('LINEAR_API_KEY environment variable is not set');
    }
    if (!geminiApiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const linearClient = getLinearClient();
    const registry = ServiceRegistry.getInstance(linearClient);
    const geminiClient = registry.getLLMClient();

    if (!linearClient || !geminiClient) {
        throw new Error('[api/changes] Client initialization failed unexpectedly.');
    }

    const changeManager = registry.linearChangeManager; 

    return { registry, changeManager, geminiClient };
}

// --- POST Handler ---
export async function POST(req: NextRequest) {
    console.log("API Route /api/changes called.");

    let action: 'apply' | 'clear' | null = null;
    let incomingStagedChanges: StagedChange[] | undefined = undefined;
    let incomingIdMappings: any | undefined = undefined; // Placeholder, will use SerializableIdMappings

    try {
        // Initialize/get services per request
        const body = await req.json();
        action = body.action;
        incomingStagedChanges = body.stagedChanges;
        incomingIdMappings = body.idMappings; 

        // Validate input
        if (!action || (action !== 'apply' && action !== 'clear')) {
            throw new Error('Missing or invalid "action" in request body. Must be "apply" or "clear".');
        }
        if (action === 'apply' && (!incomingStagedChanges || !Array.isArray(incomingStagedChanges) || incomingStagedChanges.length === 0)) {
            throw new Error('Missing or invalid "stagedChanges" in request body for "apply" action.');
        }
        if (action === 'clear' && incomingStagedChanges && !Array.isArray(incomingStagedChanges)) {
            console.warn('Invalid "stagedChanges" format received with "clear" action, ignoring them.');
            incomingStagedChanges = undefined; 
        }
        if (incomingIdMappings && typeof incomingIdMappings !== 'object') { 
            console.warn('Invalid "idMappings" format received, ignoring.');
            incomingIdMappings = undefined;
        }

        console.log(`Received action: "${action}", hasStagedChanges: ${!!incomingStagedChanges}, hasIdMappings: ${!!incomingIdMappings}`);

        // Pass mappings during initialization
        const { registry, changeManager, geminiClient } = initializeServices(incomingIdMappings); 

        // Perform the action
        if (action === 'apply') {
            // Repopulate and apply
            changeManager.clearChanges();
            incomingStagedChanges?.forEach(change => changeManager.addChange(change));
            console.log(`[api/changes] Repopulated Change Manager with ${changeManager.getChanges().length} changes for application.`);

            const results = await changeManager.applyChanges();
            console.log("[api/changes] Apply action successful.", results);

            // Format response
            const successMessages = results.filter(r => r.success).map(r => `${r.change.description} succeeded.`);
            const errorMessages = results.filter(r => !r.success).map(r => `${r.change.description} failed: ${r.error}`);
            const responseMessage = [...successMessages, ...errorMessages].join('\n') || "Changes applied.";

            // Construct final messages
            const finalMessages: BaseMessage[] = [
                new HumanMessage("Confirm Apply"), 
                new AIMessage(responseMessage)
            ];

            // <<< Retrieve updated mappings from the registry's IdMapper >>>
            const updatedIdMappings = registry.idMapper.getSerializableMappings();

            return NextResponse.json({
                success: !errorMessages.length, 
                responseToUser: responseMessage,
                stagedChanges: null, 
                confirmationNeeded: false,
                error: errorMessages.length > 0 ? errorMessages.join('\n') : null,
                messages: finalMessages, 
                idMappings: updatedIdMappings // <<< Return updated mappings
            });

        } else { // action === 'clear'
            await changeManager.clearChanges();
            console.log("[api/changes] Clear action successful.");

            // Construct final messages for context (User: "Cancel", AI: Result)
            const finalMessages: BaseMessage[] = [
                new HumanMessage("Cancel Apply"),
                new AIMessage("Okay, cleared the staged changes.")
            ];

            // <<< Retrieve potentially unchanged mappings from IdMapper >>> 
            // (Though it was initialized with incoming, clearing shouldn't change resolved maps)
            const updatedIdMappings = registry.idMapper.getSerializableMappings(); 

            return NextResponse.json({
                success: true,
                responseToUser: "Okay, cleared the staged changes.",
                stagedChanges: null,
                confirmationNeeded: false,
                error: null,
                messages: finalMessages,
                idMappings: updatedIdMappings // <<< Return mappings on clear too
            });
        }

    } catch (error: any) {
        console.error(`Error in /api/changes (Action: ${action || 'N/A'}):`, error);
        const isInputError = error.message.includes('action') || error.message.includes('stagedChanges');
        const finalMessages: BaseMessage[] = [
            new HumanMessage(action === 'apply' ? "Confirm Apply" : "Cancel Apply"),
            new AIMessage(`Failed to ${action || 'process changes'}: ${error.message}`)
        ];
        return NextResponse.json(
            {
                success: false,
                message: isInputError ? error.message : `Failed during ${action || 'changes'} action.`,
                error: error.message || 'Unknown error',
                stagedChanges: action === 'apply' ? null : incomingStagedChanges,
                confirmationNeeded: action === 'clear', 
                messages: finalMessages,
                // <<< Return original mappings on error >>>
                idMappings: incomingIdMappings || null // Return original on error
            },
            { status: isInputError ? 400 : 500 }
        );
    }
}

// Optional: Add a simple GET handler for basic testing/pinging
export async function GET() {
    return NextResponse.json({ message: "API Route /api/changes is running. Use POST to apply/clear changes." });
} 