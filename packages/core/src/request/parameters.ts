import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ParameterBinding, ParameterLocation } from "../contract/model.js";

export class RequestMaterializationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RequestMaterializationError";
  }
}

export interface MaterializedParameter {
  name: string;
  value: string;
  enabled: boolean;
  required: boolean;
}

export function materializeParameters(
  bindings: readonly DeepReadonly<ParameterBinding>[],
  location: ParameterLocation,
  context: ProjectAssetContextReadView,
  resolve: (template: string) => string,
): MaterializedParameter[] {
  return bindings.map((binding) => {
    let name: string;
    let required: boolean;
    let enabled: boolean;
    let value: string | undefined;

    if (binding.kind === "inline") {
      name = binding.name;
      required = binding.required;
      enabled = binding.enabled;
      value = binding.value;
    } else {
      const component = context.getComponent(binding.componentId);
      if (!component || component.kind !== "parameter") {
        throw new RequestMaterializationError("ASSET_REFERENCE_INVALID", "The request parameter reference is unavailable.");
      }
      name = component.definition.name;
      required = component.definition.required;
      enabled = binding.enabled ?? true;
      value = binding.value;
      if (component.definition.location !== location) {
        throw new RequestMaterializationError("ASSET_PARAMETER_LOCATION_MISMATCH", "The referenced parameter has a different location.");
      }
    }

    if (name.length === 0) {
      throw new RequestMaterializationError("ASSET_PARAMETER_INVALID", "The request parameter name is empty.");
    }

    return {
      name,
      value: enabled && value !== undefined ? resolve(value) : "",
      enabled,
      required,
    };
  });
}
