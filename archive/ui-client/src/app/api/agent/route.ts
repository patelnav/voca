import { type NextRequest, NextResponse } from 'next/server';
import { runConversationTurn } from '@/loop';
import { loadAgentState } from '@/state/manager';
import type { AgentState } from '@/state/types';

// Ensure .env variables are loaded. Next.js should handle this for API routes,
// but if issues arise, explicitly load using dotenv, e.g.:
// import dotenv from 'dotenv';
// dotenv.config({ path: '../../../../.env' });

export async function POST(req: NextRequest) {
  console.log("API Route /api/agent called (POST).");
  try {
    const body = await req.json();
    const { userInput, sessionId } = body;

    if (!userInput || typeof userInput !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid "userInput" in request body.' },
        { status: 400 }
      );
    }

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid "sessionId" in request body.' },
        { status: 400 }
      );
    }

    console.log(`Received userInput: "${userInput}", sessionId: "${sessionId}"`);

    // Call the core agent logic
    const assistantTextResponse = await runConversationTurn(sessionId, userInput);

    // Load the latest state to return to the client
    const currentAgentState = await loadAgentState(sessionId);

    return NextResponse.json({
      success: true,
      assistantResponse: assistantTextResponse,
      agentState: currentAgentState,
    });

  } catch (error: any) {
    console.error(`Error in /api/agent (POST):`, error);
    // Attempt to load state even on error for debugging, if possible
    let agentStateOnError: AgentState | null = null;
    try {
      const body = await req.json(); // Re-parse to get sessionId if initial parse failed before sessionId was read
      if (body.sessionId) {
        agentStateOnError = await loadAgentState(body.sessionId);
      }
    } catch (stateError) {
      console.error('Could not load agent state on error:', stateError);
    }
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'An unexpected error occurred.',
        agentState: agentStateOnError,
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  console.log("API Route /api/agent called (GET).");
  return NextResponse.json({ 
    message: "Voca Agent API is running. Use POST to interact.",
    timestamp: new Date().toISOString(),
  });
} 