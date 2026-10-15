import type { DeepReadonly } from "../assets/snapshot.js";
import type { ApiAsset, ApiRequest } from "../contract/model.js";
import type { TestCase } from "../domain/common.js";

export function getEffectiveCaseRequest(
  asset: DeepReadonly<ApiAsset>,
  testCase: DeepReadonly<TestCase>,
): DeepReadonly<ApiRequest> {
  return testCase.requestOverride ?? asset.contract.request;
}
