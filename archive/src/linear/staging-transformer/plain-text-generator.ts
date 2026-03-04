import chalk from 'chalk';
import { saveDiagnosticData } from './json-utils';
import { type ILLMClient } from '@/api';
import { LinearCommandProcessor } from '../../api/adapters/linear-command-processor';
import { type IdMapper } from '@/linear/id-mapper';
import { type LinearGuid } from '../../types/linear-ids';
import {
  PLAIN_TEXT_BASE_PROMPT,
  RESPONSE_FORMAT_INSTRUCTIONS
} from '../prompts';

/**
 * Class responsible for generating plain-text staging content
 */
export class PlainTextGenerator {
  private processor: LinearCommandProcessor;
  private focusedProjectId: LinearGuid | null;
  private focusedProjectName: string;
  private lastResponseHadChanges = false;
  private idMapper: IdMapper;

  constructor(
    geminiAPI: ILLMClient,
    focusedProjectId: LinearGuid | null,
    focusedProjectName: string,
    idMapper: IdMapper
  ) {
    this.focusedProjectId = focusedProjectId;
    this.focusedProjectName = focusedProjectName;
    this.idMapper = idMapper;
    this.processor = new LinearCommandProcessor(geminiAPI);
  }

  /**
   * Check if the last response had changes
   * @returns True if the last response contained changes
   */
  public hasChanges(): boolean {
    return this.lastResponseHadChanges;
  }

  /**
   * Generate a plain-text representation of the changes and conversational response
   * @param userCommand The natural language command from the user
   * @param context Additional context for the LLM
   * @returns Plain text staging result with conversational elements
   */
  public async generatePlainTextStaging(
    userCommand: string, 
    context: Record<string, any> | any[]
  ): Promise<{ conversationalResponse: string; proposedChanges: Array<any> | null; }> {
    // Filter out UUIDs from the context before sending to model
    const sanitizedContext = this.stripUuids(context);

    // Structure the context to show project and its issues
    const contextSection = this.focusedProjectName
      ? `Here's the current context:\nProject: ${this.focusedProjectName}\nIssues in this project:\n${sanitizedContext}`
      : `Here's the current context:\nNo project is currently focused.\nIssues (across projects? - Context needs review for non-focused state):\n${sanitizedContext}`; // Adjust context presentation when not focused

    // Conditionally add ID note and focused project instructions
    let idNote = `Note: Project IDs may be shown as friendly IDs (P1, ABC-123). Issue IDs may be shown as friendly IDs (I1, ABC-123). Use these when referring to items.`;
    let focusedProjectInstructions = '';

    if (this.focusedProjectName && this.focusedProjectId) {
        idNote = `Note: Project IDs are shown in the format "P1" or "ABC-123" where these are friendly IDs.
Issue IDs are shown in the format "I1" or "ABC-123" where these are friendly IDs.
When referring to projects or issues, ALWAYS use the friendly ID (P1, I1, ABC-123) and NEVER use the raw Linear UUID.
IMPORTANT: The project "${this.focusedProjectName}" (${this.focusedProjectId}) is the focused project and should NEVER be deleted.`;
        
        focusedProjectInstructions = `IMPORTANT: You are currently focused on the project "${this.focusedProjectName}".
When proposing to create new issues, they should be created in this project.
The focused project already exists, so there's no need to create it again.
DO NOT attempt to delete the focused project - it must be preserved.`;
    }
      
    const prompt = `
${PLAIN_TEXT_BASE_PROMPT}

${contextSection}

${idNote}
${focusedProjectInstructions ? '\n' + focusedProjectInstructions : ''}

${RESPONSE_FORMAT_INSTRUCTIONS}

User request: "${userCommand}"
`;

    // Log for debugging
    saveDiagnosticData(prompt, 'staging-input');

    // Process the command with the LLM using the Linear command processor
    const response = await this.processor.processCommand(
      prompt,
      {} // Empty context since we're passing a fully formed prompt
    );
    
    // Format the response
    let convResponse = response.conversationalResponse || response.tts_response || '';
    let proposedChanges = response.proposedChanges || null;
    
    // --- Set internal flags based on proposedChanges ---
    if (proposedChanges && proposedChanges.length > 0) {
      this.lastResponseHadChanges = true; 
      console.log(chalk.yellowBright('[DEBUG] Proposed changes received:'));
      console.log(chalk.yellowBright(JSON.stringify(proposedChanges, null, 2)));
    } else {
      this.lastResponseHadChanges = false;
    }
    // --- End flag setting ---

    // Log for debugging
    saveDiagnosticData(
      {
        conversationalResponse: convResponse,
        proposedChanges
      }, 
      'staging-output'
    );
    
    // --- Return structured object directly ---
    return { 
        conversationalResponse: convResponse, 
        proposedChanges: proposedChanges 
    };
  }

  /**
   * Remove UUID fields from the context JSON before sending to model
   * and create a more compact representation that uses fewer tokens
   */
  private stripUuids(contextObject: Record<string, any> | any[]): string {
    try {
      let primaryIssue: any = null;
      let relatedIssue: any = null;
      let issuesInProject: any[] = [];

      // --- Extract primary, related, and list context ---
      if (typeof contextObject === 'object' && contextObject !== null && !Array.isArray(contextObject)) {
        if (contextObject.primary) {
          console.log("[stripUuids] Found primary context.");
          primaryIssue = contextObject.primary;
        }
        if (contextObject.related) {
          console.log("[stripUuids] Found related context.");
          relatedIssue = contextObject.related;
        }
        if (Array.isArray(contextObject.issuesInProject)) {
          console.log(`[stripUuids] Found list context with ${contextObject.issuesInProject.length} issues.`);
          issuesInProject = contextObject.issuesInProject;
        }

        // Handle case where the top-level object might *be* the primary issue
        if (!primaryIssue && !relatedIssue && !issuesInProject.length && contextObject.id && contextObject.identifier) {
           console.log("[stripUuids] Assuming top-level object is the primary issue context.");
           primaryIssue = contextObject;
        }

      } else if (Array.isArray(contextObject)) {
         console.warn('[stripUuids] Warning: Context data is an array. Attempting to process as list.');
         issuesInProject = contextObject;
      } else if (contextObject) { // Catch other non-null, non-array, non-object cases (shouldn't happen often)
         console.error('[stripUuids] Error: Context data is not a valid object or array:', JSON.stringify(contextObject));
         throw new Error('stripUuids received invalid context data type.');
      }
      // --- End extraction ---

      // --- Helper function to process a single issue object ---
      const processIssue = (issue: any): any => {
        if (!issue || typeof issue !== 'object') return null;
        const { id, identifier, title, description, state, parent } = issue;

        const truncatedDescription = description && description.length > 100
          ? description.substring(0, 97) + '...'
          : description;

        let parentFriendlyId = null;
        if (parent && parent.id && this.idMapper) { // Check idMapper exists
          parentFriendlyId = this.idMapper.getFriendlyId('issue', parent.id);
          if (!parentFriendlyId && parent.identifier) {
            parentFriendlyId = parent.identifier;
          }
        } else if (parent && parent.identifier) { // Fallback if no idMapper
            parentFriendlyId = parent.identifier;
        }

        return {
          identifier: identifier || id,
          title,
          description: truncatedDescription,
          state: state?.name || 'Unknown',
          parentId: parentFriendlyId || null
        };
      };
      // --- End helper function ---

      // --- Process extracted context ---
      const processedPrimary = processIssue(primaryIssue);
      const processedRelated = processIssue(relatedIssue);
      const processedList = issuesInProject.map(processIssue).filter(i => i !== null); // Process and remove nulls

      // --- Build the compact text representation ---
      let compactText = '';
      let contextParts: string[] = [];

      if (processedPrimary) {
         console.log(`[DEBUG] Processing primary issue: ${processedPrimary.identifier}`);
         const statePart = processedPrimary.state ? ` (${processedPrimary.state})` : '';
         const parentPart = processedPrimary.parentId ? ` [Parent: ${processedPrimary.parentId}]` : '';
         const descPart = processedPrimary.description ? `\n   Description: ${processedPrimary.description}` : '';
         contextParts.push(`Target Issue:\n- ${processedPrimary.identifier}: ${processedPrimary.title}${statePart}${parentPart}${descPart}`);
      }

      if (processedRelated) {
          console.log(`[DEBUG] Processing related issue: ${processedRelated.identifier}`);
          const statePart = processedRelated.state ? ` (${processedRelated.state})` : '';
          const parentPart = processedRelated.parentId ? ` [Parent: ${processedRelated.parentId}]` : '';
          const descPart = processedRelated.description ? `\n   Description: ${processedRelated.description}` : '';
          contextParts.push(`Related Issue:\n- ${processedRelated.identifier}: ${processedRelated.title}${statePart}${parentPart}${descPart}`);
      }

      if (processedList.length > 0) {
          console.log(`[DEBUG] Processing ${processedList.length} issues from list context`);
          const listText = processedList.map((issue: any) => {
             const statePart = issue.state ? ` (${issue.state})` : '';
             const parentPart = issue.parentId ? ` [Parent: ${issue.parentId}]` : '';
             const descPart = issue.description ? `\n   Description: ${issue.description}` : '';
             return `- ${issue.identifier}: ${issue.title}${statePart}${parentPart}${descPart}`;
          }).join('\n');
          // Add a header only if there's no primary/related context also present
          // to avoid redundancy if the list *is* the primary context (e.g., from search)
          if (!processedPrimary && !processedRelated) {
              contextParts.push(`Issues in Context:\n${listText}`);
          } else {
              // If primary/related exists, just append the list without a redundant header
              // (Assuming the list represents issues in the project containing primary/related)
               contextParts.push(`Other Issues in Project:\n${listText}`);
          }
      }
      
      compactText = contextParts.join('\n\n'); // Join parts with double newline

      // Log the length of the generated text
      console.log(`[DEBUG] Generated context text length: ${compactText.length} characters`);

      return compactText || 'No relevant context found.'; // Return something if context was totally empty

    } catch (e) {
      console.error(chalk.red('Error sanitizing context:'), e);
      // Return stringified original object on error for debugging
      return JSON.stringify(contextObject);
    }
  }
} 