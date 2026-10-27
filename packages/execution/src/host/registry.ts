import { createBuiltinExecutionRegistry } from "@apicc/core";
export { createBuiltinExecutionRegistry as createExecutionRegistry } from "@apicc/core";
export type ExecutionRegistry = ReturnType<typeof createBuiltinExecutionRegistry>;
