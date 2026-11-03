package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.AclRole;
import com.autumnharvestc.server.core.Role;
import java.util.Optional;
import java.util.Set;

public record ProjectAccessView(
        boolean accountEnabled, boolean member, Optional<Role> workspaceRole,
        Optional<AclRole> projectOverride, String overrideState, Optional<Role> effectiveRole,
        Set<Capability> capabilities, long accessRevision, long membershipEpoch,
        long responsibilityEpoch, String reasonCode) {
}
