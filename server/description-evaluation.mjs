import { z } from 'zod';
import { taskFormats } from '../shared/demo-evaluation.mjs';

export const evaluationSchema = z.object({
  taskFormat: z.enum(['', ...taskFormats.map(format => format.value)]).default(''),
  rolloutModel: z.string().trim().max(200).default(''),
  rolloutCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  passRate: z.number().min(0).max(100).nullable().default(null)
});

export const modelDifficultySchema = z.string().trim().max(5000).default('');
