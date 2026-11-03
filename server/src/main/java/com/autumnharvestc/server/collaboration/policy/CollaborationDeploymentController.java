package com.autumnharvestc.server.collaboration.policy;

import org.springframework.web.bind.annotation.*;
import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.admin.AdminService;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProperties;
import com.autumnharvestc.server.collaboration.publicapi.*;
import java.util.List;

/** Deployment facts only: no private endpoint, secret path, RPC, transaction or writable settings. */
@RestController
public class CollaborationDeploymentController {
    private final AdminService authority;
    private final RuntimeProperties runtime;
    private final PublicAccessProperties publicSettings;
    private final PublicListener listener;
    private final PublicAdmissionState admission;
    private final org.springframework.core.env.Environment environment;
    private final DeploymentPolicyProperties deploymentPolicy;
    public CollaborationDeploymentController(AdminService authority,RuntimeProperties runtime,PublicAccessProperties publicSettings,PublicListener listener,PublicAdmissionState admission,org.springframework.core.env.Environment environment,DeploymentPolicyProperties deploymentPolicy){
        this.authority=authority;this.runtime=runtime;this.publicSettings=publicSettings;this.listener=listener;this.admission=admission;this.environment=environment;this.deploymentPolicy=deploymentPolicy;
    }
    public record Runtime(boolean enabled,boolean endpointConfigured,boolean secretConfigured,int expectedProtocolVersion,String health) {}
    public record PublicAccess(boolean enabled,String bindAddress,int port,String baseUrl,String managementBaseUrl,boolean originConfigured,String originStatus,String managementOriginStatus,Integer boundPort,boolean startupReconciled) {}
    public record Field(String code,String defaultValue,Long minimum,Long maximum,String unit,String constraint,String source,String effect) {}
    public record Resource(String code,Number defaultValue,Number value,Number minimum,Number maximum,String unit,String source,String effect,String constraint) {}
    public record View(Runtime runtime,PublicAccess publicAccess,List<Field> fields,List<Resource> resources,String resourceConstraint) {}
    private static Field field(String code,String value,Long min,Long max,String unit,String constraint){return new Field(code,value,min,max,unit,constraint,"deployment","restart-required");}
    @GetMapping("/api/v1/admin/collaboration/deployment")
    public View read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor){
        authority.requireCollaborationPolicyManagement(actor);
        boolean origin=publicSettings.savedOriginsValid(environment.getProperty("local.server.port",Integer.class,environment.getProperty("server.port",Integer.class,8080)));
        String safeManagement=PublicAccessProperties.safeSavedOrigin(publicSettings.getManagementBaseUrl());
        String originStatus=origin?"valid":publicSettings.getBaseUrl().isBlank()?"unconfigured":"invalid-origin-or-separation";
        String managementStatus=publicSettings.getManagementBaseUrl().isBlank()?"unconfigured":safeManagement==null?"invalid-origin":"valid";
        boolean endpoint=!runtime.getBaseUrl().isBlank(),secret=!runtime.getSecretFile().isBlank();
        String health=!runtime.isEnabled()?"disabled":endpoint&&secret?"unchecked":"unconfigured";
        return new View(new Runtime(runtime.isEnabled(),endpoint,secret,1,health),
            new PublicAccess(publicSettings.isEnabled(),publicSettings.getBindAddress(),publicSettings.getPort(),origin?publicSettings.getBaseUrl():null,origin?safeManagement:null,origin,originStatus,managementStatus,listener.boundPort(),admission.ready()),List.of(
                field("runtime.enabled","false",null,null,"boolean","explicit-enable"),
                field("runtime.endpoint","",null,null,"origin","fixed-http-https-private-endpoint"),
                field("runtime.authentication","",null,null,"status","secret-file-no-disclosure"),
                field("runtime.expectedProtocolVersion","1",1L,1L,"version","local-expectation"),
                field("runtime.privateNetwork","",null,null,"status","deployment-network-isolation"),
                field("public.enabled","false",null,null,"boolean","explicit-enable"),
                field("public.bindAddress","127.0.0.1",null,null,"address","public-bind"),
                field("public.port","0",0L,65535L,"port","zero-ephemeral-port"),
                field("public.baseUrl","",null,null,"origin","public-origin-separation"),
                field("public.managementBaseUrl","",null,null,"origin","management-origin-separation")
            ),resources(),"heap-cache-inflight-headroom-within-total");
    }
    private List<Resource> resources(){
        var snapshot=deploymentPolicy.capture(runtime);var view=snapshot.resources();var ranges=view.recommendations();
        var cache=(PolicyReadView.IntegerSetting)snapshot.settings().stream().filter(row->row.code()==PolicyReadView.Code.NODE_CACHE_BYTES).findFirst().orElseThrow();
        return List.of(
            new Resource("externalLimits.cpuVcpu",null,view.externalLimits().cpuVcpu().value(),ranges.cpuVcpu().minimum(),ranges.cpuVcpu().maximum(),"vCPU","deployment","external-enforcement","external-enforcement-unverified"),
            new Resource("externalLimits.totalMemoryBytes",null,view.externalLimits().totalMemoryBytes().value(),ranges.totalMemoryBytes().minimum(),ranges.totalMemoryBytes().maximum(),"bytes","deployment","external-enforcement","external-enforcement-unverified"),
            new Resource("applicationSettings.nodeHeapBytes",null,view.applicationSettings().nodeHeapBytes().value(),ranges.nodeHeapBytes().minimum(),ranges.nodeHeapBytes().maximum(),"bytes","deployment","deployment-configuration","heap-not-rss"),
            new Resource("applicationSettings.inFlightBytes",null,view.applicationSettings().inFlightBytes().value(),0L,null,"bytes","deployment","deployment-configuration","complete-total-memory-budget"),
            new Resource("applicationSettings.headroomBytes",null,view.applicationSettings().headroomBytes().value(),0L,null,"bytes","deployment","deployment-configuration","complete-total-memory-budget"),
            new Resource("nodeCacheBytes",cache.builtin(),cache.effective(),cache.minimum(),cache.maximum(),"bytes",cache.source().code(),cache.effect().code(),"complete-total-memory-budget")
        );
    }
}
