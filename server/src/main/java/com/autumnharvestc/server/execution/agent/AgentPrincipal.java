package com.autumnharvestc.server.execution.agent;

/** Agent identity is never a member identity and confers no project material access. */
public record AgentPrincipal(long agentId) {
    public static final String ATTRIBUTE="apicc.agent";
}
