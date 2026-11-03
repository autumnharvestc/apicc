package com.autumnharvestc.server.collaboration.grants;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/collaboration")
public class GrantController {
    private final GrantService grants;
    public GrantController(GrantService grants){this.grants=grants;}
    @GetMapping("/publications/{id}/grants")
    public Object list(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestParam java.util.Map<String,String> query){return grants.list(actor,ws,project,id,query);}
    @GetMapping("/grants/{id}")
    public Object read(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String id){return grants.read(actor,ws,project,id);}
    @PostMapping("/grants/{id}/rotate")
    public ResponseEntity<?> rotate(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestBody JsonNode body){var result=grants.rotate(actor,ws,project,id,body);return ResponseEntity.status(result.replay()?200:201).body(result.value());}
    @DeleteMapping("/grants/{id}")
    public ResponseEntity<Void> revoke(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestBody JsonNode body){grants.revoke(actor,ws,project,id,body);return ResponseEntity.noContent().build();}
    @GetMapping("/grant-operations/{intent}")
    public Object operation(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String intent){return grants.operation(actor,ws,project,intent);}
    @PostMapping("/publications/{id}/grants")
    public ResponseEntity<?> create(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,
            @PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestBody JsonNode body) {
        var result=grants.create(actor,ws,project,id,body);
        return ResponseEntity.status(result.replay()?200:201).body(result.value());
    }
}
