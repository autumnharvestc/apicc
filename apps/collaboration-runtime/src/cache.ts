import type { CompiledMockPlan } from "@apicc/core/collaboration";
import { CompiledMockPlanSchema } from "@apicc/core/collaboration/shared";
/** Serialized safe plans only. No source files, policy or authorization decisions. */
export class PlanCache {
  private readonly plans = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly coreBuildIdentity: string) {}
  put(digest: string, plan: CompiledMockPlan): void {
    const parsed = CompiledMockPlanSchema.safeParse(plan);
    if (!parsed.success) throw new Error("RPC_PLAN_INVALID");
    const bytes = Buffer.from(JSON.stringify(parsed.data));
    const previous = this.plans.get(digest);
    if (previous) { this.bytes -= previous.length; this.plans.delete(digest); }
    if (bytes.length > this.maxBytes) return;
    while (this.bytes + bytes.length > this.maxBytes && this.plans.size) {
      const oldest = this.plans.keys().next().value!;
      this.bytes -= this.plans.get(oldest)!.length; this.plans.delete(oldest);
    }
    this.plans.set(digest, bytes); this.bytes += bytes.length;
  }
  get(digest: string, coreBuildIdentity = this.coreBuildIdentity): CompiledMockPlan | undefined {
    if (coreBuildIdentity !== this.coreBuildIdentity) return undefined;
    const bytes = this.plans.get(digest);
    if (!bytes) return undefined;
    this.plans.delete(digest); this.plans.set(digest, bytes);
    return CompiledMockPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  }
}
