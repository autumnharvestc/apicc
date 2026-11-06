package com.autumnharvestc.server.sync;
import jakarta.validation.constraints.*;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.validation.annotation.Validated;
/** Deployment budgets; milliseconds/counts are explicit and shared by preview and admission. */
@Component @Validated
@ConfigurationProperties(prefix="apicc.sync.scheduler",ignoreUnknownFields=false)
public class SyncScheduleProperties {
    @Min(60000) @Max(86400000) private long minIntervalMs=60000;
    @Min(1) @Max(1000) private int scanBatchSize=50;
    @Min(1) @Max(1000) private int claimBatchSize=25;
    @Min(10) @Max(100000) private int evaluationMaxCandidates=5000;
    @Min(60000) @Max(604800000) private long evaluationWindowMs=86400000;
    @Min(1) @Max(10000) private int maxOccurrencesPerProject=1000;
    @AssertTrue(message="sync claim batch must not exceed scan batch") public boolean isValid(){return claimBatchSize<=scanBatchSize;}
    public long getMinIntervalMs(){return minIntervalMs;}public void setMinIntervalMs(long value){minIntervalMs=value;}
    public int getScanBatchSize(){return scanBatchSize;}public void setScanBatchSize(int value){scanBatchSize=value;}
    public int getClaimBatchSize(){return claimBatchSize;}public void setClaimBatchSize(int value){claimBatchSize=value;}
    public int getEvaluationMaxCandidates(){return evaluationMaxCandidates;}public void setEvaluationMaxCandidates(int value){evaluationMaxCandidates=value;}
    public long getEvaluationWindowMs(){return evaluationWindowMs;}public void setEvaluationWindowMs(long value){evaluationWindowMs=value;}
    public int getMaxOccurrencesPerProject(){return maxOccurrencesPerProject;}public void setMaxOccurrencesPerProject(int value){maxOccurrencesPerProject=value;}
}
