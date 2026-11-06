package com.autumnharvestc.server.sync;

import jakarta.validation.constraints.*;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.validation.annotation.Validated;

/** Internal ownership observation budgets; never supplied by a source or public API. */
@Component @Validated
@ConfigurationProperties(prefix="apicc.sync.check-worker",ignoreUnknownFields=false)
public class SyncCheckProperties {
    @Min(50) @Max(5000) private long monitorIntervalMs=250;
    @Min(1000) @Max(300000) private long leaseMs=10000;
    @Min(1) @Max(1000) private int recoveryBatchSize=25;
    @AssertTrue(message="sync check lease must cover at least three monitor intervals")
    public boolean isValid(){return leaseMs>=3*monitorIntervalMs;}
    public long getMonitorIntervalMs(){return monitorIntervalMs;}public void setMonitorIntervalMs(long value){monitorIntervalMs=value;}
    public long getLeaseMs(){return leaseMs;}public void setLeaseMs(long value){leaseMs=value;}
    public int getRecoveryBatchSize(){return recoveryBatchSize;}public void setRecoveryBatchSize(int value){recoveryBatchSize=value;}
}
