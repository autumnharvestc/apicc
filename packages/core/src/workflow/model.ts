import { z } from "zod";

export const WorkflowStatusSchema = z.enum(["draft", "published", "enabled"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["request", "noop"]),
    apiId: z.string().optional(),
    caseId: z.string().optional(),
    label: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  })
  .strict();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    condition: z.string().optional(),
  })
  .strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: WorkflowStatusSchema.default("draft"),
    nodes: z.array(WorkflowNodeSchema).default([]),
    edges: z.array(WorkflowEdgeSchema).default([]),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;
