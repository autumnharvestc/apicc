package com.autumnharvestc.server.execution.notifications;

import com.autumnharvestc.server.execution.scheduling.NotificationProperties;

public record NotificationLimits(long requestTimeoutMs,int maxAttempts,long retryMinMs,long retryMaxMs,
                                 double jitterRatio,long deliveryTtlMs,int maxPayloadBytes,int maxResponseBytes) {
    public static NotificationLimits deployment(NotificationProperties p){return new NotificationLimits(p.getRequestTimeoutMs(),p.getMaxAttempts(),p.getRetryMinMs(),p.getRetryMaxMs(),p.getJitterRatio(),p.getDeliveryTtlMs(),p.getMaxPayloadBytes(),p.getMaxResponseBytes());}
    public void validate(NotificationProperties p){
        if(requestTimeoutMs<1000||requestTimeoutMs>p.getRequestTimeoutMs()||requestTimeoutMs+2*p.getScanIntervalMs()>=p.getLeaseMs()||maxAttempts<1||maxAttempts>p.getMaxAttempts()||retryMinMs<1000||retryMinMs>retryMaxMs||retryMaxMs>p.getRetryMaxMs()||!Double.isFinite(jitterRatio)||jitterRatio<0||jitterRatio>p.getJitterRatio()||deliveryTtlMs<1000||deliveryTtlMs>p.getDeliveryTtlMs()||maxPayloadBytes<1024||maxPayloadBytes>p.getMaxPayloadBytes()||maxResponseBytes<0||maxResponseBytes>p.getMaxResponseBytes())throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.BAD_REQUEST,"notification-policy-conflict","通知渠道额度超出部署上限或租约预算");
    }
}
