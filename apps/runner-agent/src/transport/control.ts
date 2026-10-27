import type { AgentControlTransport, ControlExchange, ControlBatchV1 } from "@apicc/execution/contract";
import type { AgentSupervisor } from "../supervisor.js";
export interface ControlLoopOptions { transport: AgentControlTransport; heartbeat(input: ControlExchange, signal: AbortSignal): Promise<ControlBatchV1>; supervisor: AgentSupervisor; sessionId: string; beforeExchange?(): Promise<void> }
function wait(ms: number, signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) { resolve(); return; } const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); }); }
/** Both lanes continue while full; transport is the scheduler's only control dependency. */
export async function runAgentControl(options: ControlLoopOptions, signal: AbortSignal): Promise<void> {
  const acknowledgements = new Set<string>();
  const exchange = (): ControlExchange => ({ sessionId: options.sessionId, appliedConfigVersion: options.supervisor.appliedConfigVersion, ...options.supervisor.capacity(), acknowledgements: [...acknowledgements] });
  const consume = (batch: ControlBatchV1, sent: string[]) => {
    for (const id of sent) acknowledgements.delete(id);
    for (const command of batch.commands) { if (options.supervisor.command(command) !== false) acknowledgements.add(command.messageId); }
    for (const delivery of batch.deliveries) { if (options.supervisor.receive(delivery) !== false) acknowledgements.add(delivery.messageId); }
  };
  const poll = async () => {
    let errors = 0;
    while (!signal.aborted) {
      try { await options.beforeExchange?.(); const input = exchange(); consume(await options.transport.exchange(input, signal), input.acknowledgements); errors = 0; }
      catch { if (signal.aborted) break; const config = options.supervisor.currentConfig; const ceiling = Math.min(config.reconnectMaxMs, config.reconnectMinMs * 2 ** Math.min(errors++, 30)); await wait(Math.min(config.reconnectMaxMs, ceiling * (1 - config.reconnectJitterRatio + Math.random() * 2 * config.reconnectJitterRatio)), signal); }
    }
  };
  const heartbeat = async () => { while (!signal.aborted) { try { await options.beforeExchange?.(); const input = exchange(); consume(await options.heartbeat(input, signal), input.acknowledgements); } catch { /* The next heartbeat is independent of the blocked poll/backoff lane. */ } await wait(options.supervisor.currentConfig.heartbeatIntervalMs, signal); } };
  const messages = async () => { while (!signal.aborted) { try { await options.supervisor.flushMessages(signal); } catch { /* Storage/transport failures cannot stall polling or delete unacknowledged entries. */ } await wait(options.supervisor.currentConfig.reconnectMinMs, signal); } };
  await Promise.all([poll(), heartbeat(), messages()]);
}
