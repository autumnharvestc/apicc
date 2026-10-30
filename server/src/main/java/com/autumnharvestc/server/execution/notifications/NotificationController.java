package com.autumnharvestc.server.execution.notifications;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}")
public class NotificationController {
    private final NotificationEventService events;
    private final NotificationChannelService channels;
    public NotificationController(NotificationEventService events,NotificationChannelService channels){this.events=events;this.channels=channels;}
    @GetMapping("/notifications") public NotificationDtos.Page list(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestParam(required=false)Integer limit,@RequestParam(required=false)String beforeId){return events.list(caller,ws,limit,beforeId);}
    @GetMapping("/projects/{project}/schedules/{schedule}/notification-history") public NotificationDtos.HistoryPage history(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String schedule,@RequestParam(required=false)Integer limit,@RequestParam(required=false)String beforeId,@RequestParam(required=false)String sourceBeforeId){return events.history(caller,ws,project,schedule,limit,beforeId,sourceBeforeId);}
    @PostMapping("/notifications/{event}/read") public java.util.Map<String,Object> read(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String event){return events.read(caller,ws,event);}
    @PostMapping("/notification-channels") @ResponseStatus(org.springframework.http.HttpStatus.CREATED) public Object createChannel(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestBody com.fasterxml.jackson.databind.JsonNode body){return channels.create(caller,ws,com.autumnharvestc.server.execution.ExecutionDtos.decode(body,NotificationChannelService.Write.class));}
    @GetMapping("/notification-channels") public Object channels(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws){return channels.list(caller,ws);}
    @PutMapping("/notification-channels/{channel}") public Object updateChannel(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String channel,@RequestBody com.fasterxml.jackson.databind.JsonNode body){return channels.update(caller,ws,channel,com.autumnharvestc.server.execution.ExecutionDtos.decode(body,NotificationChannelService.Write.class));}
    @DeleteMapping("/notification-channels/{channel}") @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT) public void deleteChannel(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String channel,@RequestParam String expectedVersion){channels.delete(caller,ws,channel,expectedVersion);}
}
