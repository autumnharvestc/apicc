package com.autumnharvestc.server.collaboration.grants;

import com.autumnharvestc.server.core.ApiException;
import org.springframework.http.HttpStatus;

public final class ShareInactive extends ApiException {
    private final String reason;
    public ShareInactive(String reason){super(HttpStatus.GONE,"share_inactive","共享授权已失效，需要有权成员重新创建授权");this.reason=reason;}
    public String reason(){return reason;}
}
