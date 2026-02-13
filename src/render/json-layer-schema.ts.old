import { z } from 'zod';

export const jsonLayerSchema = z.object({
  params: z.array(z.string()).min(1, 'At least one param required'),
  palette: z.string().min(1, 'Palette name required'),
  interpolation: z.enum(['lerp', 'none']).default('lerp'),
  opacity: z.number().min(0).max(1).default(1),
});

export type JsonLayerConfig = z.infer<typeof jsonLayerSchema>;

export function validateLayerJson(json: unknown):
  | { success: true; data: JsonLayerConfig }
  | { success: false; errors: string[] } {
  const result = jsonLayerSchema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
