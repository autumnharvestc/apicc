package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.springframework.stereotype.Component;

/** Explicit fixture payload builders; no HTTP filter, product fallback, or request interception. */
@Component
public class AccessFixtureRevisions {
    private final AccessRepo access;
    private final AclRepo acl;
    private final MembershipRepo memberships;
    private final UserRepo users;
    private final ObjectMapper json;
    public AccessFixtureRevisions(AccessRepo access,AclRepo acl,MembershipRepo memberships,UserRepo users,ObjectMapper json) {
        this.access=access;this.acl=acl;this.memberships=memberships;this.users=users;this.json=json;
    }
    public long member(String ws,String user){return access.memberRevision(Long.valueOf(ws),Long.valueOf(user));}
    public long acl(String ws,String project,String user){return acl.revision(Long.valueOf(ws),Long.valueOf(project),Long.valueOf(user));}
    public Map<String,Object> memberFields(String ws,String user,String role) {
        var fields=new LinkedHashMap<String,Object>();fields.put("role",role);fields.put("expectedRevision",member(ws,user));
        if(role.equals("OWNER")) {
            Long owner=memberships.listMembers(Long.valueOf(ws)).stream().filter(m->m.role()==Role.OWNER).findFirst().orElseThrow().userId();
            fields.put("expectedActorRevision",access.memberRevision(Long.valueOf(ws),owner));
        }
        return fields;
    }
    public String memberBody(String ws,String user,String role)throws JsonProcessingException{return json.writeValueAsString(memberFields(ws,user,role));}
    public String aclBody(String ws,String project,String user,String role)throws JsonProcessingException {
        return json.writeValueAsString(Map.of("userId",user,"role",role,"expectedRevision",acl(ws,project,user)));
    }
    public String accountBody(String user)throws JsonProcessingException {
        return json.writeValueAsString(Map.of("expectedRevision",users.stateRevision(Long.valueOf(user))));
    }
    public String adminRoleBody(String ws,String user,String role)throws JsonProcessingException {
        return json.writeValueAsString(Map.of("workspaceId",ws,"role",role,"expectedRevision",member(ws,user)));
    }
}
