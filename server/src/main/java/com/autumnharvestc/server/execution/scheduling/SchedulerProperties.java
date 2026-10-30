package com.autumnharvestc.server.execution.scheduling;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.validation.annotation.Validated;
import jakarta.validation.constraints.*;

@Component
@Validated
@ConfigurationProperties(prefix="apicc.scheduler",ignoreUnknownFields=false)
public class SchedulerProperties {
    private String mode="embedded";
    @Min(100) @Max(60000) private long scanIntervalMs=1000;
    @Min(3000) @Max(300000) private long claimLeaseMs=30000;
    @Min(1) @Max(100000) private long maxSchedules=10000;
    @Min(1) @Max(1000) private int batchSize=50;
    @Min(10) @Max(100000) private int evaluationMaxCandidates=5000;
    @AssertTrue(message="scheduler mode must be embedded/disabled and lease must cover three scans")
    public boolean isValid(){return ("embedded".equals(mode)||"disabled".equals(mode))&&claimLeaseMs>=3*scanIntervalMs;}
    public String getMode(){return mode;} public void setMode(String v){mode=v;}
    public long getScanIntervalMs(){return scanIntervalMs;} public void setScanIntervalMs(long v){scanIntervalMs=v;}
    public long getClaimLeaseMs(){return claimLeaseMs;} public void setClaimLeaseMs(long v){claimLeaseMs=v;}
    public long getMaxSchedules(){return maxSchedules;} public void setMaxSchedules(long v){maxSchedules=v;}
    public int getBatchSize(){return batchSize;} public void setBatchSize(int v){batchSize=v;}
    public int getEvaluationMaxCandidates(){return evaluationMaxCandidates;} public void setEvaluationMaxCandidates(int v){evaluationMaxCandidates=v;}
}
