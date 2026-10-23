import { IpcChannel, IpcEvent } from "../shared/channels.js";
import { z } from "zod";
import { StressComparisonSchema } from "@apicc/core/schema";
import { ProjectLocatorSchema, type ProjectLocator } from "../shared/locations.js";
import { SavedStressPlanResultSchema, StressPlanSaveInputSchema, StressCompareInputSchema, StressExportInputSchema, StressExportResultSchema, StressReportDTOSchema, StressRunSummaryDTOSchema, StressReportFileSchema, type StressPlanSaveInput, type StressCompareInput, type StressExportInput } from "../shared/types.js";
import type { IpcChannelName } from "../shared/channels.js";
import { createStressRunInvoker, StressRunResultSchema, StressProgressDTOSchema, type StressStopInput, type AnyStressRunOutput, type StressProgressDTO } from "../shared/types.js";

export interface StressIpcInvoker {
  invoke(channel: IpcChannelName, ...args: unknown[]): Promise<unknown>;
  on?(channel: string, listener: (_event: unknown, progress: StressProgressDTO) => void): unknown;
  removeListener?(channel: string, listener: (_event: unknown, progress: StressProgressDTO) => void): unknown;
}

/** The same invoke/clone boundary used by preload, kept pure for an IPC-equivalent test seam. */
export function createStressPreloadApi(ipcRenderer: StressIpcInvoker) {
  return {
    async stressPlansList(scope: ProjectLocator) { return z.array(SavedStressPlanResultSchema).parse(await ipcRenderer.invoke(IpcChannel.StressPlansList, ProjectLocatorSchema.parse(scope))); },
    async stressRunsList(scope: ProjectLocator) { return z.array(StressRunSummaryDTOSchema).parse(await ipcRenderer.invoke(IpcChannel.StressRunsList, ProjectLocatorSchema.parse(scope))); },
    async stressRunsGet(scope: ProjectLocator, file: string) { return StressReportDTOSchema.parse(await ipcRenderer.invoke(IpcChannel.StressRunsGet, ProjectLocatorSchema.parse(scope), StressReportFileSchema.parse(file))); },
    async stressPlansGet(scope: ProjectLocator, id: string) { return SavedStressPlanResultSchema.nullable().parse(await ipcRenderer.invoke(IpcChannel.StressPlansGet, ProjectLocatorSchema.parse(scope), z.string().uuid().parse(id))); },
    async stressPlansSave(scope: ProjectLocator, input: StressPlanSaveInput) { return SavedStressPlanResultSchema.parse(await ipcRenderer.invoke(IpcChannel.StressPlansSave, ProjectLocatorSchema.parse(scope), StressPlanSaveInputSchema.parse(input))); },
    async stressPlansRemove(scope: ProjectLocator, id: string) { return SavedStressPlanResultSchema.nullable().parse(await ipcRenderer.invoke(IpcChannel.StressPlansRemove, ProjectLocatorSchema.parse(scope), z.string().uuid().parse(id))); },
    async stressCompare(scope: ProjectLocator, input: StressCompareInput) { return StressComparisonSchema.parse(await ipcRenderer.invoke(IpcChannel.StressCompare, ProjectLocatorSchema.parse(scope), StressCompareInputSchema.parse(input))); },
    async stressExport(scope: ProjectLocator, input: StressExportInput) { return StressExportResultSchema.parse(await ipcRenderer.invoke(IpcChannel.StressExport, ProjectLocatorSchema.parse(scope), StressExportInputSchema.parse(input))); },
    stressRun: createStressRunInvoker((input) => ipcRenderer.invoke(IpcChannel.StressRun, input)),
    onStressProgress(listener: (progress: StressProgressDTO) => void) {
      const receive = (_event: unknown, progress: StressProgressDTO) => { const parsed = StressProgressDTOSchema.safeParse(progress); if (parsed.success) listener(parsed.data); };
      ipcRenderer.on?.(IpcEvent.StressProgress, receive); return () => { ipcRenderer.removeListener?.(IpcEvent.StressProgress, receive); };
    },
    async stressStop(input?: StressStopInput): Promise<AnyStressRunOutput> {
      const result = StressRunResultSchema.parse(await ipcRenderer.invoke(IpcChannel.StressStop, ...(input ? [input] : [])));
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
  };
}
