package com.autumnharvestc.server.collaboration.audit;

/** No request target, query, headers, body, IP or credential fields exist in this stored type. */
public record MockLogEntry(String publicationId,long version,String time,String method,String routeTemplate,String ruleId,
        int status,long durationMs,String reason,String requestId,String grantPublicId) {}
