package com.autumnharvestc.server.collaboration.policy;

import java.math.BigDecimal;
import java.util.List;
import java.math.BigInteger;
import com.autumnharvestc.server.core.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProperties;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;

/** Finite deployment policy, distinct from external enforcement and runtime health. */
@Component
@ConfigurationProperties(prefix="apicc.collaboration.policy")
public class DeploymentPolicyProperties {
    public record Defaults(
        Boolean externalSharingAllowed,Boolean historyPublishingAllowed,Boolean sharedMockAllowed,
        Long defaultShareDurationMs,Long maxShareDurationMs,Boolean externalDownloadAllowed,
        Long previewTtlMs,Long maxPreviewsPerPerson,Long maxPreviewsPerProject,Long publicationOperationTimeoutMs,
        Long maxSourceBytes,Long maxArtifactBytes,Boolean evidenceAllowed,Long maxFieldBytes,Long maxEvidenceBytes,
        Long maxProjectVersions,Long maxProjectStorageBytes,Long maxProjectActiveGrants,
        Long inactiveArtifactRetentionMs,Long memberUploadRetentionMs,Long maxMemberUploadRecords,Long defaultPageSize,Long maxPageSize,
        Long publicReadRps,Long publicReadInFlight,Long mockRps,Long mockInFlight,Long maxMockRequestBytes,Long maxMockResponseBytes,
        Long maxMockDelayMs,Long mockLogMaxEntries,Long mockLogRetentionMs,
        List<String> extraSensitiveHeaders,List<String> extraSensitiveQuery,List<String> extraSensitiveFields,List<String> extraSensitivePointers,List<String> corsAllowedOrigins,
        Long managementAuditRetentionMs,Long accessAuditRetentionMs,Long cleanupBatchSize,Long cleanupIntervalMs) {
        public Defaults { extraSensitiveHeaders=freeze(extraSensitiveHeaders);extraSensitiveQuery=freeze(extraSensitiveQuery);extraSensitiveFields=freeze(extraSensitiveFields);extraSensitivePointers=freeze(extraSensitivePointers);corsAllowedOrigins=freeze(corsAllowedOrigins); }
        PolicyOverrides overrides(){return new PolicyOverrides(externalSharingAllowed,historyPublishingAllowed,sharedMockAllowed,defaultShareDurationMs,maxShareDurationMs,externalDownloadAllowed,
            previewTtlMs,maxPreviewsPerPerson,maxPreviewsPerProject,publicationOperationTimeoutMs,maxSourceBytes,maxArtifactBytes,evidenceAllowed,maxFieldBytes,maxEvidenceBytes,
            maxProjectVersions,maxProjectStorageBytes,maxProjectActiveGrants,inactiveArtifactRetentionMs,memberUploadRetentionMs,maxMemberUploadRecords,defaultPageSize,maxPageSize,
            publicReadRps,publicReadInFlight,mockRps,mockInFlight,maxMockRequestBytes,maxMockResponseBytes,maxMockDelayMs,null,mockLogMaxEntries,mockLogRetentionMs,
            extraSensitiveHeaders,extraSensitiveQuery,extraSensitiveFields,extraSensitivePointers,corsAllowedOrigins,managementAuditRetentionMs,accessAuditRetentionMs,cleanupBatchSize,cleanupIntervalMs);}
    }
    public record Deployment(Long deploymentMaxStorageBytes,Long deploymentPublicReadRps,Long deploymentPublicReadInFlight,Long deploymentMockRps,Long deploymentMockInFlight,Long deploymentMaxActiveGrants,Long maxPreviewsGlobal,Long nodeCacheBytes) {
        Long value(Code code){return switch(code){case DEPLOYMENT_MAX_STORAGE_BYTES->deploymentMaxStorageBytes;case DEPLOYMENT_PUBLIC_READ_RPS->deploymentPublicReadRps;
            case DEPLOYMENT_PUBLIC_READ_IN_FLIGHT->deploymentPublicReadInFlight;case DEPLOYMENT_MOCK_RPS->deploymentMockRps;case DEPLOYMENT_MOCK_IN_FLIGHT->deploymentMockInFlight;
            case DEPLOYMENT_MAX_ACTIVE_GRANTS->deploymentMaxActiveGrants;case MAX_PREVIEWS_GLOBAL->maxPreviewsGlobal;case NODE_CACHE_BYTES->nodeCacheBytes;default->null;};}
    }
    public record ResourceSettings(BigDecimal cpuVcpu,Long totalMemoryBytes,Long nodeHeapBytes,Long inFlightBytes,Long headroomBytes) {}
    public record RpcQuotas(int connectTimeoutMs,int callTimeoutMs,int mockTimeoutMs,int maxWireBytes) {}
    public record Configuration(Defaults defaults,Deployment deployment,ResourceSettings resources,RpcQuotas rpc) {}
    public record Snapshot(List<Setting> settings,Resources resources,Configuration configuration) {
        public Snapshot {settings=List.copyOf(settings);}
    }
    private Defaults defaults;private Deployment deployment;private ResourceSettings resources;
    public Defaults getDefaults(){return defaults;}public void setDefaults(Defaults value){defaults=value;}
    public Deployment getDeployment(){return deployment;}public void setDeployment(Deployment value){deployment=value;}
    public ResourceSettings getResources(){return resources;}public void setResources(ResourceSettings value){resources=value;}
    private static List<String> freeze(List<String> values){return values==null?null:java.util.Collections.unmodifiableList(new java.util.ArrayList<>(values));}
    Snapshot capture(RuntimeProperties runtime) {
        var configuration=new Configuration(defaults,deployment,resources,new RpcQuotas(runtime.getConnectTimeoutMs(),runtime.getCallTimeoutMs(),runtime.getMockTimeoutMs(),runtime.getMaxWireBytes()));
        var settings=settings(configuration.defaults(),configuration.deployment(),configuration.rpc());
        try{PolicyValidation.requireValid(settings,Source.DEPLOYMENT);}catch(PolicyValidation.Invalid invalid){throw invalidConfiguration(invalid.field.code());}
        var display=resources(configuration.resources());requireResources(display,settings);
        return new Snapshot(settings,display,configuration);
    }
    private static List<Setting> settings(Defaults defaults,Deployment deployment,RpcQuotas runtime) {
        var base=defaults==null?PolicyDefaults.settings():defaults.overrides().view(PolicyDefaults.settings(),Source.DEPLOYMENT);
        return base.stream().map(item->{
            if(item instanceof BooleanSetting value)return (Setting)new BooleanSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect());
            if(item instanceof StringListSetting value)return (Setting)new StringListSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect(),value.maxItems(),value.maxItemCodePoints());
            if(item instanceof IntegerSetting value){
                Long configured=deployment==null?null:deployment.value(value.code());
                Long rpc=switch(value.code()){case RPC_CONNECT_TIMEOUT_MS->(long)runtime.connectTimeoutMs();case RPC_CALL_TIMEOUT_MS->(long)runtime.callTimeoutMs();case RPC_MAX_MESSAGE_BYTES->(long)runtime.maxWireBytes();case MOCK_CALL_TIMEOUT_MS->(long)runtime.mockTimeoutMs();default->null;};
                if(rpc!=null&&!rpc.equals(value.builtin()))configured=rpc;
                return (Setting)new IntegerSetting(value.code(),value.builtin(),null,configured==null?value.effective():configured,configured==null?value.source():Source.DEPLOYMENT,value.unit(),value.effect(),value.minimum(),value.maximum());
            }
            return item;
        }).toList();
    }
    private static Resources resources(ResourceSettings resources) {
        var current=resources==null?new ResourceSettings(null,null,null,null,null):resources;
        return new Resources(PolicyDefaults.resources().recommendations(),new ExternalLimits(decimal(current.cpuVcpu()),bytes(current.totalMemoryBytes())),
            new ApplicationSettings(bytes(current.nodeHeapBytes()),bytes(current.inFlightBytes()),bytes(current.headroomBytes())));
    }
    private static ConfiguredBytes bytes(Long value){return new ConfiguredBytes(value,value==null?ConfigurationStatus.UNCONFIGURED:ConfigurationStatus.CONFIGURED,Unit.BYTES);}
    private static ConfiguredDecimal decimal(BigDecimal value){return new ConfiguredDecimal(value,value==null?ConfigurationStatus.UNCONFIGURED:ConfigurationStatus.CONFIGURED,Unit.VCPU);}
    private static void requireResources(Resources view,List<Setting> settings) {
        var recommendation=view.recommendations();var cpu=view.externalLimits().cpuVcpu().value();
        if(cpu!=null&&(cpu.compareTo(recommendation.cpuVcpu().minimum())<0||cpu.compareTo(recommendation.cpuVcpu().maximum())>0))throw invalidConfiguration("cpuVcpu");
        var memory=view.externalLimits().totalMemoryBytes().value();var heap=view.applicationSettings().nodeHeapBytes().value();
        requireBytes(memory,recommendation.totalMemoryBytes(),"totalMemoryBytes");requireBytes(heap,recommendation.nodeHeapBytes(),"nodeHeapBytes");
        var flight=view.applicationSettings().inFlightBytes().value();var headroom=view.applicationSettings().headroomBytes().value();
        if(flight!=null&&flight<0)throw invalidConfiguration("inFlightBytes");if(headroom!=null&&headroom<0)throw invalidConfiguration("headroomBytes");
        if(memory!=null&&heap!=null&&flight!=null&&headroom!=null){
            long cache=((IntegerSetting)settings.stream().filter(item->item.code()==Code.NODE_CACHE_BYTES).findFirst().orElseThrow()).effective();
            var required=BigInteger.valueOf(heap).add(BigInteger.valueOf(cache)).add(BigInteger.valueOf(flight)).add(BigInteger.valueOf(headroom));
            if(required.compareTo(BigInteger.valueOf(memory))>0)throw invalidConfiguration("totalMemoryBytes");
        }
    }
    private static void requireBytes(Long value,RecommendedBytes range,String field){if(value!=null&&(value<range.minimum()||value>range.maximum()))throw invalidConfiguration(field);}
    private static ApiException invalidConfiguration(String field){return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,"collaboration_policy_configuration_invalid","协作部署配置不合法（来源：deployment）："+field+"；请核对范围、单位及完整预算");}
}
