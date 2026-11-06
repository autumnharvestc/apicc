package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync")
public class SyncHistoryController {
    private final SyncHistoryService history;
    public SyncHistoryController(SyncHistoryService history){this.history=history;}
    @GetMapping("/history") public JsonNode list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project){return history.list(actor,ws,project);}
}
