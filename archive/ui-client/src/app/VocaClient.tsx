'use client';

import { useState, FormEvent, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import styles from "./page.module.css";
import type { VocaAgentStateType, SerializableIdMappings } from '../../../src/graph/graph'; 
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';

// --- Phase 5: Import Types ---
// These types should ideally match what the API route expects/returns.
type Message = {
  type: 'human' | 'ai';
  content: string;
};

type StagedChange = any; // Replace 'any' with the actual StagedChange type if available

interface PendingConfirmation {
  stagedChanges: StagedChange[];
  prompt: string; // The confirmation question from responseToUser
}

// Type for clarification options
type ClarificationOption = {
    id: string;
    name: string;
    type: 'project' | 'issue'; // Adjust if other types are possible
};

// Type for persisted state needed for clarification follow-up
type PersistedClarificationState = {
    messages: BaseMessage[];
    idMappings: SerializableIdMappings | null;
};

export function VocaClient() {
  const [userInput, setUserInput] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [idMappings, setIdMappings] = useState<SerializableIdMappings | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  const [isClarifying, setIsClarifying] = useState<boolean>(false);
  const [currentClarificationQuestion, setCurrentClarificationQuestion] = useState<string | null>(null);
  const [currentClarificationOptions, setCurrentClarificationOptions] = useState<ClarificationOption[] | null>(null);
  const [persistedStateForClarification, setPersistedStateForClarification] = useState<PersistedClarificationState | null>(null);

  // Ref for scrolling
  const messagesEndRef = useRef<null | HTMLDivElement>(null);

  // useEffect to generate sessionId on mount
  useEffect(() => {
    setSessionId(uuidv4());
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleConfirm = async (confirm: boolean) => {
    if (!pendingConfirmation || isLoading) return;

    const action = confirm ? 'apply' : 'clear';
    const changesToProcess = pendingConfirmation.stagedChanges;

    setIsLoading(true);
    setError(null);
    setPendingConfirmation(null);

    setMessages(prev => [...prev, { type: 'human', content: confirm ? '(Confirm Apply)' : '(Cancel)' }]);

    try {
      const response = await fetch('/api/changes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          action: action, 
          stagedChanges: changesToProcess,
          idMappings: idMappings
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || data.message || `API request to /api/changes failed (${action})`);
      }

      if (data.responseToUser) {
          setMessages(prev => [...prev, { type: 'ai', content: data.responseToUser }]);
      }

      if (data.idMappings) {
          console.log("[Frontend] Received ID Mappings from /api/changes:", data.idMappings);
          setIdMappings(data.idMappings);
      } else {
          setIdMappings(null);
      }

    } catch (err: any) {
      console.error(`Frontend error during ${action} confirmation:`, err);
      setError(err.message || 'An unexpected error occurred.');
      setMessages(prev => [...prev, { type: 'ai', content: `Error: ${err.message || 'An unexpected error occurred.'}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessageToAgent = async (input: string) => {
    if (!input.trim() || isLoading || pendingConfirmation) return; 
    if (!sessionId) {
      console.error("Session ID not initialized!");
      setError("Session ID not initialized. Please refresh or try again.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    // Add user message to local UI state immediately
    const newUserMessage: Message = { type: 'human', content: input };
    setMessages(prev => [...prev, newUserMessage]);
    setUserInput(''); // Clear input field

    try {
      const requestBody = {
        userInput: input,
        sessionId: sessionId
      };

      console.log("Sending to /api/agent:", requestBody);

      const response = await fetch('/api/agent', { // Changed endpoint
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      console.log("[Frontend] Received from /api/agent:", data);

      if (!response.ok || !data.success) {
        // Use error from API response if available, otherwise a generic one
        const errorMessage = data.error || data.message || 'API request to /api/agent failed';
        throw new Error(errorMessage);
      }

      // Handle successful response
      if (data.assistantResponse) {
        setMessages(prev => [...prev, { type: 'ai', content: data.assistantResponse }]);
      }

      if (data.agentState && data.agentState.id_map) {
        console.log("[Frontend] Received ID Mappings from /api/agent:", data.agentState.id_map);
        // Assuming SerializableIdMappings is compatible with AgentState['id_map']
        setIdMappings(data.agentState.id_map as SerializableIdMappings);
      } else {
        // Decide if idMappings should be cleared if not present, 
        // or if agentState itself is missing
        // setIdMappings(null); // Or handle based on specific needs
      }

      // TODO: Re-evaluate and adapt confirmation/clarification logic based on new agentState
      // For now, clearing them as the new agent manages flow differently.
      setPendingConfirmation(null);
      setIsClarifying(false);
      setCurrentClarificationQuestion(null);
      setCurrentClarificationOptions(null);
      setPersistedStateForClarification(null);

    } catch (err: any) {
      console.error("Frontend error calling /api/agent:", err);
      const displayError = err.message || 'An unexpected error occurred.';
      setError(displayError);
      setMessages(prev => [...prev, { type: 'ai', content: `Error: ${displayError}` }]);
      
      // Clear any pending UI states on error
      setIsClarifying(false);
      setCurrentClarificationQuestion(null);
      setCurrentClarificationOptions(null);
      setPersistedStateForClarification(null);
      setPendingConfirmation(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Simplified: always call sendMessageToAgent with current userInput
    // Old clarification logic is removed for now, will be driven by LLM responses via agentState
    sendMessageToAgent(userInput);
  };

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 style={{ marginBottom: '1rem' }}>Voca Agent Interface</h1>

        <div style={{
          height: '60vh',
          width: '100%',
          maxWidth: '700px',
          overflowY: 'auto',
          border: '1px solid var(--gray-alpha-200)',
          backgroundColor: 'var(--background)',
          color: 'var(--foreground)',
          marginBottom: '1rem',
          padding: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          {messages.map((msg, index) => (
            <div 
              key={index} 
              data-testid={msg.type === 'ai' ? `assistant-message-${index}` : `human-message-${index}`}
              style={{
                alignSelf: msg.type === 'human' ? 'flex-end' : 'flex-start',
                background: msg.type === 'human' 
                  ? 'rgba(var(--foreground-rgb), 0.1)'
                  : 'rgba(var(--gray-rgb), 0.1)',
                color: 'var(--foreground)',
                padding: '8px 12px',
                borderRadius: '10px',
                maxWidth: '80%'
              }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', margin: 0, fontFamily: 'inherit', fontSize: 'inherit' }}>{msg.content}</pre>
            </div>
          ))}
          {isClarifying && currentClarificationOptions && !isLoading && (
            <div style={{ 
                alignSelf: 'flex-start', 
                background: '#e9ecef',
                padding: '8px 12px', 
                borderRadius: '10px', 
                maxWidth: '80%', 
                marginTop: '5px',
                border: '1px solid #ced4da'
            }}>
                <p style={{ margin: '0 0 5px 0', fontWeight: 'bold' }}>{currentClarificationQuestion || "Please choose one:"}</p>
                <ul style={{ margin: 0, paddingLeft: '20px' }}>
                    {currentClarificationOptions.map((option, index) => (
                        <li key={option.id || index}>
                            {index + 1}. {option.name} ({option.type}) - <i>ID: {option.id}</i>
                        </li>
                    ))}
                     <li>Type 'cancel' to abort.</li>
                </ul>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {pendingConfirmation && !isLoading && !isClarifying && (
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '10px' }}>
            <button onClick={() => handleConfirm(true)} style={{ padding: '10px 15px', background: '#28a745', color: 'white', border: 'none', borderRadius: '5px' }}>Confirm</button>
            <button onClick={() => handleConfirm(false)} style={{ padding: '10px 15px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '5px' }}>Cancel</button>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '700px', display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={
              isLoading ? "Agent thinking..." : 
              isClarifying ? "Enter choice (e.g., 1, ID, name, or cancel)..." : 
              pendingConfirmation ? "Confirm or Cancel above" : 
              "Enter your command..."
            }
            disabled={isLoading || (!!pendingConfirmation && !isClarifying)} 
            style={{ flexGrow: 1, padding: '10px', border: '1px solid #ccc' }}
            aria-label={isClarifying ? "Clarification choice input" : "User command input"}
            data-testid="chat-input"
          />
          <button 
            type="submit" 
            disabled={isLoading || (!!pendingConfirmation && !isClarifying) || (isClarifying && !userInput.trim())} 
            style={{ padding: '10px 15px' }}
            data-testid="chat-send-button"
          >
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </form>

        {error && !isLoading && (
          <div style={{ marginTop: '1rem', color: 'red', background: '#f8d7da', border: '1px solid #f5c6cb', padding: '10px', borderRadius: '5px' }}>
            Error: {error}
          </div>
        )}

      </main>
    </div>
  );
} 