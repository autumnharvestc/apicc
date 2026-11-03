package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.AclRole;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.workspace.SetAclRequest;
import com.autumnharvestc.server.workspace.SetMemberRoleRequest;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Set;
import org.springframework.http.HttpStatus;

/** Strict access control fields, decoded only after the relevant authority/scope check. */
public final class AccessRequests {
    private AccessRequests() {}
    public static final long MAX_REVISION = 9007199254740991L;

    public static SetMemberRoleRequest member(JsonNode body) {
        fields(body, Set.of("role", "expectedRevision", "expectedActorRevision"));
        Role role=role(body,"role",Role.class);
        if(body.has("expectedActorRevision")&&role!=Role.OWNER)throw invalid("expectedActorRevision 仅用于工作区 OWNER 转让");
        return new SetMemberRoleRequest(role, revision(body.get("expectedRevision")), body.get("expectedActorRevision"));
    }

    public static SetAclRequest acl(JsonNode body) {
        fields(body, Set.of("userId", "role", "expectedRevision"));
        return new SetAclRequest(text(body, "userId"), role(body, "role", AclRole.class), revision(body.get("expectedRevision")));
    }

    public record PolicyUpdate(long expectedRevision, java.util.Map<String,String> defaults) {}
    public record MemberUpdate(long expectedRevision, String action, String role, java.util.Map<String,String> capabilities,
                               JsonNode expectedActorRevision) {}

    public static PolicyUpdate policy(JsonNode body) {
        fields(body, Set.of("expectedRevision", "defaults"));
        var modes = modes(body.get("defaults"));
        if (modes.isEmpty()) throw invalid("defaults 不能为空");
        return new PolicyUpdate(revision(body.get("expectedRevision")), modes);
    }

    public static MemberUpdate managedMember(JsonNode body, boolean project) {
        fields(body, Set.of("expectedRevision", "action", "role", "capabilities", "expectedActorRevision"));
        long expected = revision(body.get("expectedRevision"));
        String action = body.has("action") ? text(body, "action") : "update";
        if (!Set.of("update", "confirm-override", "confirm-inheritance").contains(action)) throw invalid("action 值无效");
        if (!project && !action.equals("update")) throw invalid("工作区不支持项目确认动作");
        String role = body.has("role") ? (project ? role(body,"role",AclRole.class).name() : role(body,"role",Role.class).name()) : null;
        if(body.has("expectedActorRevision")&&(project||!"OWNER".equals(role)))throw invalid("expectedActorRevision 仅用于工作区 OWNER 转让");
        if (action.equals("confirm-override") && role == null) throw invalid("confirm-override 需要明确 role");
        if (action.equals("confirm-inheritance") && role != null) throw invalid("confirm-inheritance 不接受 role");
        var capabilities = body.has("capabilities") ? modes(body.get("capabilities")) : java.util.Map.<String,String>of();
        if (role == null && capabilities.isEmpty() && !action.equals("confirm-inheritance")) throw invalid("变更不能为空");
        return new MemberUpdate(expected, action, role, capabilities, body.get("expectedActorRevision"));
    }

    private static java.util.Map<String,String> modes(JsonNode value) {
        if (value == null || !value.isObject()) throw invalid("能力配置必须是对象");
        var result = new java.util.LinkedHashMap<String,String>();
        value.properties().forEach(entry -> {
            if (java.util.Arrays.stream(Capability.values()).noneMatch(c -> c.code().equals(entry.getKey()))) throw invalid("未知能力: " + entry.getKey());
            if (!entry.getValue().isTextual() || !Set.of("inherit", "allow", "deny").contains(entry.getValue().textValue())) throw invalid("能力模式无效");
            result.put(entry.getKey(), entry.getValue().textValue());
        });
        return java.util.Map.copyOf(result);
    }

    public static long revision(JsonNode input) {
        if (input == null || !input.isIntegralNumber() || !input.canConvertToLong()
                || input.longValue() < 0 || input.longValue() > MAX_REVISION) {
            throw invalid("expectedRevision 必须是非负安全整数");
        }
        return input.longValue();
    }

    public static long actorRevision(JsonNode input) {
        try{return revision(input);}catch(ApiException ex){throw invalid("expectedActorRevision 必须是非负安全整数");}
    }
    public record AdminRoleUpdate(String workspaceId,String role,long expectedRevision) {}
    public static AdminRoleUpdate adminRole(JsonNode body) {
        fields(body,Set.of("workspaceId","role","expectedRevision"));
        String role=text(body,"role");
        if(!Set.of("ADMIN","EDITOR","VIEWER").contains(role))throw invalid("role 值无效");
        return new AdminRoleUpdate(text(body,"workspaceId"),role,revision(body.get("expectedRevision")));
    }
    public static long accountState(JsonNode body) {
        fields(body,Set.of("expectedRevision"));return revision(body.get("expectedRevision"));
    }

    public static long queryRevision(String input) {
        if (input == null) throw invalid("expectedRevision 不能为空");
        try { return revision(com.fasterxml.jackson.databind.node.BigIntegerNode.valueOf(new java.math.BigInteger(input))); }
        catch (NumberFormatException ex) { throw invalid("expectedRevision 必须是非负安全整数"); }
    }

    public static void fields(JsonNode body, Set<String> allowed) {
        if (body == null || !body.isObject()) throw invalid("请求载荷必须是对象");
        body.fieldNames().forEachRemaining(name -> {
            if (!allowed.contains(name)) throw invalid("未知控制字段: " + name);
        });
    }

    private static String text(JsonNode body, String field) {
        JsonNode value = body.get(field);
        if (value == null || !value.isTextual() || value.textValue().isBlank()) throw invalid(field + " 不能为空且必须为字符串");
        return value.textValue();
    }

    private static <T extends Enum<T>> T role(JsonNode body, String field, Class<T> type) {
        try { return Enum.valueOf(type, text(body, field)); }
        catch (IllegalArgumentException ex) { throw invalid(field + " 值无效"); }
    }

    public static ApiException invalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", message);
    }
}
