package com.autumnharvestc.server.execution;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.DecimalMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.validation.annotation.Validated;
import java.util.*;

/** Shared execution policy configuration seam; T4 adds policy management to this boundary. */
@Component
@Validated
@ConfigurationProperties(prefix = "apicc.execution")
public class ExecutionProperties {
    @Valid private final Policy policy = new Policy();
    @Valid private final Deployment deployment = new Deployment();
    private final Materials materials = new Materials();
    @Valid private final Jobs jobs = new Jobs();
    private final Map<String,Object> agent = new LinkedHashMap<>();
    private String controlBaseUrl = "";
    public String getControlBaseUrl(){return controlBaseUrl;}
    public void setControlBaseUrl(String value){controlBaseUrl=value;}
    /** Deployment authority, never inferred from request Host/Forwarded headers. */
    public String requireControlBaseUrl(){
        if(controlBaseUrl==null||controlBaseUrl.isBlank())throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.CONFLICT,"server_identity_unconfigured","代理控制服务身份尚未配置");
        try{var uri=new java.net.URI(controlBaseUrl);if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!"/api/v1".equals(uri.getPath())||!uri.normalize().equals(uri)||controlBaseUrl.endsWith("/"))throw new IllegalArgumentException();return uri.toASCIIString();}
        catch(Exception e){throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.CONFLICT,"server_identity_invalid","代理控制服务身份需要规范 HTTPS /api/v1 地址");}
    }
    public Policy getPolicy() { return policy; }
    public Deployment getDeployment() { return deployment; }
    public Materials getMaterials() { return materials; }
    public Jobs getJobs() { return jobs; }
    public static class Jobs {
        @Min(1) @Max(1000) private int defaultPageSize = 50;
        @Min(1) @Max(1000) private int maxPageSize = 200;
        public int getDefaultPageSize() { return defaultPageSize; }
        public void setDefaultPageSize(int value) { defaultPageSize = value; }
        public int getMaxPageSize() { return maxPageSize; }
        public void setMaxPageSize(int value) { maxPageSize = value; }
    }
    /** Deployment-only key source. No generated fallback key and no Web configuration view. */
    public static class Materials {
        private String masterKeyFile = "";
        private String keyId = "primary";
        public String getMasterKeyFile(){return masterKeyFile;} public void setMasterKeyFile(String v){masterKeyFile=v;}
        public String getKeyId(){return keyId;} public void setKeyId(String v){keyId=v;}
    }
    public Map<String,Object> getAgent() { return agent; }
    public Map<String,Object> agentDefaults() {
        var result=defaultAgent();
        for(var entry:agent.entrySet()) {
            String key=result.keySet().stream().filter(k->k.equalsIgnoreCase(entry.getKey().replace("-",""))).findFirst().orElse(entry.getKey());
            Object value=entry.getValue();
            if(result.containsKey(key)&&!key.equals("scriptMode")&&value instanceof String text) {
                try { value=new java.math.BigDecimal(text.trim()); }
                catch(NumberFormatException ignored) { /* The strict shared validation reports the field error. */ }
            }
            result.put(key,value);
        }
        return result;
    }
    public static LinkedHashMap<String,Object> defaultAgent() {
        var values=new LinkedHashMap<String,Object>();
        values.put("maxConcurrentJobs",1); values.put("sharedDebugMaxInFlight",4); values.put("sharedDebugIdleMs",60000);
        values.put("maxConcurrentStressJobs",1);values.put("maxStressProcesses",5);values.put("maxStressVus",100);
        values.put("maxStressRequestConcurrency",100);values.put("maxStressRps",1000);values.put("maxStressMetricMemoryBytes",335544320);values.put("stressProgressIntervalMs",1000);
        values.put("debugSessionIdleMs",1800000); values.put("maxDebugSessions",64); values.put("workerStartupTimeoutMs",15000);
        values.put("workerHeartbeatIntervalMs",1000); values.put("workerUnresponsiveAfterMs",15000); values.put("scriptMode","deny");
        values.put("childMaxOldSpaceMiB",256); values.put("longPollWaitMs",30000); values.put("controlRequestTimeoutMs",45000);
        values.put("pollTimeoutMarginMs",5000); values.put("heartbeatIntervalMs",10000); values.put("offlineAfterMs",30000);
        values.put("reconnectMinMs",1000); values.put("reconnectMaxMs",30000); values.put("reconnectJitterRatio",0.2);
        values.put("transferTimeoutMs",120000); values.put("transferRetryMinMs",1000); values.put("transferRetryMaxMs",30000);
        values.put("transferMaxAttemptsPerCycle",5); values.put("transferRetryCycleMs",60000); values.put("inputCacheBytes",1073741824);
        values.put("pendingResultBytes",268435456); values.put("faultReserveBytes",1048576); values.put("minFreeDiskBytes",536870912);
        return values;
    }
    public static class Deployment {
        @Min(1) @Max(1000) private int cleanupBatchSize=100;
        public int getCleanupBatchSize(){return cleanupBatchSize;} public void setCleanupBatchSize(int v){cleanupBatchSize=v;}
        @Min(1) @Max(9007199254740991L) private long maxAgentConcurrentJobs=32,auditRetentionDays=90,cleanupIntervalMs=3600000,enrollmentTtlMs=86400000;
        @Min(1) @Max(9007199254740991L) private Long agentMemoryLimitBytes;
        @DecimalMin(value="0",inclusive=false) private Double agentCpuLimit;
        public long getMaxAgentConcurrentJobs(){return maxAgentConcurrentJobs;} public void setMaxAgentConcurrentJobs(long v){maxAgentConcurrentJobs=v;}
        public long getAuditRetentionDays(){return auditRetentionDays;} public void setAuditRetentionDays(long v){auditRetentionDays=v;}
        public long getCleanupIntervalMs(){return cleanupIntervalMs;} public void setCleanupIntervalMs(long v){cleanupIntervalMs=v;}
        public long getEnrollmentTtlMs(){return enrollmentTtlMs;} public void setEnrollmentTtlMs(long v){enrollmentTtlMs=v;}
        public Long getAgentMemoryLimitBytes(){return agentMemoryLimitBytes;} public void setAgentMemoryLimitBytes(Long v){agentMemoryLimitBytes=v;}
        public Double getAgentCpuLimit(){return agentCpuLimit;} public void setAgentCpuLimit(Double v){agentCpuLimit=v;}
        public Map<String,Object> asMap(){var v=new LinkedHashMap<String,Object>();v.put("maxAgentConcurrentJobs",maxAgentConcurrentJobs);v.put("agentMemoryLimitBytes",agentMemoryLimitBytes);v.put("agentCpuLimit",agentCpuLimit);v.put("auditRetentionDays",auditRetentionDays);v.put("cleanupIntervalMs",cleanupIntervalMs);v.put("cleanupBatchSize",cleanupBatchSize);v.put("enrollmentTtlMs",enrollmentTtlMs);return v;}
    }
    public static class Policy {
        private long maxStressWorkers=4,maxStressVus=1000,maxStressRequestConcurrency=1000,stressMetricMemoryBytes=67108864,stressEvidenceMaxSamples=20;
        private double maxStressRps=1000;
        public long getMaxStressWorkers(){return maxStressWorkers;}public void setMaxStressWorkers(long v){maxStressWorkers=v;}
        public long getMaxStressVus(){return maxStressVus;}public void setMaxStressVus(long v){maxStressVus=v;}
        public long getMaxStressRequestConcurrency(){return maxStressRequestConcurrency;}public void setMaxStressRequestConcurrency(long v){maxStressRequestConcurrency=v;}
        public double getMaxStressRps(){return maxStressRps;}public void setMaxStressRps(double v){maxStressRps=v;}
        public long getStressMetricMemoryBytes(){return stressMetricMemoryBytes;}public void setStressMetricMemoryBytes(long v){stressMetricMemoryBytes=v;}
        public long getStressEvidenceMaxSamples(){return stressEvidenceMaxSamples;}public void setStressEvidenceMaxSamples(long v){stressEvidenceMaxSamples=v;}
        @Min(1) private long snapshotBytes = 67108864;
        @Min(1) private int maxAssetChangeFiles = 2000;
        public long getSnapshotBytes() { return snapshotBytes; }
        public void setSnapshotBytes(long value) { snapshotBytes = value; }
        public int getMaxAssetChangeFiles() { return maxAssetChangeFiles; }
        public void setMaxAssetChangeFiles(int value) { maxAssetChangeFiles = value; }
        @Min(1) @Max(9007199254740991L) private long maxQueuedJobs=1000,defaultJobTimeoutMs=1800000,maxJobTimeoutMs=86400000,cancelGraceMs=5000,
            scriptTimeoutMs=3000,maxScriptTimeoutMs=10000,singleAttachmentBytes=67108864,totalInputBytes=536870912,
            bodyPreviewBytes=65536,valuePreviewBytes=4096,caseEvidenceBytes=262144,reportBytes=16777216,
            workflowMetadataBytes=4194304,resultRetentionDays=30;
        @Min(1) @Max(9007199254740991L) private Long queueTimeoutMs;
        public long getMaxQueuedJobs(){return maxQueuedJobs;} public void setMaxQueuedJobs(long v){maxQueuedJobs=v;}
        public Long getQueueTimeoutMs(){return queueTimeoutMs;} public void setQueueTimeoutMs(Long v){queueTimeoutMs=v;}
        public long getDefaultJobTimeoutMs(){return defaultJobTimeoutMs;} public void setDefaultJobTimeoutMs(long v){defaultJobTimeoutMs=v;}
        public long getMaxJobTimeoutMs(){return maxJobTimeoutMs;} public void setMaxJobTimeoutMs(long v){maxJobTimeoutMs=v;}
        public long getCancelGraceMs(){return cancelGraceMs;} public void setCancelGraceMs(long v){cancelGraceMs=v;}
        public long getScriptTimeoutMs(){return scriptTimeoutMs;} public void setScriptTimeoutMs(long v){scriptTimeoutMs=v;}
        public long getMaxScriptTimeoutMs(){return maxScriptTimeoutMs;} public void setMaxScriptTimeoutMs(long v){maxScriptTimeoutMs=v;}
        public long getSingleAttachmentBytes(){return singleAttachmentBytes;} public void setSingleAttachmentBytes(long v){singleAttachmentBytes=v;}
        public long getTotalInputBytes(){return totalInputBytes;} public void setTotalInputBytes(long v){totalInputBytes=v;}
        public long getBodyPreviewBytes(){return bodyPreviewBytes;} public void setBodyPreviewBytes(long v){bodyPreviewBytes=v;}
        public long getValuePreviewBytes(){return valuePreviewBytes;} public void setValuePreviewBytes(long v){valuePreviewBytes=v;}
        public long getCaseEvidenceBytes(){return caseEvidenceBytes;} public void setCaseEvidenceBytes(long v){caseEvidenceBytes=v;}
        public long getReportBytes(){return reportBytes;} public void setReportBytes(long v){reportBytes=v;}
        public long getWorkflowMetadataBytes(){return workflowMetadataBytes;} public void setWorkflowMetadataBytes(long v){workflowMetadataBytes=v;}
        public long getResultRetentionDays(){return resultRetentionDays;} public void setResultRetentionDays(long v){resultRetentionDays=v;}
        public LinkedHashMap<String,Object> asMap(){var v=new LinkedHashMap<String,Object>();v.put("maxQueuedJobs",maxQueuedJobs);v.put("queueTimeoutMs",queueTimeoutMs);v.put("defaultJobTimeoutMs",defaultJobTimeoutMs);v.put("maxJobTimeoutMs",maxJobTimeoutMs);v.put("cancelGraceMs",cancelGraceMs);v.put("scriptTimeoutMs",scriptTimeoutMs);v.put("maxScriptTimeoutMs",maxScriptTimeoutMs);v.put("snapshotBytes",snapshotBytes);v.put("singleAttachmentBytes",singleAttachmentBytes);v.put("totalInputBytes",totalInputBytes);v.put("maxAssetChangeFiles",maxAssetChangeFiles);v.put("bodyPreviewBytes",bodyPreviewBytes);v.put("valuePreviewBytes",valuePreviewBytes);v.put("caseEvidenceBytes",caseEvidenceBytes);v.put("reportBytes",reportBytes);v.put("workflowMetadataBytes",workflowMetadataBytes);v.put("resultRetentionDays",resultRetentionDays);v.put("maxStressWorkers",maxStressWorkers);v.put("maxStressVus",maxStressVus);v.put("maxStressRequestConcurrency",maxStressRequestConcurrency);v.put("maxStressRps",maxStressRps);v.put("stressMetricMemoryBytes",stressMetricMemoryBytes);v.put("stressEvidenceMaxSamples",stressEvidenceMaxSamples);return v;}
    }
}
