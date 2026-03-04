import type { VocaAgentStateType } from '@/graph/graph';
import type { NodeDependencies } from '@/graph/types';
import { FocusManager } from '@/linear/focus-manager';

// Helper function to extract project identifier from natural language (simple example)
function extractProjectIdentifier(input: string): string | null {
    // Look for patterns like "focus on project X", "focus X"
    // Fix backslashes for regex
    const focusMatch = input.match(/focus(?: on project| on)?\s+([^,.!?]+)/i); 
    if (focusMatch && focusMatch[1]) {
        return focusMatch[1].trim();
    }
    return null; // No clear identifier found
}

/**
 * Node: manageFocusNode (New for Intent-Driven Focus)
 * Sets or clears focus based on intent/entities identified by LLM.
 * Assumes `understandIntentNode` populates relevant fields (like focusTargetId or a clear_focus flag).
 */
export async function manageFocusNode(
    state: VocaAgentStateType,
    dependencies: Pick<NodeDependencies, 'focusManager' | 'idMapper' | 'linearChangeManager'>
): Promise<Partial<VocaAgentStateType>> {
    const { userInput, focusTargetId } = state; // Use focusTargetId if set by LLM/parser
    const { focusManager, idMapper, linearChangeManager } = dependencies;

    // Determine if the action is to set focus or clear focus
    // This might need refinement based on how `understandIntentNode` populates the state.
    // Example: Check for a specific target, or maybe an explicit 'clear' action extracted.
    const wantsToClear = userInput.toLowerCase().includes('unfocus') || userInput.toLowerCase().includes('clear focus'); 
    const targetIdentifier = focusTargetId || extractProjectIdentifier(userInput); // Extract if not set

    console.log(`[Node: manageFocus] Received intent. Target: ${targetIdentifier}, Clear: ${wantsToClear}`);

    // <<< Added main try/catch block >>>
    try {
        if (wantsToClear) {
            // --- Clear Focus Logic (Similar to handleUnfocusNode) ---\
            console.log("[Node: manageFocus] Clearing focus based on intent.");
            // No separate try/catch needed here as the outer one handles it
            await focusManager.clearFocus();
            linearChangeManager.setFocusedProjectId(null);
            const responseToUser = "Focus cleared.";
            return {
                isFocused: false,
                focusedProjectId: undefined,
                focusedProjectName: undefined,
                responseToUser,
                error: null
            };
            // <<< Removed redundant inner try/catch >>>
            /*
            } catch (error: any) {
                const errorMessage = `Error in manageFocusNode (clearFocus): ${error.message}`;
                console.error(errorMessage);
                // Return only the error state
                return { error: errorMessage };
            }
            */
        } else if (targetIdentifier) {
            // --- Set Focus Logic (Similar to handleFocusNode) ---\
            console.log(`[Node: manageFocus] Attempting to set focus on: ${targetIdentifier}`);
            // No separate try/catch needed here as the outer one handles it
            const projectInfo = await focusManager.setFocusByAnyId(targetIdentifier);
            if (projectInfo) {
                const { id: projectId, name: projectName } = projectInfo;
                console.log(`[Node: manageFocus] Focus set successfully. Project ID: ${projectId}, Name: ${projectName}`);
                linearChangeManager.setFocusedProjectId(projectId);
                await idMapper.registerProject(projectName, projectId);
                const responseToUser = `OK, focused on project ${projectName}.`; // Simpler confirmation
                return {
                    isFocused: true,
                    focusedProjectId: projectId,
                    focusedProjectName: projectName,
                    responseToUser,
                    error: null
                };
            } else {
                // Treat 'not found' as an error for routing
                const errorMessage = `Error in manageFocusNode: Project not found matching '${targetIdentifier}'.`;
                console.warn(`[Node: manageFocus] ${errorMessage}`);
                // <<< Return error state directly from here, caught by outer catch >>>
                throw new Error(errorMessage); 
            }
            // <<< Removed redundant inner try/catch >>>
            /*
            } catch (error: any) {
                const errorMessage = `Error in manageFocusNode (setFocus): ${error.message}`;
                console.error(errorMessage);
                // Return only the error state
                return { error: errorMessage };
            }
            */
        } else {
            // --- No Target / Invalid State ---\
            console.warn("[Node: manageFocus] Manage focus intent received, but no target identifier found or action specified.");
            const errorMessage = "I understand you want to manage focus, but please specify the project name or ID, or say 'unfocus'.";
            // <<< Return error state directly, caught by outer catch >>>
            throw new Error(errorMessage); 
            // return { responseToUser: errorMessage, error: "Missing target for manage_focus intent." };
        }
    // <<< Added catch block >>>
    } catch (error: any) {
        const errorMessage = `Error in manageFocusNode: ${error.message}`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
}


/**
 * Node: handleFocusNode
 * Sets focus using FocusManager (via setFocusByAnyId) and updates related components.
 * @deprecated Prefer manageFocusNode which handles both set/clear based on intent.
 */
export async function handleFocusNode(
    state: VocaAgentStateType,
    dependencies: Pick<NodeDependencies, 'focusManager' | 'linearChangeManager' | 'idMapper'>
): Promise<Partial<VocaAgentStateType>> {
    const { focusTargetId } = state;
    const { focusManager, linearChangeManager, idMapper } = dependencies;

    if (!focusTargetId) {
        return { responseToUser: "Please specify a project ID or slug to focus on (e.g., 'focus PROJECT-ID').", error: "Missing focus target ID." };
    }

    console.log(`[Node: handleFocus] Attempting to set focus via setFocusByAnyId: ${focusTargetId}`);

    try {
        // Call the consolidated method in FocusManager
        const projectInfo = await focusManager.setFocusByAnyId(focusTargetId);

        if (projectInfo) {
            // Focus succeeded
            const { id: projectId, name: projectName } = projectInfo; // Destructure the returned LinearGuid and name

            console.log(`[Node: handleFocus] Focus set successfully by manager. Project ID: ${projectId}, Name: ${projectName}`);

            // Update LinearChangeManager context - projectInfo.id is LinearGuid
            linearChangeManager.setFocusedProjectId(projectId);

            // Update IdMapper with correct arguments: name, linearGuid
            // We don't necessarily know the slugId here, so we omit it.
            await idMapper.registerProject(projectName, projectId);

            const responseToUser = `Focused on project: ${projectName} (${projectId})`;

            // Update AgentState
            return {
                isFocused: true,
                focusedProjectId: projectId,
                focusedProjectName: projectName,
                responseToUser,
                error: null
            };
        } else {
            // Focus failed (project not found or ID invalid)
            // Treat 'not found' as an error for routing
            const errorMessage = `Error in handleFocusNode: Project not found or identifier invalid for '${focusTargetId}'.`;
            console.warn(`[Node: handleFocus] ${errorMessage}`);
            return { error: errorMessage };
        }
    } catch (error: any) {
        // Catch potential errors from setFocusByAnyId or registerProject
        const errorMessage = `Error in handleFocusNode: ${error.message}`;
        console.error(errorMessage);
        // Return only the error state
        return { error: errorMessage };
    }
}

/**
 * Node: handleUnfocusNode
 * Clears focus using FocusManager and updates LinearChangeManager.
 * @deprecated Prefer manageFocusNode which handles both set/clear based on intent.
 */
export async function handleUnfocusNode(
    state: VocaAgentStateType,
    dependencies: Pick<NodeDependencies, 'focusManager' | 'linearChangeManager'>
): Promise<Partial<VocaAgentStateType>> {
    const { focusManager, linearChangeManager } = dependencies;

    console.log("[Node: handleUnfocus] Clearing focus.");
    try {
        await focusManager.clearFocus(); // Clears internal state
        linearChangeManager.setFocusedProjectId(null); // Update change manager

        const responseToUser = "Focus cleared.";
        console.log("[Node: handleUnfocus] Focus cleared successfully.");

        return {
            isFocused: false,
            focusedProjectId: undefined,
            focusedProjectName: undefined,
            responseToUser,
            error: null
        };
    } catch (error: any) {
         const errorMessage = `Error in handleUnfocusNode: ${error.message}`;
         console.error(errorMessage);
         // Return only the error state
         return { error: errorMessage };
    }
}

/**
 * Node: clearFocusNode
 * Clears the current project focus.
 */
export async function clearFocusNode(
    _state: VocaAgentStateType,
    dependencies: { focusManager: FocusManager }
): Promise<Partial<VocaAgentStateType>> {
    const { focusManager } = dependencies;

    console.log("[Node: clearFocus] Clearing focus.");
    try {
        await focusManager.clearFocus(); // Clears internal state

        const responseToUser = "Focus cleared.";
        console.log("[Node: clearFocus] Focus cleared successfully.");

        return {
            isFocused: false,
            focusedProjectId: undefined,
            focusedProjectName: undefined,
            responseToUser,
            error: null
        };
    } catch (error: any) {
         const errorMessage = `Error in clearFocusNode: ${error.message}`;
         console.error(errorMessage);
         // Return only the error state
         return { error: errorMessage };
    }
} 