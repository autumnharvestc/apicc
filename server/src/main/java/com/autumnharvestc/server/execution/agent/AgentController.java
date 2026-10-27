package com.autumnharvestc.server.execution.agent;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.autumnharvestc.server.execution.ExecutionDtos.decode;

@RestController
@RequestMapping("/api/v1")
public class AgentController {
    private final AgentService agents;
    private final ExecutionConfigService configs;
    private final ProjectExecutionView projectView;
    public AgentController(AgentService agents,ExecutionConfigService configs,ProjectExecutionView projectView){this.agents=agents;this.configs=configs;this.projectView=projectView;}
    @GetMapping("/workspaces/{ws}/projects/{project}/execution-agents") public Map<String,Object> executionAgents(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return projectView.read(caller,ws,project);}
    private Map<String,Object> view(AgentRepo.Agent agent){return Map.of("id",String.valueOf(agent.id()),"name",agent.name(),"acceptingJobs",agent.acceptingJobs(),"revoked",agent.revoked());}
    @GetMapping("/agents") public List<Map<String,Object>> list(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller){return agents.list(caller).stream().map(this::view).toList();}
    @GetMapping("/agents/workspace-directory") public List<Map<String,Object>> workspaceDirectory(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller){return agents.workspaceDirectory(caller);}
    @PostMapping("/agents") @ResponseStatus(HttpStatus.CREATED) public Map<String,Object> create(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@RequestBody JsonNode body){return view(agents.create(caller,decode(body,AgentCreate.class).name()));}
    @GetMapping("/agents/{id}") public Map<String,Object> agent(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id){var node=agents.get(caller,id);var result=new LinkedHashMap<>(view(node));result.putAll(configs.agent(caller,id));result.putAll(projectView.runtimeFacts(node));return result;}
    @PatchMapping("/agents/{id}") @Transactional public Map<String,Object> patch(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id,@RequestBody JsonNode body){var update=decode(body,AgentPatch.class);agents.patch(caller,id,update.name(),update.acceptingJobs());if(update.policy()!=null)configs.saveAgentPolicy(caller,id,update.expectedPolicyVersion(),update.policy());if(update.config()!=null)configs.saveAgent(caller,id,update.expectedVersion(),update.config());return agent(caller,id);}
    @PostMapping("/agents/{id}/revoke") public void revoke(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id){agents.revoke(caller,id);}
    @PostMapping("/agents/{id}/enrollments") @ResponseStatus(HttpStatus.CREATED) public Map<String,Object> enrollment(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id){return agents.issueEnrollment(caller,id);}
    @GetMapping("/agents/{id}/workspace-grants") public Map<String,Object> grants(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id){return Map.of("workspaceIds",agents.workspaceGrants(caller,id));}
    @PutMapping("/agents/{id}/workspace-grants") public void grants(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String id,@RequestBody JsonNode body){agents.grantWorkspaces(caller,id,decode(body,WorkspaceGrants.class).workspaceIds());}
    @GetMapping("/workspaces/{ws}/available-agents") public List<Map<String,Object>> available(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws){return agents.available(caller,ws).stream().map(this::view).toList();}
    @GetMapping("/workspaces/{ws}/projects/{project}/agent-candidates") public List<Map<String,Object>> candidates(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return agents.candidates(caller,ws,project).stream().map(this::view).toList();}
    @GetMapping("/workspaces/{ws}/agent-project-allocations") public Map<String,Object> allocations(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestParam String agentId){return Map.of("agentId",agentId,"projectIds",agents.allocations(caller,ws,agentId));}
    @PutMapping("/workspaces/{ws}/agent-project-allocations") public void allocate(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestBody JsonNode body){var allocation=decode(body,ProjectAllocation.class);agents.allocate(caller,ws,allocation.agentId(),allocation.projectIds());}
    @GetMapping("/workspaces/{ws}/projects/{project}/execution-settings") public Map<String,Object> settings(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){var result=new LinkedHashMap<>(agents.associations(caller,ws,project));result.putAll(configs.project(caller,ws,project,null));return result;}
    @PutMapping("/workspaces/{ws}/projects/{project}/execution-settings") @Transactional public Map<String,Object> settings(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode body){var update=decode(body,ProjectExecutionSettings.class);configs.saveProject(caller,ws,project,update.expectedVersion(),update.policy()==null?Map.of():update.policy());if(update.agentIds()!=null)agents.associate(caller,ws,project,update.agentIds(),update.defaultAgentId());return settings(caller,ws,project);}
    @GetMapping("/workspaces/{ws}/execution-settings") public Map<String,Object> workspace(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws){return configs.workspace(caller,ws);}
    @PutMapping("/workspaces/{ws}/execution-settings") public Map<String,Object> workspace(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestBody JsonNode body){var update=decode(body,PolicyUpdate.class);return configs.saveWorkspace(caller,ws,update.expectedVersion(),update.policy());}
    @PostMapping("/runner/enroll") @ResponseStatus(HttpStatus.CREATED) public Map<String,Object> enroll(@RequestBody JsonNode body){return agents.enroll(decode(body,EnrollmentRequest.class).enrollmentToken());}
}
