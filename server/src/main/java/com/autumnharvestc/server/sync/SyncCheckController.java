package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.auth.AuthFilter;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync")
public class SyncCheckController {
    private final SyncCheckService service;
    public SyncCheckController(SyncCheckService service){this.service=service;}
    @PostMapping("/sources/{source}/checks") @ResponseStatus(HttpStatus.ACCEPTED) public JsonNode start(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source,@RequestBody JsonNode input){return service.start(actor,ws,project,source,input);}
    @GetMapping("/checks/{check}") public JsonNode read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String check){return service.read(actor,ws,project,check);}
    @GetMapping("/checks") public JsonNode lookup(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@RequestParam String sourceId){return service.lookup(actor,ws,project,sourceId);}
    @PostMapping("/checks/{check}/cancel") @ResponseStatus(HttpStatus.ACCEPTED) public JsonNode cancel(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String check,@RequestBody JsonNode input){return service.cancel(actor,ws,project,check,input);}
}
