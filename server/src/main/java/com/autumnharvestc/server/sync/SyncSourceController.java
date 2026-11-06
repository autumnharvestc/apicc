package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.auth.AuthFilter;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import java.util.List;
@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync/sources")
public class SyncSourceController {
    private final SyncSourceService service;
    public SyncSourceController(SyncSourceService service){this.service=service;}
    @GetMapping public List<JsonNode> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project){return service.list(actor,ws,project);}
    @GetMapping("/{source}") public JsonNode read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source){return service.read(actor,ws,project,source);}
    @PostMapping @ResponseStatus(HttpStatus.CREATED) public JsonNode create(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return service.save(actor,ws,project,null,input);}
    @PutMapping("/{source}") public JsonNode update(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String source,@RequestBody JsonNode input){return service.save(actor,ws,project,source,input);}
}
