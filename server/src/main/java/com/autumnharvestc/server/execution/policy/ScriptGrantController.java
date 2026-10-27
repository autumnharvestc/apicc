package com.autumnharvestc.server.execution.policy;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import java.util.*;
import static com.autumnharvestc.server.execution.ExecutionDtos.decode;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/script-grants")
public class ScriptGrantController {
    public record Update(String agentId,String expectedVersion,String scope,List<ScriptGrantService.ScriptRequirement> scripts,boolean riskConfirmed) {}
    private final ScriptGrantService grants;
    public ScriptGrantController(ScriptGrantService grants){this.grants=grants;}
    @GetMapping public Map<String,Object> get(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestParam String agentId){return grants.get(caller,ws,project,agentId);}
    @PutMapping public Map<String,Object> put(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode body){var update=decode(body,Update.class);grants.replace(caller,ws,project,update.agentId(),update.expectedVersion(),update.scope(),update.scripts(),update.riskConfirmed());return grants.get(caller,ws,project,update.agentId());}
}
