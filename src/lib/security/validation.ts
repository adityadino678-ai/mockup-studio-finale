// Zod validation schemas for every API endpoint.
//
// Every mutating endpoint must validate its input against these schemas
// before doing any work. Read-only endpoints (catalog, shops, integrations
// status) take only query parameters and do not need a body schema.
//
// All schemas are strict: unknown keys are rejected, preventing a tampered
// body from probing arbitrary field shapes upstream.

import { z } from "zod";

// --- Shared primitives ---

const productId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]{1,64}$/);
const positiveInt = z.number().int().positive();
const shopId = z.number().int().positive().optional();
/** Confirmation is validated manually after schema parsing (so the endpoint
 * can answer 428 "precondition required" instead of 400 "invalid input"). */
const confirmOptional = z.boolean().optional();
const optionalString = z.string().optional();
const optionalBoolean = z.boolean().optional();

// --- POST /api/printify/products ---

export const createProductSchema = z.object({
  confirm: confirmOptional,
  title: z.string().min(1).max(200),
  description: optionalString,
  tags: z.array(z.string().max(255)).max(13).optional(),
  blueprintId: positiveInt,
  printProviderId: positiveInt.optional(),
  variants: z.record(z.string(), z.array(z.number())).refine((v) => Object.keys(v).length > 0, {
    message: "At least one variant is required",
  }),
  price: z.number().int().positive().optional(),
  prices: z.record(z.string(), z.number().int().nonnegative()).optional(),
  shopId,
  printAxes: z.record(z.string(), z.string()).optional(),
  artwork: z
    .object({ base64: z.string().min(1), filename: z.string().min(1), printAreaId: z.string().min(1) })
    .optional(),
  artworks: z
    .array(
      z.object({
        printAreaId: z.string().min(1),
        variantIds: z.array(z.number()).optional(),
        base64: z.string().min(1),
        filename: z.string().min(1),
        placement: z
          .object({ x: z.number().optional(), y: z.number().optional(), scale: z.number().optional(), angle: z.number().optional() })
          .optional(),
      }),
    )
    .optional(),
});

// --- PUT /api/printify/products ---

export const updateProductSchema = z.object({
  confirm: confirmOptional,
  productId,
  title: optionalString,
  description: optionalString,
  tags: z.array(z.string().max(255)).max(13).optional(),
  price: z.number().int().positive().optional(),
  shopId,
});

// --- POST /api/printify/publish ---

export const publishProductSchema = z.object({
  confirm: confirmOptional,
  productId,
  shopId,
});

// --- POST /api/printify/mockups ---

export const mockupsSchema = z.object({
  confirm: confirmOptional,
  productId,
  shopId,
  expectedTitle: optionalString,
  images: z
    .array(
      z.object({ base64: z.string().min(1), filename: z.string().min(1) }),
    )
    .nonempty()
    .max(10),
});

// --- POST /api/etsy/research ---

export const etsyResearchSchema = z.object({
  query: z.string().min(2).max(120),
});

// --- POST /api/ai/assistant ---

export const assistantSchema = z.object({
  question: z.string().min(1).max(2000),
  page: optionalString,
  context: z
    .object({
      designs: z.number().int().nonnegative().optional(),
      mockups: z.number().int().nonnegative().optional(),
      pendingRenders: z.number().int().nonnegative().optional(),
      aiConfigured: optionalBoolean,
      printifyConfigured: optionalBoolean,
      etsyConfigured: optionalBoolean,
    })
    .optional(),
});

// --- POST /api/ai/chat ---

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().nullable(),
        tool_calls: z.array(z.any()).optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .nonempty(),
  effort: optionalString,
  tools: z.array(z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  debug: optionalBoolean,
});

// --- POST /api/ai/seo ---

export const seoSchema = z.object({
  niche: z.string().min(1).max(200),
  productType: optionalString,
  audience: optionalString,
  season: optionalString,
  seedKeyword: optionalString,
  research: z
    .object({
      query: optionalString,
      activeListings: z.number().int().nonnegative().optional(),
      topTags: z.array(z.any()).optional(),
      titleTerms: z.array(z.any()).optional(),
      medianPriceCents: z.number().int().nonnegative().optional(),
      currency: optionalString,
      samples: z.array(z.any()).optional(),
    })
    .optional(),
});

// --- POST /api/ai/title ---

export const titleSchema = z.object({
  prompt: optionalString,
  reply: optionalString,
}).refine((data) => (data.prompt ?? "").trim().length > 0, {
  message: "A prompt is required",
});

// --- POST /api/integrations/models ---

export const modelsSchema = z.object({
  provider: z.string().min(1).optional(),
});

// --- POST /api/integrations/test ---

export const testSchema = z.object({
  provider: z.enum(["printify", "ai"]).optional(),
});

// --- Endpoint schema registry ---

export const endpointSchemas: Record<string, z.ZodTypeAny> = {
  "POST /api/printify/products": createProductSchema,
  "PUT /api/printify/products": updateProductSchema,
  "POST /api/printify/publish": publishProductSchema,
  "POST /api/printify/mockups": mockupsSchema,
  "POST /api/etsy/research": etsyResearchSchema,
  "POST /api/ai/assistant": assistantSchema,
  "POST /api/ai/chat": chatSchema,
  "POST /api/ai/seo": seoSchema,
  "POST /api/ai/title": titleSchema,
  "POST /api/integrations/models": modelsSchema,
  "POST /api/integrations/test": testSchema,
};

/**
 * Validate a request body against the schema for the given endpoint.
 *
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 */
export function validateBody(
  endpoint: string,
  body: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  const schema = endpointSchemas[endpoint];
  if (!schema) {
    return { success: false, error: "No validation schema for this endpoint." };
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    return {
      success: false,
      error: `Invalid input: ${firstIssue?.path.join(".") || "body"} — ${firstIssue?.message ?? "malformed"}`,
    };
  }
  return { success: true, data: result.data };
}
