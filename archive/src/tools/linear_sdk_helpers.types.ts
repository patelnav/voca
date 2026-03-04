import type { LinearGuid } from '@/types/linear-ids';

export interface ExecuteLinearOperationResult {
  success: boolean;
  newId?: LinearGuid;
  reason?: string;
}

export interface ResolveIdentifiersResult {
  success: boolean;
  resolvedData?: Record<string, any>;
  reason?: string;
} 