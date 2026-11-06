package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync/sources/{source}/schedule")
public class SyncScheduleController {
    private final SyncScheduleService service;
    public SyncScheduleController(SyncScheduleService service){this.service=service;}
    @GetMapping public JsonNode read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source){return service.read(actor,ws,project,source);}
    @PutMapping public JsonNode save(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source,@RequestBody JsonNode request){return service.save(actor,ws,project,source,request);}
    @PostMapping("/preview") public JsonNode preview(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source,@RequestBody JsonNode request){return service.preview(actor,ws,project,source,request);}
}
