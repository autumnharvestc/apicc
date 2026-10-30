package com.autumnharvestc.server.execution.scheduling;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import java.util.*;
import org.springframework.validation.annotation.Validated;
import jakarta.validation.constraints.*;

@Component
@Validated
@ConfigurationProperties(prefix="apicc.notification",ignoreUnknownFields=false)
public class NotificationProperties {
    @Min(100) @Max(60000) private long scanIntervalMs=1000;
    @Min(3000) @Max(300000) private long leaseMs=30000;
    @Min(1000) @Max(30000) private long requestTimeoutMs=5000;
    @Min(1000) @Max(3600000) private long retryMinMs=5000,retryMaxMs=300000;
    @Min(1000) @Max(604800000) private long deliveryTtlMs=86400000;
    @Min(1) @Max(100000) private long maxPendingDeliveries=10000;
    @Min(1) @Max(16) private int concurrency=2;
    @Min(1) @Max(20) private int maxAttempts=5;
    @Min(1024) @Max(65536) private int maxPayloadBytes=16384;
    @Min(0) @Max(65536) private int maxResponseBytes=8192;
    private double jitterRatio=0.2;
    private List<String> allowedWebhookOrigins=new ArrayList<>(),allowedWebhookCidrs=new ArrayList<>(),allowHttpOrigins=new ArrayList<>();
    @AssertTrue(message="notification lease, retry, jitter or outbound authorization is invalid")
    public boolean isValid(){return leaseMs>requestTimeoutMs+2*scanIntervalMs&&retryMinMs<=retryMaxMs&&Double.isFinite(jitterRatio)&&jitterRatio>=0&&jitterRatio<=1
        &&allowedWebhookOrigins.stream().allMatch(NotificationConfigurationBoundary::origin)&&allowedWebhookCidrs.stream().allMatch(NotificationConfigurationBoundary::cidr)
        &&allowHttpOrigins.stream().allMatch(v->NotificationConfigurationBoundary.origin(v)&&v.startsWith("http://")&&allowedWebhookOrigins.contains(v));}
    public long getScanIntervalMs(){return scanIntervalMs;}public void setScanIntervalMs(long v){scanIntervalMs=v;}
    public long getLeaseMs(){return leaseMs;}public void setLeaseMs(long v){leaseMs=v;}
    public long getRequestTimeoutMs(){return requestTimeoutMs;}public void setRequestTimeoutMs(long v){requestTimeoutMs=v;}
    public long getRetryMinMs(){return retryMinMs;}public void setRetryMinMs(long v){retryMinMs=v;}
    public long getRetryMaxMs(){return retryMaxMs;}public void setRetryMaxMs(long v){retryMaxMs=v;}
    public long getDeliveryTtlMs(){return deliveryTtlMs;}public void setDeliveryTtlMs(long v){deliveryTtlMs=v;}
    public long getMaxPendingDeliveries(){return maxPendingDeliveries;}public void setMaxPendingDeliveries(long v){maxPendingDeliveries=v;}
    public int getConcurrency(){return concurrency;}public void setConcurrency(int v){concurrency=v;}
    public int getMaxAttempts(){return maxAttempts;}public void setMaxAttempts(int v){maxAttempts=v;}
    public int getMaxPayloadBytes(){return maxPayloadBytes;}public void setMaxPayloadBytes(int v){maxPayloadBytes=v;}
    public int getMaxResponseBytes(){return maxResponseBytes;}public void setMaxResponseBytes(int v){maxResponseBytes=v;}
    public double getJitterRatio(){return jitterRatio;}public void setJitterRatio(double v){jitterRatio=v;}
    public List<String> getAllowedWebhookOrigins(){return List.copyOf(allowedWebhookOrigins);}public void setAllowedWebhookOrigins(List<String> v){allowedWebhookOrigins=new ArrayList<>(v);}
    public List<String> getAllowedWebhookCidrs(){return List.copyOf(allowedWebhookCidrs);}public void setAllowedWebhookCidrs(List<String> v){allowedWebhookCidrs=new ArrayList<>(v);}
    public List<String> getAllowHttpOrigins(){return List.copyOf(allowHttpOrigins);}public void setAllowHttpOrigins(List<String> v){allowHttpOrigins=new ArrayList<>(v);}
}
