/**
 * Options Schema - User-configurable options for Hypatia Zero
 */

import { z } from 'zod';

// ============================================================
// Options Schema
// ============================================================

export const optionsSchema = z.object({
  _version: z.number().default(1),

  // Layer opacities
  earth: z.object({
    opacity: z.number().min(0).max(1).default(1),
  }),
  sun: z.object({
    enabled: z.boolean().default(true),
  }),
  grid: z.object({
    enabled: z.boolean().default(true),
    opacity: z.number().min(0).max(1).default(0.3),
  }),
  temp: z.object({
    opacity: z.number().min(0).max(1).default(0.6),
  }),
  rain: z.object({
    opacity: z.number().min(0).max(1).default(0.8),
  }),

  // Viewport
  viewport: z.object({
    mass: z.number().min(1).max(20).default(10),
  }),
});

export type ZeroOptions = z.infer<typeof optionsSchema>;

export const defaultOptions: ZeroOptions = {
  _version: 1,
  earth: { opacity: 1 },
  sun: { enabled: true },
  grid: { enabled: true, opacity: 0.3 },
  temp: { opacity: 0.6 },
  rain: { opacity: 0.8 },
  viewport: { mass: 10 },
};
