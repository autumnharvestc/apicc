package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync")
public class SyncApplicationController {
    private final SyncApplicationService applications;private final SyncOperationService operations;
    public SyncApplicationController(SyncApplicationService applications,SyncOperationService operations){this.applications=applications;this.operations=operations;}
    @PostMapping("/applications") public JsonNode apply(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return applications.apply(actor,ws,project,input);}
    @PostMapping("/rollbacks") public JsonNode rollback(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return applications.rollback(actor,ws,project,input);}
    @GetMapping("/operations/{intent}") public JsonNode operation(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String intent){return operations.read(actor,ws,project,intent);}
}
