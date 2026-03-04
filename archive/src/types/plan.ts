export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'requires_confirmation';

export interface PlanStep {
  id: string;
  description: string; // LLM-generated description of the step
  tool_to_call: string | null; // Name of the tool to call, if any
  tool_arguments: Record<string, any> | null; // Arguments for the tool, may contain placeholders
  status: PlanStepStatus;
  result_summary: string | null; // LLM-generated summary of this step's outcome
  tool_output_reference_id: string | null; // Optional ID to reference detailed output if stored elsewhere
  user_confirmation_prompt: string | null; // If step requires confirmation, this is the question to ask the user
}

export type PlanOverallStatus =
  | 'pending_creation' // Plan is being formulated
  | 'ready_to_execute' // Plan is formulated and ready for first step
  | 'in_progress' // Plan execution is underway
  | 'completed' // All steps successfully completed, final answer provided
  | 'failed' // Plan execution failed
  | 'clarification_needed' // Plan paused, waiting for user input
  | 'confirmation_awaited'; // Plan paused, waiting for user confirmation for a step

export interface Plan {
  original_user_goal: string;
  overall_status: PlanOverallStatus;
  steps: PlanStep[];
  next_step_id_to_execute: string | null;
  reasoning_log: string[]; // Log of LLM's reasoning during planning and execution
  final_answer_to_user: string | null; // The final answer provided to the user upon plan completion
  last_updated_timestamp: string; // ISO string for when the plan was last modified
} 