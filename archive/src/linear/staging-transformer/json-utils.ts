import { z } from 'zod';
import { Logger } from '../../utils/logger';

/**
 * Safely parse a JSON string using Zod preprocessing
 */
export const safeJsonParse = <T>(schema: z.ZodType<T>) => {
  return z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch /* (error) */ {
      return val; // Return the original value if parsing fails
    }
  }, schema);
};

/**
 * Attempt to repair common JSON errors from LLMs
 * @param jsonStr String that should be JSON but may have errors
 * @returns Repaired JSON string that can be parsed
 */
export function repairJson(jsonStr: string): string {
  if (!jsonStr) return '[]';
  
  // Remove any markdown code block markers
  let cleaned = jsonStr;
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '').trim();
  }
  
  // Fix common JSON syntax issues
  let fixed = cleaned;
  
  // Handle unterminated strings by looking for unbalanced quotes
  // This is a simplified approach but works for most cases
  let inString = false;
  let escaped = false;
  let stringStartPos = -1;
  let openBraces = 0;
  let openBrackets = 0;
  
  // Track all unterminated strings
  const unterminatedStringPositions: number[] = [];
  
  // First scan for unterminated strings and unclosed braces/brackets
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (char === '"' && !escaped) {
      if (!inString) {
        inString = true;
        stringStartPos = i;
      } else {
        inString = false;
      }
      continue;
    }
    
    if (!inString) {
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;
    }
  }
  
  // If we end with an unterminated string, add a closing quote
  if (inString) {
    unterminatedStringPositions.push(stringStartPos);
  }
  
  // Repair unterminated strings by adding closing quotes
  // We repair from end to beginning to avoid messing up positions
  unterminatedStringPositions.sort((a, b) => b - a);
  for (const pos of unterminatedStringPositions) {
    // Find the end of what looks like a valid property value
    let end = pos;
    while (end < fixed.length && fixed[end] !== ',' && fixed[end] !== '}' && fixed[end] !== ']') {
      end++;
    }
    
    // Insert the closing quote
    fixed = fixed.substring(0, end) + '"' + fixed.substring(end);
  }
  
  // Fix trailing commas (common LLM JSON error)
  // - Match a comma followed by a closing bracket or brace
  fixed = fixed.replace(/,\s*(\]|\})/g, '$1');
  
  // Fix extra commas between closing and opening brackets/braces
  fixed = fixed.replace(/\}\s*,\s*\]/g, '}]');
  
  // Fix unbalanced braces and brackets
  if (openBraces > 0) {
    for (let i = 0; i < openBraces; i++) {
      fixed += '}';
    }
  } else if (openBraces < 0) {
    // Too many closing braces, add opening braces at the beginning
    const prefix = '{'.repeat(Math.abs(openBraces));
    fixed = prefix + fixed;
  }
  
  if (openBrackets > 0) {
    for (let i = 0; i < openBrackets; i++) {
      fixed += ']';
    }
  } else if (openBrackets < 0) {
    // Too many closing brackets, add opening brackets at the beginning
    const prefix = '['.repeat(Math.abs(openBrackets));
    fixed = prefix + fixed;
  }
  
  // Ensure the result is a valid JSON array if it doesn't look like an array or object
  if (!fixed.trim().startsWith('[') && !fixed.trim().startsWith('{')) {
    fixed = `[${fixed}]`;
  }
  
  // Add the ability to log the original and repaired JSON for debugging
  console.log(`JSON repair details:
Original length: ${jsonStr.length}
Repaired length: ${fixed.length}
Original last 50 chars: ${jsonStr.substring(Math.max(0, jsonStr.length - 50))}
Repaired last 50 chars: ${fixed.substring(Math.max(0, fixed.length - 50))}`);
  
  return fixed;
}

/**
 * Extract JSON from a response that might contain markdown formatting
 * @param response The raw response from the LLM
 * @returns A clean JSON string
 */
export function extractJsonFromResponse(response: string): string {
  // Check if the response is wrapped in markdown code blocks with json tag
  if (response.includes('```json')) {
    const parts = response.split('```json');
    if (parts.length > 1) {
      const jsonPart = parts[1].split('```')[0].trim();
      if (jsonPart) return jsonPart;
    }
  }
  
  // Check if the response is wrapped in generic markdown code blocks
  if (response.includes('```')) {
    const parts = response.split('```');
    if (parts.length > 1) {
      const jsonPart = parts[1].trim();
      if (jsonPart) return jsonPart;
    }
  }
  
  // Try to extract JSON by looking for an object or array pattern
  // Match either a complete JSON object {...} or array [...]
  const objectMatch = response.match(/(\{[\s\S]*\})/);
  const arrayMatch = response.match(/(\[[\s\S]*\])/);
  
  if (objectMatch) {
    return objectMatch[0].trim();
  }
  
  if (arrayMatch) {
    return arrayMatch[0].trim();
  }
  
  // Return the original response if no JSON format is detected
  return response.trim();
}

/**
 * Safely save diagnostic data to a file for debugging
 * @param data Data to save (content to write to file)
 * @param filename Base filename (will be sanitized by logger)
 */
export function saveDiagnosticData(data: any, filename: string): void {
  try {
    const logger = Logger.getInstance();
    logger.saveDiagnostic(data, filename);
  } catch (logError) {
    console.error('Failed to save diagnostic data:', logError);
  }
} 